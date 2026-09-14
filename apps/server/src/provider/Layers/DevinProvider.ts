import {
  type DevinSettings,
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
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
  DEVIN_DEFAULT_MODEL_SLUG,
  makeDevinAcpRuntime,
  resolveDevinAcpBaseModelId,
} from "../acp/DevinAcpSupport.ts";
import { sessionModelStateFromInitialize } from "../acp/AcpRuntimeModel.ts";
import { discoverDevinSkills } from "../Drivers/DevinSkills.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `initialize` is a single local round trip, so this is generous even on slow machines.
const DEVIN_ACP_INITIALIZE_TIMEOUT_MS = 8_000;
const DEVIN_API_KEY_ENV = "WINDSURF_API_KEY";

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEVIN_DEFAULT_MODEL_SLUG,
    name: "Devin Default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

export function devinModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/** Models advertised by the ACP agent, with the session's current model marked as default. */
export function buildDevinModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const currentModelId = modelState.currentModelId.trim();
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    const slug = resolveDevinAcpBaseModelId(model.modelId);
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
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
}

export interface DevinModelsCliOutput {
  /** True or false when the CLI printed a login line, null when it printed neither. */
  readonly authenticated: boolean | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

function displayNameFromDevinModelSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function devinModelEntriesFromJson(value: unknown): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  const pushSlug = (raw: string, isDefault?: boolean) => {
    const slug = resolveDevinAcpBaseModelId(raw);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    models.push({
      slug,
      name: displayNameFromDevinModelSlug(slug),
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  };
  const visit = (entry: unknown) => {
    if (typeof entry === "string") {
      if (entry.trim()) pushSlug(entry.trim());
      return;
    }
    if (typeof entry !== "object" || entry === null) return;
    const record = entry as Record<string, unknown>;
    const rawId =
      (typeof record.model === "string" && record.model) ||
      (typeof record.id === "string" && record.id) ||
      (typeof record.slug === "string" && record.slug) ||
      (typeof record.name === "string" && record.name) ||
      "";
    if (typeof rawId === "string" && rawId.trim()) {
      const isDefault =
        record.isDefault === true || record.default === true || record.current === true;
      pushSlug(rawId.trim(), isDefault || undefined);
    }
  };
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry);
    return models;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["models", "data", "items"]) {
      if (Array.isArray(record[key])) {
        for (const entry of record[key] as Array<unknown>) visit(entry);
        if (models.length > 0) return models;
      }
    }
  }
  return models;
}

/**
 * Parses `devin models list --format json`. The command prints a JSON model
 * catalog; when the user is logged out it prints an auth error instead, which
 * yields an empty catalog (auth is probed separately via `devin auth status`).
 */
export function parseDevinModelsCliOutput(output: string): DevinModelsCliOutput {
  const trimmed = output.trim();
  if (!trimmed) return { authenticated: null, models: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { authenticated: null, models: [] };
  }
  return { authenticated: null, models: devinModelEntriesFromJson(parsed) };
}

export interface DevinAuthCliOutput {
  readonly authenticated: boolean | null;
  readonly email?: string | undefined;
}

/**
 * Parses `devin auth status`. Tolerant: exit-0 with a login line or email
 * means authenticated; explicit logged-out markers mean unauthenticated;
 * anything else is unknown and left to the ACP probe.
 */
export function parseDevinAuthStatusOutput(output: string): DevinAuthCliOutput {
  const combined = output.trim();
  if (!combined) return { authenticated: null };
  if (
    /not logged in|logged out|no .* credentials|authentication required|login required/i.test(
      combined,
    )
  ) {
    return { authenticated: false };
  }
  const email = combined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (/you are logged in|logged in as|authenticated/i.test(combined) || email) {
    return { authenticated: true, ...(email ? { email } : {}) };
  }
  return { authenticated: null };
}

const runDevinCliCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
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
const discoverDevinModelsViaAcpInitialize = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    return buildDevinModelsFromSessionModelState(sessionModelStateFromInitialize(initialized));
  }).pipe(Effect.scoped);

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinCliCommand(devinSettings, ["version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH. Install it with `curl -fsSL https://cli.devin.ai/install.sh | bash`."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  // `devin auth status` reports login state without starting the agent.
  const authResult = yield* runDevinCliCommand(devinSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const authOutput =
    Result.isSuccess(authResult) &&
    Option.isSome(authResult.success) &&
    authResult.success.value.code === 0
      ? `${authResult.success.value.stdout}\n${authResult.success.value.stderr}`
      : undefined;
  if (!authOutput) {
    yield* Effect.logWarning("Devin CLI auth check failed or timed out.", {
      errorTag: Result.isFailure(authResult)
        ? authResult.failure._tag
        : Option.isNone(authResult!.success)
          ? "Timeout"
          : `ExitCode${authResult.success.value.code}`,
    });
  }
  const cliAuth = authOutput ? parseDevinAuthStatusOutput(authOutput) : { authenticated: null };

  // `devin models list --format json` reports the account's model catalog.
  const modelsResult = yield* runDevinCliCommand(
    devinSettings,
    ["models", "list", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? `${modelsResult.success.value.stdout}\n${modelsResult.success.value.stderr}`
      : undefined;
  const cliModels: DevinModelsCliOutput = modelsOutput
    ? parseDevinModelsCliOutput(modelsOutput)
    : { authenticated: null, models: [] };
  if (!modelsOutput) {
    yield* Effect.logWarning("Devin CLI model listing failed or timed out.", {
      errorTag: Result.isFailure(modelsResult)
        ? modelsResult.failure._tag
        : Option.isNone(modelsResult.success)
          ? "Timeout"
          : `ExitCode${modelsResult.success.value.code}`,
    });
  }

  const auth: ServerProviderAuth = environment[DEVIN_API_KEY_ENV]?.trim()
    ? { status: "authenticated", type: "api_key", label: "Devin API key" }
    : cliAuth.authenticated === true
      ? {
          status: "authenticated",
          type: "cached_token",
          label: "Devin account",
          ...(cliAuth.email ? { email: cliAuth.email } : {}),
        }
      : cliAuth.authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  const skills = yield* discoverDevinSkills(cwd, environment).pipe(
    Effect.tapError((cause) => Effect.logDebug("Devin skill discovery failed.", { cause })),
    Effect.orElseSucceed(() => []),
  );

  const acpExit = yield* discoverDevinModelsViaAcpInitialize(devinSettings, environment).pipe(
    Effect.timeoutOption(DEVIN_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpModels = Exit.isSuccess(acpExit) ? Option.getOrElse(acpExit.value, () => []) : [];
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("Devin ACP initialize probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }

  const discoveredModels = acpModels.length > 0 ? acpModels : cliModels.models;
  const models =
    discoveredModels.length > 0
      ? devinModelsFromSettings(devinSettings.customModels, discoveredModels)
      : fallbackModels;

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models,
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Devin CLI is installed but not logged in. Run `devin auth login`.",
      },
    });
  }

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    skills,
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
              "Devin CLI is installed but ACP initialize failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichDevinSnapshot = (input: {
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
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
