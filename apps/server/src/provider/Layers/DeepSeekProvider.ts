import {
  type DeepSeekSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  DEEPSEEK_DEFAULT_MODEL_SLUG,
  isValidDeepSeekReasoningEffortToken,
  makeDeepSeekAcpRuntime,
  resolveDeepSeekAcpBaseModelId,
} from "../acp/DeepSeekAcpSupport.ts";
import { sessionModelStateFromInitialize } from "../acp/AcpRuntimeModel.ts";

const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `initialize` is a single local round trip, so this is generous even on slow machines.
const DEEPSEEK_ACP_INITIALIZE_TIMEOUT_MS = 8_000;
const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

// dsh advertises these routes through the session `model` config option
// (`["deepseek-official","<model>"]`); T3 ships the friendly model element as
// the picker slug and the adapter resolves it per session.
const DEEPSEEK_REASONING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        {
          id: "off",
          label: "Off",
          description: "Use for simple tasks that do not need reasoning.",
        },
        {
          id: "low",
          label: "Low",
          description: "Prefer for routine or latency-sensitive tasks.",
        },
        {
          id: "high",
          label: "High",
          description: "The default balance for most tasks.",
          isDefault: true,
        },
        {
          id: "max",
          label: "Max",
          description: "Reserve for the hardest quality-first tasks.",
        },
      ],
      currentValue: "high",
    },
  ],
});

const DEEPSEEK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEEPSEEK_DEFAULT_MODEL_SLUG,
    name: "DeepSeek V4 Flash",
    isCustom: false,
    isDefault: true,
    capabilities: DEEPSEEK_REASONING_CAPABILITIES,
  },
  {
    slug: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    isCustom: false,
    capabilities: DEEPSEEK_REASONING_CAPABILITIES,
  },
  {
    slug: "deepseek-flash",
    name: "DeepSeek V41 Flash",
    isCustom: false,
    capabilities: DEEPSEEK_REASONING_CAPABILITIES,
  },
  {
    slug: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision",
    isCustom: false,
    capabilities: DEEPSEEK_REASONING_CAPABILITIES,
  },
];

export function buildInitialDeepSeekProviderSnapshot(
  deepseekSettings: DeepSeekSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = deepseekModelsFromSettings(deepseekSettings.customModels);

    if (!deepseekSettings.enabled) {
      return buildServerProvider({
        presentation: DEEPSEEK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "DeepSeek is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking DeepSeek harness availability...",
      },
    });
  });
}

function deepseekModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEEPSEEK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepseekReasoningOptionsFromModel(model: EffectAcpSchema.ModelInfo): {
  readonly options: ReadonlyArray<{
    value: string;
    label: string;
    description?: string;
    isDefault?: boolean;
  }>;
  readonly currentValue: string | undefined;
} {
  const meta = model._meta;
  if (!meta || meta.supportsReasoningEffort === false) {
    return { options: [], currentValue: undefined };
  }

  const currentEffort = nonEmptyString(meta.reasoningEffort);
  const advertisedOptions = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : [];
  const seen = new Set<string>();
  const options: Array<{
    value: string;
    label: string;
    description?: string;
    advertisedDefault: boolean;
  }> = [];

  for (const entry of advertisedOptions) {
    if (!isRecord(entry)) {
      continue;
    }
    const rawValue = nonEmptyString(entry.value);
    const rawId = nonEmptyString(entry.id);
    const value =
      rawValue && isValidDeepSeekReasoningEffortToken(rawValue)
        ? rawValue
        : rawId && isValidDeepSeekReasoningEffortToken(rawId)
          ? rawId
          : undefined;
    if (value === undefined || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const description = nonEmptyString(entry.description);
    options.push({
      value,
      label: nonEmptyString(entry.label) ?? value,
      ...(description ? { description } : {}),
      advertisedDefault: entry.default === true || entry.isDefault === true,
    });
  }

  const currentValue =
    currentEffort && options.some((option) => option.value === currentEffort)
      ? currentEffort
      : undefined;
  const advertisedDefaults = options.filter((option) => option.advertisedDefault);
  const selectedDefault =
    advertisedDefaults.find((option) => option.value === currentValue)?.value ??
    advertisedDefaults[0]?.value;
  return {
    options: options.map(({ value, label, description }) => ({
      value,
      label,
      ...(description ? { description } : {}),
      ...(value === selectedDefault ? { isDefault: true } : {}),
    })),
    currentValue: currentValue ?? selectedDefault,
  };
}

export function buildDeepSeekModelCapabilities(
  model: EffectAcpSchema.ModelInfo,
): ModelCapabilities {
  const reasoning = deepseekReasoningOptionsFromModel(model);
  return reasoning.options.length > 0
    ? createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: reasoning.options.map((option) => ({
              id: option.value,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
              ...(option.isDefault ? { isDefault: true } : {}),
            })),
            ...(reasoning.currentValue ? { currentValue: reasoning.currentValue } : {}),
          },
        ],
      })
    : EMPTY_CAPABILITIES;
}

/** Models advertised by the ACP agent, with the session's current model marked as default. */
export function buildDeepSeekModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const currentModelId = modelState.currentModelId.trim();
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    const slug = resolveDeepSeekAcpBaseModelId(model.modelId);
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(model.modelId.trim() === currentModelId ? { isDefault: true } : {}),
        capabilities: buildDeepSeekModelCapabilities(model),
      },
    ];
  });
}

export interface DeepSeekModelsCliOutput {
  /** True or false when the CLI printed a login line, null when it printed neither. */
  readonly authenticated: boolean | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

/**
 * Best-effort parse of `dsh models`, when the installed harness supports it.
 * The command is expected to exit 0 whether or not the user is logged in, so
 * the text is the only signal. A missing subcommand (or any other failure)
 * yields no output and the caller falls back to ACP discovery, so this never
 * fails a health check on its own.
 */
export function parseDeepSeekModelsCliOutput(output: string): DeepSeekModelsCliOutput {
  const authenticated = /you are logged in/i.test(output)
    ? true
    : /not authenticated|not logged in/i.test(output)
      ? false
      : null;

  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const bullet = line.match(/^\s*[*-]\s+(\S+)(.*)$/);
    if (!bullet?.[1]) {
      continue;
    }
    const slug = resolveDeepSeekAcpBaseModelId(bullet[1]);
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: displayNameFromDeepSeekModelSlug(slug),
      isCustom: false,
      ...(/\(default\)/i.test(bullet[2] ?? "") ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return { authenticated, models };
}

function displayNameFromDeepSeekModelSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .map((part) => (part.toLowerCase() === "deepseek" ? "DeepSeek" : part))
    .join(" ");
}

const runDeepSeekCliCommand = (
  deepseekSettings: DeepSeekSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = deepseekSettings.binaryPath || "dsh";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Reads model metadata from `initialize._meta.modelState`. This never calls `authenticate`
 * or `session/new`, so it cannot open a browser login or boot the workspace's MCP servers.
 */
const discoverDeepSeekModelsViaAcpInitialize = (
  deepseekSettings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDeepSeekAcpRuntime({
      deepseekSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    return buildDeepSeekModelsFromSessionModelState(sessionModelStateFromInitialize(initialized));
  }).pipe(Effect.scoped);

export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(function* (
  deepseekSettings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = deepseekModelsFromSettings(deepseekSettings.customModels);

  if (!deepseekSettings.enabled) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "DeepSeek is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDeepSeekCliCommand(
    deepseekSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("DeepSeek harness health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepseekSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "DeepSeek harness CLI (`dsh`) is not installed or not on PATH."
          : "Failed to execute DeepSeek harness health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepseekSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "DeepSeek harness CLI is installed but timed out while running `dsh --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("DeepSeek harness version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepseekSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "DeepSeek harness CLI is installed but failed to run.",
      },
    });
  }

  // Best-effort `dsh models` login/model probe. Not all harness versions ship
  // this subcommand; a missing or failing invocation only logs and falls back
  // to ACP discovery below.
  const modelsResult = yield* runDeepSeekCliCommand(deepseekSettings, ["models"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  // Only a clean exit is parsed. Failed invocations print help or error text that
  // must not be read as model slugs or as a login verdict.
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? modelsResult.success.value
      : undefined;
  const cliModels: DeepSeekModelsCliOutput = modelsOutput
    ? parseDeepSeekModelsCliOutput(`${modelsOutput.stdout}\n${modelsOutput.stderr}`)
    : { authenticated: null, models: [] };
  if (!modelsOutput) {
    yield* Effect.logDebug("DeepSeek harness model listing unavailable; using ACP discovery.", {
      errorTag: Result.isFailure(modelsResult)
        ? modelsResult.failure._tag
        : Option.isNone(modelsResult.success)
          ? "Timeout"
          : `ExitCode${modelsResult.success.value.code}`,
    });
  }

  const auth: ServerProviderAuth = environment[DEEPSEEK_API_KEY_ENV]?.trim()
    ? { status: "authenticated", type: "api_key", label: "DeepSeek API key" }
    : cliModels.authenticated === true
      ? { status: "authenticated", type: "cached_token", label: "DeepSeek account" }
      : cliModels.authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  const acpExit = yield* discoverDeepSeekModelsViaAcpInitialize(deepseekSettings, environment).pipe(
    Effect.timeoutOption(DEEPSEEK_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpModels = Exit.isSuccess(acpExit) ? Option.getOrElse(acpExit.value, () => []) : [];
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("DeepSeek ACP initialize probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }

  // ACP discovery is authoritative. CLI-listed models are only a fallback when
  // ACP yields nothing and the CLI positively reported a login, so help text
  // from a harness without the `models` subcommand can never leak into the
  // picker.
  const cliFallbackModels = cliModels.authenticated === true ? cliModels.models : [];
  const discoveredModels = acpModels.length > 0 ? acpModels : cliFallbackModels;
  const models =
    discoveredModels.length > 0
      ? deepseekModelsFromSettings(deepseekSettings.customModels, discoveredModels)
      : fallbackModels;

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepseekSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "DeepSeek harness CLI is installed but not logged in. Set DEEPSEEK_API_KEY.",
      },
    });
  }

  return buildServerProvider({
    presentation: DEEPSEEK_PRESENTATION,
    enabled: deepseekSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed metadata probe degrades the model picker, it does not make chats fail.
      status: acpFailed ? "warning" : "ready",
      auth,
      ...(acpFailed
        ? {
            message:
              "DeepSeek harness CLI is installed but ACP initialize failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichDeepSeekSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("DeepSeek version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
