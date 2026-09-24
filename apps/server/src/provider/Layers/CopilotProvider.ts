import {
  type CopilotSettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeEnrichSnapshot } from "../providerMaintenance.ts";
import { COPILOT_KNOWN_MODELS, makeCopilotAcpRuntime } from "../acp/CopilotAcpSupport.ts";

const COPILOT_PRESENTATION = {
  displayName: "Copilot",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
} as const;

const COPILOT_EFFORTS: ReadonlyArray<string> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function copilotEffortLabel(effort: string): string {
  switch (effort) {
    case "xhigh":
      return "Extra High";
    case "none":
      return "None";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "max":
      return "Max";
    default:
      return effort;
  }
}

export const COPILOT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: COPILOT_EFFORTS.map((effort) =>
        effort === "medium"
          ? { id: effort, label: copilotEffortLabel(effort), isDefault: true }
          : { id: effort, label: copilotEffortLabel(effort) },
      ),
      currentValue: "medium",
    },
  ],
});

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `session/new` also waits for skills to load (`available_commands_update`).
const COPILOT_ACP_DISCOVERY_TIMEOUT_MS = 30_000;

const COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = COPILOT_KNOWN_MODELS.map(
  (model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    ...(model.slug === "auto" ? { isDefault: true } : {}),
    capabilities: COPILOT_MODEL_CAPABILITIES,
  }),
);

export function buildInitialCopilotProviderSnapshot(
  copilotSettings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = copilotModelsFromSettings(copilotSettings.customModels);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Copilot CLI availability...",
      },
    });
  });
}

export function copilotModelsFromSettings(
  customModels: CopilotSettings["customModels"],
  builtInModels: ReadonlyArray<ServerProviderModel> = COPILOT_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function copilotSlashCommands(
  commands: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly hint?: string;
  }>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.trim().replace(/^\/+/, "");
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const description = command.description.trim();
    const hint = command.hint?.trim();
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      } satisfies ServerProviderSlashCommand,
    ];
  });
}

function isByokEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return (environment.COPILOT_PROVIDER_BASE_URL ?? "").trim().length > 0;
}

function hasTokenEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return (
    (environment.COPILOT_GITHUB_TOKEN ?? "").trim().length > 0 ||
    (environment.GH_TOKEN ?? "").trim().length > 0 ||
    (environment.GITHUB_TOKEN ?? "").trim().length > 0
  );
}

function copilotAuthFromEnvironment(environment: NodeJS.ProcessEnv): ServerProviderAuth {
  if (isByokEnvironment(environment)) {
    return { status: "authenticated", type: "byok", label: "Custom provider" };
  }
  if (hasTokenEnvironment(environment)) {
    return { status: "authenticated", type: "token", label: "GitHub token" };
  }
  return { status: "authenticated", type: "oauth", label: "GitHub account" };
}

function isAuthenticationRequiredError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  if (/authentication required/i.test(message)) return true;
  // effect-acp surfaces JSON-RPC errors with code -32000 for auth failures.
  if (typeof cause === "object" && cause !== null) {
    const record = cause as Record<string, unknown>;
    const code = record.code ?? (record.cause as Record<string, unknown> | undefined)?.code;
    if (code === -32000 && /auth/i.test(message)) return true;
    const data = record.data as unknown;
    if (typeof data === "string" && /authentication required/i.test(data)) return true;
  }
  return /-32000|authentication required|not logged in|login required/i.test(message);
}

const runCopilotVersionCommand = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = copilotSettings.binaryPath || "copilot";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export interface CopilotDiscoveryResult {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/**
 * ACP discovery: `initialize` + `authenticate` + `session/new`, capturing
 * `available_commands_update` for slash commands. Fails with an
 * authentication error when `copilot login` is required; the caller maps that
 * to an unauthenticated snapshot.
 */
const discoverCopilotViaAcp = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.gen(function* () {
      const acp = yield* makeCopilotAcpRuntime({
        copilotSettings,
        environment,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      });
      const started = yield* acp.start();
      const commands = yield* acp.getEvents().pipe(
        Stream.filterMap((event) =>
          event._tag === "AvailableCommandsUpdated" ? Result.succeed(event) : Result.failVoid,
        ),
        Stream.runHead,
        Effect.timeoutOption("2 seconds"),
        Effect.map(Option.flatten),
      );
      void started;
      return {
        slashCommands: Option.match(commands, {
          onNone: () => [] as ReadonlyArray<ServerProviderSlashCommand>,
          onSome: (event) =>
            copilotSlashCommands(
              event.availableCommands.map((command) => ({
                name: command.name,
                description: command.description,
                ...(typeof command.input?.hint === "string" ? { hint: command.input.hint } : {}),
              })),
            ),
        }),
      } satisfies CopilotDiscoveryResult;
    }).pipe(Effect.scoped);
  });

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = copilotModelsFromSettings(copilotSettings.customModels);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runCopilotVersionCommand(copilotSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Copilot CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Copilot CLI (`copilot`) is not installed or not on PATH. Install it with `npm install -g @github/copilot`."
          : "Failed to execute Copilot CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Copilot CLI is installed but timed out while running `copilot --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Copilot CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Copilot CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverCopilotViaAcp(copilotSettings, environment).pipe(
    Effect.timeoutOption(COPILOT_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    const cause = discoveryExit.cause;
    const detail = String(cause);
    if (isAuthenticationRequiredError(cause) || /authentication required/i.test(detail)) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: copilotSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Copilot CLI is installed but not logged in. Run `copilot login` and try again.",
        },
      });
    }
    yield* Effect.logWarning("Copilot ACP discovery failed", {
      errorTag: causeErrorTag(cause),
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Copilot CLI is installed but ACP startup failed. Run `copilot login`, then refresh provider status.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Copilot ACP discovery timed out after ${COPILOT_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Copilot CLI is installed but ACP startup timed out after ${COPILOT_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;
  const slashCommands =
    discovery.slashCommands.length > 0 ? discovery.slashCommands : [COMPACT_SLASH_COMMAND];

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: copilotSettings.enabled,
    checkedAt,
    models: fallbackModels,
    slashCommands,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: copilotAuthFromEnvironment(environment),
    },
  });
});

export const enrichCopilotSnapshot = makeEnrichSnapshot("Copilot");
