import {
  type PiSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
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
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { discoverPiSkills } from "../Drivers/PiSkills.ts";
import {
  buildPiModelsFromDiscovery,
  parsePiVersion,
  piModelsFromSettings,
  piModelsWithDiscovery,
  PI_BUILT_IN_MODELS,
  type PiDiscoveredModel,
} from "../pi/PiRpcProtocol.ts";
import { makePiRpcRuntime, type PiRpcError } from "../pi/PiRpcRuntime.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const PI_RPC_DISCOVERY_TIMEOUT_MS = 25_000;

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI availability...",
      },
    });
  });
}

function piModelsFromCustomOnly(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return piModelsFromSettings(customModels, PI_BUILT_IN_MODELS);
}

const runPiVersionCommand = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
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

interface PiDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly currentProvider?: string | undefined;
  readonly currentModelId?: string | undefined;
}

/**
 * Discover pi models/commands via a short-lived ephemeral RPC process.
 * Never opens a browser login: `get_available_models` is read-only.
 */
const discoverPiViaRpc = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  {
    readonly models: ReadonlyArray<{
      readonly id: string;
      readonly provider: string;
      readonly name: string;
      readonly reasoning: boolean;
    }>;
    readonly state: Record<string, unknown>;
    readonly commands: ReadonlyArray<Record<string, unknown>>;
  },
  PiRpcError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    return yield* Effect.gen(function* () {
      const runtime = yield* makePiRpcRuntime({
        binaryPath: piSettings.binaryPath || "pi",
        cwd: process.cwd(),
        environment,
        ephemeral: true,
      });
      const models = yield* runtime.getAvailableModels().pipe(Effect.orElseSucceed(() => []));
      const state = yield* runtime.getState().pipe(Effect.orElseSucceed(() => ({})));
      const commands = yield* runtime.getCommands().pipe(Effect.orElseSucceed(() => []));
      return { models, state, commands };
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.scoped,
    );
  });

function toDiscoveredModels(
  models: ReadonlyArray<{ id: string; provider: string; name: string; reasoning: boolean }>,
  state: Record<string, unknown>,
): PiDiscovery {
  const stateModel = state.model as { provider?: unknown; id?: unknown } | undefined;
  const currentProvider =
    typeof stateModel?.provider === "string" ? stateModel.provider.trim() || undefined : undefined;
  const currentModelId =
    typeof stateModel?.id === "string" ? stateModel.id.trim() || undefined : undefined;
  const discovered: ReadonlyArray<PiDiscoveredModel> = models.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    reasoning: model.reasoning,
  }));
  return {
    models: buildPiModelsFromDiscovery({ models: discovered, currentProvider, currentModelId }),
    slashCommands: [],
    ...(currentProvider ? { currentProvider } : {}),
    ...(currentModelId ? { currentModelId } : {}),
  };
}

function slashCommandsFromPiCommands(
  commands: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  const out: ServerProviderSlashCommand[] = [];
  for (const entry of commands) {
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^\/+/, "") : "";
    if (!name || seen.has(name)) continue;
    // Skills surface via the skills picker (`/skill:name`); keep the slash
    // menu for real commands (extensions + prompt templates).
    if (name.startsWith("skill:")) continue;
    seen.add(name);
    const description =
      typeof entry.description === "string" && entry.description.trim()
        ? entry.description.trim().slice(0, 500)
        : undefined;
    out.push({
      name,
      ...(description ? { description } : {}),
    });
  }
  return out;
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromCustomOnly(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Pi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH. Install it with `npm i -g @mariozechner/pi-agent`."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parsePiVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  const skills = yield* discoverPiSkills(environment, cwd).pipe(
    Effect.tapError((cause) => Effect.logDebug("Pi skill discovery failed.", { cause })),
    Effect.orElseSucceed(() => []),
  );

  const discoveryExit = yield* discoverPiViaRpc(piSettings, environment).pipe(
    Effect.timeoutOption(PI_RPC_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Pi RPC model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but the RPC probe failed. Refresh provider status.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Pi RPC model discovery timed out after ${PI_RPC_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi CLI is installed but RPC discovery timed out after ${PI_RPC_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;
  const mapped = toDiscoveredModels(discovery.models, discovery.state);
  const slashCommands = [...slashCommandsFromPiCommands(discovery.commands), COMPACT_SLASH_COMMAND];
  const models =
    mapped.models.length > 0
      ? piModelsWithDiscovery(piSettings.customModels, mapped.models)
      : fallbackModels;

  const auth: ServerProviderAuth =
    mapped.models.length > 0
      ? { status: "authenticated", type: "cached_token", label: "Pi provider" }
      : { status: "unauthenticated" };

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models,
      skills,
      slashCommands,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Pi CLI is installed but not logged in. Run `pi` then `/login`.",
      },
    });
  }

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    skills,
    slashCommands,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichPiSnapshot = (input: {
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
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

export { EMPTY_CAPABILITIES };
