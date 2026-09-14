import {
  type KiloSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
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
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { deleteKiloSession, makeKiloAcpRuntime } from "../acp/KiloAcpSupport.ts";

const KILO_PRESENTATION = {
  displayName: "Kilo",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
/** `kilo models` prints the static catalog; generous on slow machines. */
const MODELS_PROBE_TIMEOUT_MS = 15_000;
/** `kilo auth list` is a local config read. */
const AUTH_PROBE_TIMEOUT_MS = 8_000;
// Kilo builds the full model catalog during ACP startup, so the first
// session/new (after the initialize handshake) takes longer than a plain CLI
// probe. Slash commands are best-effort metadata: the probe degrades to a
// warning instead of failing when this times out.
const KILO_ACP_COMMANDS_DISCOVERY_TIMEOUT_MS = 45_000;

/** BYOK env vars Kilo reads for direct provider access (no OAuth needed). */
const KILO_BYOK_API_KEY_ENV_VARS: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
];

/**
 * Fallback model list used before the first successful probe. The `auto`
 * slug is a product-level sentinel, not an ACP model id — the adapter treats
 * it as "keep the session's current model".
 */
const KILO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Kilo Auto",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function parseKiloVersion(output: string): string | null {
  return parseGenericCliVersion(output);
}

export function buildInitialKiloProviderSnapshot(
  kiloSettings: KiloSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kiloModelsFromSettings(kiloSettings.customModels);

    if (!kiloSettings.enabled) {
      return buildServerProvider({
        presentation: KILO_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kilo is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KILO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kilo CLI availability...",
      },
    });
  });
}

export function kiloModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KILO_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Parse `kilo models` output. The command prints one `providerID/modelID`
 * pair per line (e.g. `anthropic/claude-sonnet-4-20250514`), `kilo`-backed
 * providers first. Kilo Gateway ids carry their upstream (`kilo/provider/model`).
 * Lines that do not match that shape (headers, blank lines, verbose JSON
 * payloads) are skipped.
 */
export function parseKiloModelsCliOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.includes(" ")) {
      continue;
    }
    const separatorIndex = line.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === line.length - 1) {
      continue;
    }
    const providerId = line.slice(0, separatorIndex).trim();
    const modelId = line.slice(separatorIndex + 1).trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(providerId) || !modelId || modelId.includes(" ")) {
      continue;
    }
    const slug = `${providerId}/${modelId}`;
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    // Kilo Gateway ids nest the upstream (`kilo/anthropic/claude-opus-4.7`,
    // `kilo/~anthropic/claude-fable-latest`). Surface the upstream as the
    // subtitle and the bare model as the name; the leading `~` marks a
    // rolling alias and is display-only noise.
    const upstream = modelId.includes("/") ? modelId.slice(0, modelId.indexOf("/")) : undefined;
    const bareName = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
    const name = bareName.startsWith("~") ? bareName.slice(1) : bareName;
    models.push({
      slug,
      name,
      isCustom: false,
      subProvider: upstream ? `${providerId}/${upstream.replace(/^~/, "")}` : providerId,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

/**
 * Interpret `kilo auth list` output. Returns true when the CLI reports stored
 * credentials (a nonzero `N credentials` count or a login line), false when
 * it reports none, and null when the output matches neither (unknown format
 * or version) so callers degrade to `auth: unknown` instead of a wrong
 * verdict.
 */
export function parseKiloAuthListOutput(output: string): boolean | null {
  if (/you are logged in|logged in as/i.test(output)) {
    return true;
  }
  const credentialsMatch = /(\d+)\s+credentials?/i.exec(output);
  if (credentialsMatch?.[1] !== undefined) {
    return Number(credentialsMatch[1]) > 0;
  }
  if (/not logged in|not authenticated|no (providers|credentials) configured/i.test(output)) {
    return false;
  }
  return null;
}

function kiloApiKeyAuth(environment: NodeJS.ProcessEnv): ServerProviderAuth | undefined {
  const hasKey = KILO_BYOK_API_KEY_ENV_VARS.some(
    (name) => (environment[name]?.trim().length ?? 0) > 0,
  );
  return hasKey
    ? { status: "authenticated", type: "api_key", label: "Provider API key" }
    : undefined;
}

export function kiloSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.trim().replace(/^\/+/, "");
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const description = command.description.trim();
    // `input` is optional per ACP and native agents omit `hint`; a direct
    // access would throw a TypeError and fail the whole status probe.
    const hint = typeof command.input?.hint === "string" ? command.input.hint.trim() : undefined;
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      } satisfies ServerProviderSlashCommand,
    ];
  });
}

const runKiloCliCommand = (
  kiloSettings: KiloSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = kiloSettings.binaryPath || "kilo";
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
 * Best-effort slash-command discovery over ACP. The probe opens a real SDK
 * session (Kilo persists it), so the session is deleted on scope close.
 * Failures never reject — callers degrade to a warning snapshot.
 */
const discoverKiloSlashCommandsViaAcp = (
  kiloSettings: KiloSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.gen(function* () {
      const sessionIdRef = yield* Ref.make<string | undefined>(undefined);
      yield* Effect.addFinalizer(() =>
        Ref.get(sessionIdRef).pipe(
          Effect.flatMap((sessionId) =>
            sessionId
              ? deleteKiloSession({
                  settings: kiloSettings,
                  sessionId,
                  environment,
                }).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      );
      const acp = yield* makeKiloAcpRuntime({
        kiloSettings,
        environment,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      });
      const started = yield* acp.start();
      yield* Ref.set(sessionIdRef, started.sessionId);
      const commands = yield* acp.getEvents().pipe(
        Stream.filterMap((event) =>
          event._tag === "AvailableCommandsUpdated" ? Result.succeed(event) : Result.failVoid,
        ),
        Stream.runHead,
        Effect.timeoutOption("1 second"),
        Effect.map(Option.flatten),
      );
      return Option.match(commands, {
        onNone: () => [] as ReadonlyArray<ServerProviderSlashCommand>,
        onSome: (event) => kiloSlashCommands(event.availableCommands),
      });
    }).pipe(Effect.scoped);
  });

export const checkKiloProviderStatus = Effect.fn("checkKiloProviderStatus")(function* (
  kiloSettings: KiloSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kiloModelsFromSettings(kiloSettings.customModels);

  if (!kiloSettings.enabled) {
    return buildServerProvider({
      presentation: KILO_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kilo is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runKiloCliCommand(kiloSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kilo CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: KILO_PRESENTATION,
      enabled: kiloSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kilo CLI (`kilo`) is not installed or not on PATH. Install it with `npm install -g @kilocode/cli`, then run `kilo auth login`."
          : "Failed to execute Kilo CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: KILO_PRESENTATION,
      enabled: kiloSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kilo CLI is installed but timed out while running `kilo --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseKiloVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Kilo CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: KILO_PRESENTATION,
      enabled: kiloSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kilo CLI is installed but failed to run.",
      },
    });
  }

  // `kilo models` prints the static catalog without starting the agent.
  const modelsResult = yield* runKiloCliCommand(kiloSettings, ["models"], environment).pipe(
    Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  // Only a clean exit is parsed. Failed invocations print help or error text
  // that must not be read as model slugs.
  const cliModels =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? parseKiloModelsCliOutput(
          `${modelsResult.success.value.stdout}\n${modelsResult.success.value.stderr}`,
        )
      : [];
  if (cliModels.length === 0) {
    yield* Effect.logWarning("Kilo CLI model listing failed, timed out, or returned no models.", {
      errorTag: Result.isFailure(modelsResult)
        ? modelsResult.failure._tag
        : Option.isNone(modelsResult.success)
          ? "Timeout"
          : `ExitCode${modelsResult.success.value.code}`,
    });
  }

  const authListResult = yield* runKiloCliCommand(kiloSettings, ["auth", "list"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const authListOutput =
    Result.isSuccess(authListResult) &&
    Option.isSome(authListResult.success) &&
    authListResult.success.value.code === 0
      ? `${authListResult.success.value.stdout}\n${authListResult.success.value.stderr}`
      : undefined;
  const authListVerdict =
    authListOutput === undefined ? null : parseKiloAuthListOutput(authListOutput);

  const auth: ServerProviderAuth =
    kiloApiKeyAuth(environment) ??
    (authListVerdict === true
      ? { status: "authenticated", type: "cached_token", label: "Kilo account" }
      : authListVerdict === false
        ? { status: "unauthenticated" }
        : { status: "unknown" });

  const models =
    cliModels.length > 0
      ? kiloModelsFromSettings(kiloSettings.customModels, cliModels)
      : fallbackModels;

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: KILO_PRESENTATION,
      enabled: kiloSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Kilo CLI is installed but not logged in. Run `kilo auth login`.",
      },
    });
  }

  const commandsExit = yield* discoverKiloSlashCommandsViaAcp(kiloSettings, environment).pipe(
    Effect.timeoutOption(KILO_ACP_COMMANDS_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  const slashCommands =
    commandsExit._tag === "Success" && Option.isSome(commandsExit.value)
      ? commandsExit.value.value
      : [];
  const acpFailed = commandsExit._tag === "Failure" || Option.isNone(commandsExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("Kilo ACP slash-command discovery failed or timed out.", {
      errorTag: commandsExit._tag === "Failure" ? causeErrorTag(commandsExit.cause) : "Timeout",
    });
  }

  return buildServerProvider({
    presentation: KILO_PRESENTATION,
    enabled: kiloSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND, ...slashCommands],
    probe: {
      installed: true,
      version,
      // A failed metadata probe degrades the command menu, it does not make chats fail.
      status: acpFailed || cliModels.length === 0 ? "warning" : "ready",
      auth,
      ...(acpFailed
        ? {
            message:
              "Kilo CLI is installed but ACP startup failed. Slash commands may be incomplete.",
          }
        : cliModels.length === 0
          ? {
              message: "Kilo CLI returned no models. Run `kilo models` to verify the setup.",
            }
          : {}),
    },
  });
});

export const enrichKiloSnapshot = (input: {
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
      Effect.logWarning("Kilo version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
