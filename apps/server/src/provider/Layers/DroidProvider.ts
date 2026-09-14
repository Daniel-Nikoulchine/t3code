import {
  type CustomModelSetting,
  type DroidSettings,
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
  DROID_API_KEY_ENV,
  DROID_DEFAULT_MODEL_SLUG,
  makeDroidAcpRuntime,
  resolveDroidAcpBaseModelId,
} from "../acp/DroidAcpSupport.ts";
import { sessionModelStateFromInitialize } from "../acp/AcpRuntimeModel.ts";

const DROID_PRESENTATION = {
  displayName: "Droid",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `initialize` is a single local round trip, so this is generous even on slow machines.
const DROID_ACP_INITIALIZE_TIMEOUT_MS = 8_000;
// `droid doctor --auth` is three fast local/network checks; 20s covers a slow
// WorkOS round trip without stalling provider refreshes.
const DROID_DOCTOR_TIMEOUT_MS = 20_000;

const DROID_LOGIN_MESSAGE =
  "Droid CLI is installed but not logged in. Run `droid` and complete the login flow, or set FACTORY_API_KEY.";

const DROID_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DROID_DEFAULT_MODEL_SLUG,
    name: "Droid Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialDroidProviderSnapshot(
  droidSettings: DroidSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = droidModelsFromSettings(droidSettings.customModels);

    if (!droidSettings.enabled) {
      return buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Droid is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Droid CLI availability...",
      },
    });
  });
}

export function droidModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DROID_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export type DroidDoctorAuthState = "authenticated" | "unauthenticated" | "unknown";

/**
 * Read the login state from `droid doctor --auth --json`. The `auth.verify`
 * check reports `pass` for a usable login and `warn` + "no usable
 * credentials found (not logged in)" without one. Anything unparseable (old
 * CLI, changed schema) degrades to `unknown` so the probe never claims a
 * state it cannot prove.
 */
export function parseDroidDoctorAuth(stdout: string): DroidDoctorAuthState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "unknown";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "unknown";
  }
  const results = (parsed as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    return "unknown";
  }
  const verify = results.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      ((entry as Record<string, unknown>).id === "auth.verify" ||
        (entry as Record<string, unknown>).label === "Auth verification"),
  );
  if (!verify) {
    return "unknown";
  }
  if (verify.status === "pass") {
    return "authenticated";
  }
  if (verify.status === "warn" || verify.status === "fail") {
    const haystack = `${typeof verify.detail === "string" ? verify.detail : ""}\n${typeof verify.remediation === "string" ? verify.remediation : ""}`;
    return /not logged in|no usable credentials|login flow/i.test(haystack)
      ? "unauthenticated"
      : "unknown";
  }
  return "unknown";
}

/** Models advertised by the ACP agent, with the session's current model marked as default. */
export function buildDroidModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const currentModelId = modelState.currentModelId.trim();
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    if (!model.modelId.trim()) {
      return [];
    }
    const slug = resolveDroidAcpBaseModelId(model.modelId);
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

const runDroidCliCommand = (
  droidSettings: DroidSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = droidSettings.binaryPath || "droid";
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
 * Reads model metadata from `initialize._meta.modelState`. This never calls
 * `authenticate` with a real account flow or `session/new`, so it cannot open
 * a browser login or boot the workspace's MCP servers.
 */
const discoverDroidModelsViaAcpInitialize = (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDroidAcpRuntime({
      droidSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    return buildDroidModelsFromSessionModelState(sessionModelStateFromInitialize(initialized));
  }).pipe(Effect.scoped);

export const checkDroidProviderStatus = Effect.fn("checkDroidProviderStatus")(function* (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = droidModelsFromSettings(droidSettings.customModels);

  if (!droidSettings.enabled) {
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Droid is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDroidCliCommand(droidSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Droid CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: droidSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Droid CLI (`droid`) is not installed or not on PATH. Install it with `curl -fsSL https://app.factory.ai/cli | sh` or `npm install -g droid`."
          : "Failed to execute Droid CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: droidSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Droid CLI is installed but timed out while running `droid --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Droid CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: droidSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Droid CLI is installed but failed to run.",
      },
    });
  }

  const acpExit = yield* discoverDroidModelsViaAcpInitialize(droidSettings, environment).pipe(
    Effect.timeoutOption(DROID_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpModels = Exit.isSuccess(acpExit) ? Option.getOrElse(acpExit.value, () => []) : [];
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("Droid ACP initialize probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }

  // `droid doctor --auth --json` reports the login state in under a second
  // without opening a browser or a session. Only a clean exit is parsed —
  // failed invocations print help or error text that must not be read as a
  // login verdict.
  const doctorResult = yield* runDroidCliCommand(
    droidSettings,
    ["doctor", "--auth", "--json"],
    environment,
  ).pipe(Effect.timeoutOption(DROID_DOCTOR_TIMEOUT_MS), Effect.result);
  const doctorOutput =
    Result.isSuccess(doctorResult) &&
    Option.isSome(doctorResult.success) &&
    doctorResult.success.value.code === 0
      ? doctorResult.success.value.stdout
      : undefined;
  if (!doctorOutput) {
    yield* Effect.logWarning("Droid CLI auth check failed or timed out.", {
      errorTag: Result.isFailure(doctorResult)
        ? doctorResult.failure._tag
        : Option.isNone(doctorResult.success)
          ? "Timeout"
          : `ExitCode${doctorResult.success.value.code}`,
    });
  }
  const doctorAuth = doctorOutput ? parseDroidDoctorAuth(doctorOutput) : "unknown";

  const hasApiKey = Boolean(environment[DROID_API_KEY_ENV]?.trim());
  const auth: ServerProviderAuth =
    doctorAuth === "authenticated"
      ? {
          status: "authenticated",
          ...(hasApiKey
            ? { type: "api_key", label: "Factory API key" }
            : { type: "cached_token", label: "Factory account" }),
        }
      : doctorAuth === "unauthenticated"
        ? { status: "unauthenticated" }
        : hasApiKey
          ? { status: "authenticated", type: "api_key", label: "Factory API key" }
          : { status: "unknown" };

  const discoveredModels = acpModels.length > 0 ? acpModels : [];
  const models =
    discoveredModels.length > 0
      ? droidModelsFromSettings(droidSettings.customModels, discoveredModels)
      : fallbackModels;

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: droidSettings.enabled,
      checkedAt,
      models,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: DROID_LOGIN_MESSAGE,
      },
    });
  }

  return buildServerProvider({
    presentation: DROID_PRESENTATION,
    enabled: droidSettings.enabled,
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
              "Droid CLI is installed but ACP initialize failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichDroidSnapshot = (input: {
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
      Effect.logWarning("Droid version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
