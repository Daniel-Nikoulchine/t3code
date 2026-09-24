import {
  type MinimaxSettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpErrors from "effect-acp/errors";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeEnrichSnapshot } from "../providerMaintenance.ts";
import {
  makeMinimaxAcpRuntime,
  minimaxThinkingEffortFromSessionSetup,
  parseMinimaxVersion,
} from "../acp/MinimaxAcpSupport.ts";
import { isBackendBucketProviderId } from "../ModelBackendEnvironment.ts";

const MINIMAX_PRESENTATION = {
  displayName: "MiniMax",
  requiresNewThreadForModelChange: false,
} as const;

/**
 * Reasoning picker for a MiniMax model, built from the levels mcode itself
 * advertises on the `thinkingEffort` select (never hardcoded: mcode rejects
 * unknown values per model at set time). The picker's choice is sent back
 * verbatim via the same select; the runtime merges it into the turn payload
 * (`reasoning_effort` on openai-completions, verified live).
 *
 * Shared shape: Cline reuses this builder for its spawn-time `--thinking`
 * levels (verified against the cline binary: none|low|medium|high|xhigh).
 * The descriptor id stays `reasoningEffort` so the TraitsPicker renders one
 * Reasoning chip for every harness.
 */
export function buildMinimaxThinkingCapabilities(input: {
  readonly levels: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  readonly current: string | undefined;
}): ModelCapabilities {
  const def =
    input.current && input.levels.some((level) => level.value === input.current)
      ? input.current
      : input.levels[0]?.value;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: input.levels.map((level) =>
          level.value === def
            ? { id: level.value, label: level.name, isDefault: true }
            : { id: level.value, label: level.name },
        ),
        ...(def === undefined ? {} : { currentValue: def }),
      },
    ],
  });
}

const MINIMAX_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "MiniMax Default",
    isCustom: false,
    isDefault: true,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  },
];

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// mcode builds its model catalog during ACP startup, so the first
// session/new after the initialize handshake takes longer than a plain CLI
// probe. Slash commands ride the same ephemeral session as discovery.
const MINIMAX_ACP_DISCOVERY_TIMEOUT_MS = 45_000;

/**
 * Parse an mcode custom-provider model id into its serving-backend parts
 * (`m:custom_provider%3At3-backend:opencode-go%2Fmodel-x:v:thinking`,
 * verified live): the custom provider id (`t3-backend`), the inner model
 * (`opencode-go/model-x`), and the upstream connection (`opencode-go`).
 *
 * Returns undefined for native (`minimax:`) ids and anything unparseable —
 * never throws, so discovery degrades instead of failing.
 */
export function parseMinimaxCustomModelId(modelId: string):
  | {
      readonly customId: string;
      readonly innerModel: string;
      readonly upstream: string | undefined;
    }
  | undefined {
  let decoded = modelId.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("m:")) {
    return undefined;
  }
  const segments = decoded.slice(2).split(":");
  if (segments[0] !== "custom_provider") {
    return undefined;
  }
  const customId = segments[1]?.trim();
  if (!customId) {
    return undefined;
  }
  let inner = segments.slice(2);
  // Drop the variant tail: `v` (plain ghost) or `v:<effort>` (thinking twin).
  if (inner[inner.length - 1] === "v") {
    inner = inner.slice(0, -1);
  } else if (inner.length >= 2 && inner[inner.length - 2] === "v") {
    inner = inner.slice(0, -2);
  }
  const innerModel = inner.join(":").trim();
  if (!innerModel) {
    return { customId, innerModel: "", upstream: undefined };
  }
  const slash = innerModel.indexOf("/");
  const upstream = (slash > 0 ? innerModel.slice(0, slash) : innerModel).trim();
  if (!upstream) {
    return { customId, innerModel, upstream: undefined };
  }
  return { customId, innerModel, upstream: slash > 0 ? upstream : undefined };
}

/**
 * Derive the serving-backend subtitle for an mcode custom-provider model id.
 * The picker groups these rows under the MiniMax instance that runs the
 * turn, so without a subtitle they read as native MiniMax models while
 * actually served by the custom provider's backend.
 *
 * Only the upstream connection (`opencode-go`) is surfaced — `t3-backend`
 * is mcode's own custom-provider bucket (the harness side), not a model
 * provider, and must not appear as the label. Bare models with no upstream
 * path get no subtitle and fall back to the instance name.
 *
 * Returns undefined for native (`minimax:`) ids and anything unparseable —
 * never throws, so discovery degrades to today's label instead of failing.
 */
export function minimaxCustomProviderSubProvider(modelId: string): string | undefined {
  const parsed = parseMinimaxCustomModelId(modelId);
  if (!parsed) {
    return undefined;
  }
  if (!parsed.innerModel || !parsed.upstream) {
    return undefined;
  }
  // A stale bucket segment in the inner model (prefixed slug copied into
  // the connection's model list) must not surface the harness bucket as
  // the subtitle — bare backend models get no subtitle.
  if (isBackendBucketProviderId(parsed.upstream)) {
    return undefined;
  }
  return parsed.upstream;
}

/**
 * Derive the picker display name for an mcode custom-provider model: the
 * upstream connection prefix (`opencode-go/…`) is redundant once the
 * subtitle carries it (Kilo-style bare names), so it is stripped. The
 * ` · thinking` suffix mcode appends to `:thinking` variants is also
 * dropped for custom entries — plain twins are rejected by
 * set_config_option, so every listed custom model is already the thinking
 * variant. Native `minimax:` names (which may list both variants) pass
 * through. Names without those decorations — or anything unparseable —
 * pass through untouched.
 */
export function minimaxCustomDisplayName(modelId: string, name: string): string {
  const trimmed = name.trim() ? name.trim() : modelId;
  const parsed = parseMinimaxCustomModelId(modelId);
  if (!parsed) {
    return trimmed;
  }
  let display = trimmed;
  if (parsed.upstream) {
    const prefix = `${parsed.upstream}/`;
    if (display.startsWith(prefix) && display.length > prefix.length) {
      display = display.slice(prefix.length);
    }
  }
  if (display.endsWith(" · thinking")) {
    display = display.slice(0, -" · thinking".length).trimEnd();
  }
  return display;
}

export function minimaxModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = MINIMAX_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    customModels ?? [],
    createModelCapabilities({ optionDescriptors: [] }),
  );
}

/**
 * Map an ACP session-setup response onto server models. mcode 0.4.12 returns
 * `models: null` and advertises models through the `model` select config
 * option instead (values like
 * `m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking`, verified live).
 * The adapter passes slugs back verbatim via the negotiated `model` select.
 * Only custom-provider entries are listed: managed entries need a prior
 * `mcode login`, and this harness runs login-free.
 *
 * Reasoning picker: the discovery session runs on the default model, so its
 * `thinkingEffort` select (when present) describes the DEFAULT model only.
 * That model's levels are attached to the matching discovered entry; other
 * entries get no descriptor rather than a placebo copied from another model.
 * The adapter re-reads the live select per turn and applies the picker's
 * choice verbatim, so each model offers exactly what mcode advertises.
 *
 * mcode advertises model variants the live select cannot accept: plain
 * (`:v:`) variants of custom-provider models fail `set_config_option` with
 * "Model selection is not advertised" (verified live: only the `:thinking`
 * twin is accepted). Those ghosts come from `availableModels`
 * (read from session state, which the select no longer lists), so they are
 * dropped below. Managed `minimax:` entries keep both variants — the
 * native `MiniMax-M3` plain variant is accepted.
 */
export function minimaxModelsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const fromState = (sessionSetupResult as { models?: unknown }).models as
    | {
        availableModels?: ReadonlyArray<{ modelId?: unknown; name?: unknown }>;
        currentModelId?: unknown;
      }
    | undefined;
  const seen = new Set<string>();
  const out: ServerProviderModel[] = [];
  const emptyCaps = createModelCapabilities({ optionDescriptors: [] });
  const effort = minimaxThinkingEffortFromSessionSetup(sessionSetupResult);
  const pushEntry = (id: string, name: string | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const subProvider = minimaxCustomProviderSubProvider(id);
    out.push({
      slug: id,
      name: minimaxCustomDisplayName(id, name && name.trim() ? name.trim() : id),
      isCustom: false,
      ...(subProvider ? { subProvider } : {}),
      capabilities: emptyCaps,
    });
  };
  for (const entry of fromState?.availableModels ?? []) {
    const id = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
    const name = typeof entry.name === "string" ? entry.name : undefined;
    // availableModels is stale session state: it lists plain `:v:` variants
    // the live select no longer offers (verified live: after a model
    // switch the select lists 32 options with exactly one plain variant,
    // the native MiniMax-M3). Only managed `minimax:` entries are taken
    // from here; custom-provider models come from the live select below.
    if (!id.includes("custom_provider")) {
      if (id.includes("minimax:")) pushEntry(id, name);
      continue;
    }
    // Custom-provider ghost variants (plain `:v:` twins of a `:thinking`
    // entry) are never accepted by set_config_option — skip them even
    // here so a stale state listing cannot reintroduce them.
    if (/:v:$/.test(id)) continue;
    pushEntry(id, name);
  }
  const selectOptions = (sessionSetupResult as { configOptions?: unknown }).configOptions as
    | ReadonlyArray<{
        id?: unknown;
        type?: unknown;
        currentValue?: unknown;
        options?: ReadonlyArray<{ value?: unknown; name?: unknown }>;
      }>
    | undefined;
  const modelSelect = selectOptions?.find((option) => option.id === "model");
  let current: string | undefined =
    typeof fromState?.currentModelId === "string" ? fromState.currentModelId.trim() : undefined;
  if (modelSelect?.type === "select") {
    for (const option of modelSelect.options ?? []) {
      const value = typeof option.value === "string" ? option.value.trim() : "";
      if (!value.includes("custom_provider")) continue;
      // Same ghost rule as for availableModels above: plain `:v:` twins of
      // a `:thinking` entry are listed by the select but rejected by
      // set_config_option ("Model selection is not advertised", verified
      // live). Managed `minimax:` entries never reach this branch.
      if (/:v:$/.test(value)) continue;
      const name = typeof option.name === "string" ? option.name : undefined;
      pushEntry(value, name);
    }
    if (typeof modelSelect.currentValue === "string" && modelSelect.currentValue.trim()) {
      current = modelSelect.currentValue.trim();
    }
  }
  const advertised =
    modelSelect?.type === "select"
      ? new Set(
          (modelSelect.options ?? []).flatMap((option) =>
            typeof option.value === "string" && option.value.trim() ? [option.value.trim()] : [],
          ),
        )
      : undefined;
  const models = advertised === undefined ? out : out.filter((model) => advertised.has(model.slug));
  if (current && models.some((model) => model.slug === current)) {
    return models.map((model) =>
      model.slug === current
        ? {
            ...model,
            isDefault: true,
            ...(effort === undefined
              ? {}
              : {
                  capabilities: buildMinimaxThinkingCapabilities({
                    levels: effort.options,
                    current: effort.current,
                  }),
                }),
          }
        : model,
    );
  }
  return models;
}

export function minimaxSlashCommands(
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

const runMinimaxCliCommand = (
  minimaxSettings: MinimaxSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = minimaxSettings.binaryPath || "mcode";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

interface MinimaxDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/**
 * Best-effort model + slash-command discovery over one ephemeral ACP
 * session. Scope close kills the child; failures never reject — callers
 * distinguish "not logged in" from transport failure by message.
 *
 * Reasoning levels per model: the discovery session starts on the default
 * model, so its `thinkingEffort` select describes only that model. To give
 * every thinking-capable model its own picker (verified live: a Go model
 * switched into session advertises the same 7 levels), discovery walks
 * each discovered custom-provider model once via `setModel`, reads the
 * live config options, and records that model's levels. Models whose
 * select never appears get no descriptor instead of a placebo.
 */
const discoverMinimaxViaAcp = (
  minimaxSettings: MinimaxSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  MinimaxDiscovery,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.gen(function* () {
      const acp = yield* makeMinimaxAcpRuntime({
        minimaxSettings,
        environment,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      });
      const started = yield* acp.start();
      const baseModels = minimaxModelsFromSessionSetup(started.sessionSetupResult);
      const models = yield* discoverMinimaxEffortLevels({ acp, baseModels });
      const commands = yield* acp.getEvents().pipe(
        Stream.filterMap((event) =>
          event._tag === "AvailableCommandsUpdated" ? Result.succeed(event) : Result.failVoid,
        ),
        Stream.runHead,
        Effect.timeoutOption("1 second"),
        Effect.map(Option.flatten),
      );
      return {
        models,
        slashCommands: Option.match(commands, {
          onNone: () => [] as ReadonlyArray<ServerProviderSlashCommand>,
          onSome: (event) => minimaxSlashCommands(event.availableCommands),
        }),
      } satisfies MinimaxDiscovery;
    }).pipe(Effect.scoped);
  });

/**
 * Walk each discovered model once and record its own advertised effort
 * levels. Best-effort per model: a switch that fails (model gone, select
 * unsupported) leaves that model without a descriptor. Runs sequentially —
 * one live session, no parallelism against the child.
 */
const discoverMinimaxEffortLevels = (input: {
  readonly acp: {
    readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  };
  readonly baseModels: ReadonlyArray<ServerProviderModel>;
}): Effect.Effect<ReadonlyArray<ServerProviderModel>> =>
  Effect.forEach(input.baseModels, (model) =>
    Effect.gen(function* () {
      const switched = yield* input.acp.setModel(model.slug).pipe(Effect.exit);
      if (Exit.isFailure(switched)) return model;
      const liveOptions = yield* input.acp.getConfigOptions.pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      );
      const effort = minimaxThinkingEffortFromSessionSetup({
        configOptions: liveOptions,
      } as never);
      if (effort === undefined) return model;
      return {
        ...model,
        capabilities: buildMinimaxThinkingCapabilities({
          levels: effort.options,
          current: effort.current,
        }),
      };
    }),
  );

function isMinimaxLoginCause(message: string): boolean {
  return /authentication required|not logged in|run `?mcode login/i.test(message);
}

export function buildInitialMinimaxProviderSnapshot(
  minimaxSettings: MinimaxSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = minimaxModelsFromSettings(minimaxSettings.customModels);

    if (!minimaxSettings.enabled) {
      return buildServerProvider({
        presentation: MINIMAX_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "MiniMax is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: MINIMAX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking MiniMax CLI availability...",
      },
    });
  });
}

export const checkMinimaxProviderStatus = Effect.fn("checkMinimaxProviderStatus")(function* (
  minimaxSettings: MinimaxSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = minimaxModelsFromSettings(minimaxSettings.customModels);

  if (!minimaxSettings.enabled) {
    return buildServerProvider({
      presentation: MINIMAX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "MiniMax is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runMinimaxCliCommand(
    minimaxSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("MiniMax CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: MINIMAX_PRESENTATION,
      enabled: minimaxSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "MiniMax CLI (`mcode`) is not installed or not on PATH. Install it with `npm install -g @minimax-ai/code`, then run `mcode login`."
          : "Failed to execute MiniMax CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: MINIMAX_PRESENTATION,
      enabled: minimaxSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "MiniMax CLI is installed but timed out while running `mcode --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseMinimaxVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("MiniMax CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: MINIMAX_PRESENTATION,
      enabled: minimaxSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "MiniMax CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverMinimaxViaAcp(minimaxSettings, environment).pipe(
    Effect.timeoutOption(MINIMAX_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    const message = Cause.prettyErrors(discoveryExit.cause).join("\n");
    if (isMinimaxLoginCause(message)) {
      const auth: ServerProviderAuth = { status: "unauthenticated" };
      return buildServerProvider({
        presentation: MINIMAX_PRESENTATION,
        enabled: minimaxSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth,
          message:
            "MiniMax CLI is installed but mcode's default model needs managed login. Point mcode's default model at a custom API-key provider (e.g. t3-backend) or run `mcode login`.",
        },
      });
    }
    yield* Effect.logWarning("MiniMax ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: MINIMAX_PRESENTATION,
      enabled: minimaxSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "MiniMax CLI is installed but the ACP probe failed. Refresh provider status.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `MiniMax ACP model discovery timed out after ${MINIMAX_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: MINIMAX_PRESENTATION,
      enabled: minimaxSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `MiniMax CLI is installed but ACP discovery timed out after ${MINIMAX_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const auth: ServerProviderAuth = {
    status: "authenticated",
    type: "api_key",
    label: "MiniMax custom provider",
  };
  const models =
    discovery.models.length > 0
      ? [
          ...discovery.models,
          ...minimaxModelsFromSettings(minimaxSettings.customModels).filter(
            (custom) => !discovery.models.some((model) => model.slug === custom.slug),
          ),
        ]
      : fallbackModels;

  return buildServerProvider({
    presentation: MINIMAX_PRESENTATION,
    enabled: minimaxSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND, ...discovery.slashCommands],
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichMinimaxSnapshot = makeEnrichSnapshot("MiniMax");

export { parseMinimaxVersion };
