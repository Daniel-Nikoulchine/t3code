import {
  type ClineSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
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
  CLINE_DEFAULT_MODEL_SLUG,
  makeClineAcpRuntime,
  resolveClineModelId,
} from "../acp/ClineAcpSupport.ts";
import { sessionModelStateFromInitialize } from "../acp/AcpRuntimeModel.ts";

const CLINE_PRESENTATION = {
  displayName: "Cline",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// Cline loads provider catalogs during ACP startup; keep the probe snappy
// while allowing slow first-run initialization room.
const CLINE_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

const CLINE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: CLINE_DEFAULT_MODEL_SLUG,
    name: "Cline Default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Free models on the Cline API (`GET api.cline.bot/api/v1/models`,
 * checked 2026-09-12: 445 ids, 20 free). ACP `initialize` (cline 3.0.61)
 * only advertises 15 of them, so the missing ones never reach the picker.
 * Three more (`minimax-m2.7`, `minimax-m3`, `z-ai/glm-5.2` with `:free`)
 * come via ACP but are absent from `/v1/models`; they are listed too so
 * offline fallback keeps offering them. Display names copy ACP where it
 * advertises the slug, generated in the same shape otherwise.
 */
const CLINE_FREE_MODELS: ReadonlyArray<{ slug: string; name: string }> = [
  { slug: "cohere/north-mini-code:free", name: "North Mini Code (free)" },
  { slug: "dots-studio/dots-3-note-preview:free", name: "Dots3-Note Preview (free)" },
  { slug: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B A4B (free)" },
  { slug: "google/gemma-4-31b-it:free", name: "Gemma 4 31B (free)" },
  { slug: "inclusionai/ling-3.0-flash-fin:free", name: "Ling 3.0 Flash Fin (free)" },
  { slug: "inclusionai/ling-3.0-flash-sante:free", name: "Ling 3.0 Flash Sante (free)" },
  { slug: "inclusionai/ling-3.0-flash-vl:free", name: "Ling 3.0 Flash VL (free)" },
  { slug: "liquid/lfm-2.5-2.6b:free", name: "LFM2.5-2.6B (free)" },
  { slug: "minimax/minimax-m2.7:free", name: "MiniMax M2.7 (free)" },
  { slug: "minimax/minimax-m3:free", name: "MiniMax M3 (free)" },
  { slug: "nex-agi/nex-n2.5-mini:free", name: "Nex N2.5 Mini (free)" },
  { slug: "nex-agi/nex-n2.5-pro:free", name: "Nex N2.5 Pro (free)" },
  {
    slug: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    name: "Nemotron 3 Nano Omni (free)",
  },
  { slug: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super (free)" },
  { slug: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra (free)" },
  { slug: "nvidia/nemotron-3.5-content-safety:free", name: "Nemotron 3.5 Content Safety (free)" },
  { slug: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning (free)" },
  { slug: "openrouter/free", name: "Free Models Router" },
  { slug: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (free)" },
  { slug: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1 (free)" },
  { slug: "thinkingmachines/inkling:free", name: "Inkling (free)" },
  { slug: "thinkingmachines/inkling-small:free", name: "Inkling Small (free)" },
  { slug: "z-ai/glm-5.2:free", name: "GLM 5.2 (free)" },
  // Free in the CLI under the `cline-free/` routing (seen live in the
  // user's CLI sessions and accepted by `session/set_model`), though ACP
  // `initialize` does not advertise it and `/v1/models` only knows the
  // `meta/` id without a `:free` suffix.
  { slug: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor (free)" },
];

/**
 * Append free models missing from the given list. Slugs already present
 * (ACP-advertised with their own name and default flag) are left alone,
 * so this never duplicates what the CLI reports.
 */
export function withClineFreeModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set(models.map((model) => model.slug));
  const missing: ServerProviderModel[] = [];
  for (const free of CLINE_FREE_MODELS) {
    if (!seen.has(free.slug)) {
      seen.add(free.slug);
      missing.push({
        slug: free.slug,
        name: free.name,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      });
    }
  }
  return missing.length === 0 ? models : [...models, ...missing];
}

/**
 * Last successfully discovered catalog per CLI binary. Discovery flakes
 * sporadically (hanging `session/new`, see retry below) while the CLI
 * itself stays healthy — serving the previous catalog keeps the picker
 * full instead of collapsing to the built-in default. Deliberately only
 * used when the binary probed fine but the catalog fetch failed, never
 * for missing binaries or disabled providers.
 */
const lastGoodCatalogByBinary = new Map<string, ReadonlyArray<ServerProviderModel>>();

function fallbackClineModels(clineSettings: ClineSettings): ReadonlyArray<ServerProviderModel> {
  const cached = lastGoodCatalogByBinary.get(clineSettings.binaryPath || "cline");
  // Merge with the *current* custom models so later-added customs still
  // show even when serving a cached catalog.
  return cached !== undefined
    ? clineModelsFromSettings(clineSettings.customModels, cached)
    : clineModelsFromSettings(clineSettings.customModels);
}

export function parseClineVersion(output: string): string | null {
  return parseGenericCliVersion(output);
}

export function buildInitialClineProviderSnapshot(
  clineSettings: ClineSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = clineModelsFromSettings(clineSettings.customModels);

    if (!clineSettings.enabled) {
      return buildServerProvider({
        presentation: CLINE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cline is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Cline CLI availability...",
      },
    });
  });
}

export function clineModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = CLINE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return withClineFreeModels(
    providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES),
  );
}

export function buildClineDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const discovered = modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    const slug = resolveClineModelId(model.modelId) ?? CLINE_DEFAULT_MODEL_SLUG;
    // The `default` product slug is T3's own alias for "session current" and
    // never a wire id; skip it here so discovery only yields concrete models.
    if (slug === CLINE_DEFAULT_MODEL_SLUG || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    const name = model.name.trim() || slug;
    return [
      {
        slug,
        name,
        isCustom: false,
        ...(model.modelId.trim() === modelState.currentModelId.trim() ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
  return discovered;
}

export function buildClineModelsFromInitialize(
  initialized: EffectAcpSchema.InitializeResponse,
): ReadonlyArray<ServerProviderModel> {
  return buildClineDiscoveredModelsFromSessionModelState(
    sessionModelStateFromInitialize(initialized),
  );
}

export function clineSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.trim().replace(/^\/+/, "");
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const description = command.description.trim();
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

const discoverClineModelsViaAcp = (
  clineSettings: ClineSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const discovered = yield* Effect.gen(function* () {
      const acp = yield* makeClineAcpRuntime({
        clineSettings,
        environment,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      });
      const started = yield* acp.start();
      return {
        models: buildClineDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models),
        // Cline advertises no ACP slash commands (its `cline skill`
        // subcommand lives outside the ACP session), so there is nothing to
        // collect here. Deliberately not waiting for an
        // AvailableCommandsUpdated notification: Cline never emits one, and
        // blocking on it would stall every status check.
        slashCommands: [] as ReadonlyArray<ServerProviderSlashCommand>,
      };
    }).pipe(Effect.scoped);

    return discovered;
  });

const runClineVersionCommand = (
  clineSettings: ClineSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = clineSettings.binaryPath || "cline";
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

export const checkClineProviderStatus = Effect.fn("checkClineProviderStatus")(function* (
  clineSettings: ClineSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = clineModelsFromSettings(clineSettings.customModels);

  if (!clineSettings.enabled) {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cline is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runClineVersionCommand(clineSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Cline CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Cline CLI (`cline`) is not installed or not on PATH. Install it with `npm i -g cline`."
          : "Failed to execute Cline CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Cline CLI is installed but timed out while running `cline --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseClineVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Cline CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Cline CLI is installed but failed to run.",
      },
    });
  }

  // `session/new` hangs sporadically even though the daemon answers the
  // next attempt promptly — retry a timed-out probe once before falling
  // back to the built-in catalog so one stuck probe cannot empty the
  // model picker.
  const runDiscovery = () =>
    discoverClineModelsViaAcp(clineSettings, environment).pipe(
      Effect.timeoutOption(CLINE_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
      Effect.exit,
    );
  let discoveryExit = yield* runDiscovery();
  if (Exit.isSuccess(discoveryExit) && Option.isNone(discoveryExit.value)) {
    discoveryExit = yield* runDiscovery();
  }
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Cline ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackClineModels(clineSettings),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Cline CLI is installed but ACP startup failed. Run `cline auth`, then refresh provider status.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Cline ACP model discovery timed out after ${CLINE_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackClineModels(clineSettings),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Cline CLI is installed but ACP startup timed out after ${CLINE_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;
  if (discovery.models.length > 0) {
    lastGoodCatalogByBinary.set(clineSettings.binaryPath || "cline", discovery.models);
  }
  const models =
    discovery.models.length > 0
      ? clineModelsFromSettings(clineSettings.customModels, discovery.models)
      : fallbackModels;

  return buildServerProvider({
    presentation: CLINE_PRESENTATION,
    enabled: clineSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});

export const enrichClineSnapshot = (input: {
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
      Effect.logWarning("Cline version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
