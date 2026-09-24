import {
  type OpenClawSettings,
  type ModelCapabilities,
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
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeEnrichSnapshot } from "../providerMaintenance.ts";
import {
  deleteOpenClawSession,
  makeOpenClawAcpRuntime,
  resolveOpenClawModelId,
} from "../acp/OpenClawAcpSupport.ts";

const OPENCLAW_PRESENTATION = {
  displayName: "OpenClaw",
  badgeLabel: "Early Access",
  requiresNewThreadForModelChange: false,
} as const;
// OpenClaw advertises no per-model reasoning picker over ACP today (the CLI
// has `--thinking` levels for `agent`, but the ACP bridge exposes no
// `reasoning_effort` config option). Keep capabilities empty so the UI does
// not offer a picker the bridge would silently drop.
const OPENCLAW_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// The ACP bridge dials the Gateway over WebSocket; when the gateway is down
// the handshake fails fast, so a short budget keeps the status probe snappy.
const OPENCLAW_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
// OpenClaw versions as CalVer (`2026.9.4`). Keep the gate low: any 2026+
/// build ships the stable `acp` bridge.
const MINIMUM_OPENCLAW_VERSION = "2026.1.0";

const OPENCLAW_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "OpenClaw Default",
    isCustom: false,
    isDefault: true,
    capabilities: OPENCLAW_MODEL_CAPABILITIES,
  },
];

export function parseOpenClawVersion(output: string): string | null {
  const productVersion = output.match(/OpenClaw\s+v?(\d+\.\d+\.\d+)/i)?.[1];
  return productVersion ?? parseGenericCliVersion(output);
}

export function buildInitialOpenClawProviderSnapshot(
  openclawSettings: OpenClawSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = openclawModelsFromSettings(openclawSettings.customModels);

    if (!openclawSettings.enabled) {
      return buildServerProvider({
        presentation: OPENCLAW_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenClaw is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking OpenClaw CLI availability...",
      },
    });
  });
}

export function openclawModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = OPENCLAW_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], OPENCLAW_MODEL_CAPABILITIES);
}

export function buildOpenClawDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  // Bare `custom:<provider>:<model>` alias entries advertise names without
  // the "Provider · model" separator, so their upstream is only visible in
  // the modelId. Collect the advertised display label for each provider
  // prefix from the labeled (native) entries first, then fall back to the
  // raw slug when no labeled sibling exists.
  const labelByProviderSlug = new Map<string, string>();
  for (const model of modelState.availableModels) {
    if (!model.name.includes(" · ")) continue;
    const providerSlug = resolveOpenClawModelId(model.modelId)?.split(":")[0];
    if (!providerSlug || labelByProviderSlug.has(providerSlug)) continue;
    labelByProviderSlug.set(providerSlug, model.name.slice(0, model.name.indexOf(" · ")).trim());
  }
  const discoveredModels = modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveOpenClawModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      // OpenClaw advertises names as "Provider · model" ("Nous Portal ·
      // deepseek/deepseek-v4-flash"). Split at the first separator so the
      // upstream provider lands in `subProvider`, the subtitle field every
      // client already renders — otherwise the same model reachable through
      // several upstreams shows up as identical-looking picker rows. Bare
      // `custom:<provider>:<model>` aliases skip the separator; derive the
      // upstream from the modelId instead.
      const trimmedName = model.name.trim();
      const separatorIndex = trimmedName.indexOf(" · ");
      let subProvider = separatorIndex > 0 ? trimmedName.slice(0, separatorIndex).trim() : "";
      let name = (separatorIndex > 0 ? trimmedName.slice(separatorIndex + 3) : trimmedName).trim();
      if (!subProvider && slug.startsWith("custom:")) {
        const customBody = slug.slice("custom:".length);
        const providerEnd = customBody.indexOf(":");
        // Malformed single-segment aliases (`custom:lonely`) carry no
        // provider segment; `indexOf` returns -1 and `slice(0, -1)` would
        // silently drop the last character into a garbage subProvider.
        if (providerEnd > 0) {
          const providerSlug = customBody.slice(0, providerEnd);
          subProvider = labelByProviderSlug.get(providerSlug) ?? providerSlug;
          if (!name) name = customBody.slice(providerEnd + 1);
        }
      }
      return {
        slug,
        name: name || slug,
        isCustom: false,
        ...(subProvider ? { subProvider } : {}),
        ...(model.modelId === modelState.currentModelId ? { isDefault: true } : {}),
        capabilities: OPENCLAW_MODEL_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
  // OpenClaw lists a named endpoint's models twice when the endpoint is also
  // part of the shared inventory: once natively (`provider:model`, advertised
  // as "Provider · model") and once as a `custom:<provider>:<model>` alias
  // with the bare model name. Both rows render identically in the picker, so
  // fold each alias into its native sibling and keep its modelId selectable
  // via `aliases` (resolveSelectableModel matches those for persisted
  // selections, and OpenClaw accepts both id shapes on set_session_model).
  const collapsedModels: Array<ServerProviderModel> = [];
  const canonicalIndexByIdentity = new Map<string, number>();
  for (const model of discoveredModels) {
    const identity = model.subProvider
      ? `${model.subProvider}\u0000${model.name.toLowerCase()}`
      : null;
    const index = identity === null ? undefined : canonicalIndexByIdentity.get(identity);
    if (index === undefined) {
      if (identity !== null) canonicalIndexByIdentity.set(identity, collapsedModels.length);
      collapsedModels.push(model);
      continue;
    }
    const existing = collapsedModels[index];
    if (existing === undefined) continue;
    // The native row wins as the canonical entry regardless of arrival order;
    // every folded alias stays selectable via `aliases`.
    const canonical =
      existing.slug.startsWith("custom:") && !model.slug.startsWith("custom:") ? model : existing;
    const folded = canonical === existing ? model : existing;
    const isDefault = Boolean(existing.isDefault) || Boolean(model.isDefault);
    collapsedModels[index] = {
      ...canonical,
      ...(isDefault ? { isDefault: true } : {}),
      aliases: [...(canonical.aliases ?? []), folded.slug, ...(folded.aliases ?? [])],
    };
  }
  // When OpenClaw routes through its "default" entry, keep that routing selectable
  // instead of forcing clients onto the first concrete discovered model.
  return modelState.currentModelId === "default"
    ? [...OPENCLAW_BUILT_IN_MODELS, ...collapsedModels]
    : collapsedModels;
}

export function openclawSlashCommands(
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

const AUTH_PROBE_TIMEOUT_MS = 8_000;

export interface OpenClawAcpDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/**
 * Parse `openclaw models list --json` output. Shape (gateway down or up):
 * `{ count, models: [{ id?, model?, name?, provider? }] }`. Entries without
 * any usable id are skipped; `default` stays selectable via the built-in row.
 */
export function parseOpenClawModelsListOutput(output: string): ReadonlyArray<ServerProviderModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const entries = (parsed as Record<string, unknown>).models;
  if (!Array.isArray(entries)) {
    return [];
  }
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const rawId =
      (typeof record.id === "string" && record.id.trim()) ||
      (typeof record.model === "string" && record.model.trim()) ||
      (typeof record.modelId === "string" && record.modelId.trim()) ||
      "";
    const slug = resolveOpenClawModelId(rawId);
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const name =
      (typeof record.name === "string" && record.name.trim()) ||
      (typeof record.label === "string" && record.label.trim()) ||
      slug;
    const subProvider =
      typeof record.provider === "string" && record.provider.trim()
        ? record.provider.trim()
        : undefined;
    models.push({
      slug,
      name,
      isCustom: false,
      ...(subProvider ? { subProvider } : {}),
      capabilities: OPENCLAW_MODEL_CAPABILITIES,
    });
  }
  return models;
}

const discoverOpenClawModelsViaCli = (
  openclawSettings: OpenClawSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = openclawSettings.binaryPath || "openclaw";
    const spawnCommand = yield* resolveSpawnCommand(command, ["models", "list", "--json"], {
      env: environment,
    });
    const output = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
    if (output.code !== 0) {
      return [];
    }
    return parseOpenClawModelsListOutput(output.stdout);
  }).pipe(
    Effect.tapError((cause) => Effect.logDebug("OpenClaw CLI model listing failed.", { cause })),
    Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProviderModel>),
  );

const discoverOpenClawModelsViaAcp = (
  openclawSettings: OpenClawSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const probeEnvironment = {
    ...environment,
    OPENCLAW_ACP_SKIP_CONFIGURED_MCP: "1",
  };
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const discovered = yield* Effect.gen(function* () {
      const sessionIdRef = yield* Ref.make<string | undefined>(undefined);
      yield* Effect.addFinalizer(() =>
        Ref.get(sessionIdRef).pipe(
          Effect.flatMap((sessionId) =>
            sessionId
              ? deleteOpenClawSession({
                  settings: openclawSettings,
                  sessionId,
                  environment: probeEnvironment,
                }).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      );
      const acp = yield* makeOpenClawAcpRuntime({
        openclawSettings,
        environment: probeEnvironment,
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
      return {
        models: buildOpenClawDiscoveredModelsFromSessionModelState(
          started.sessionSetupResult.models,
        ),
        slashCommands: Option.match(commands, {
          onNone: () => [],
          onSome: (event) => openclawSlashCommands(event.availableCommands),
        }),
      };
    }).pipe(Effect.scoped);

    return discovered;
  });
};

const runOpenClawVersionCommand = (
  openclawSettings: OpenClawSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = openclawSettings.binaryPath || "openclaw";
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

export const checkOpenClawProviderStatus = Effect.fn("checkOpenClawProviderStatus")(function* (
  openclawSettings: OpenClawSettings,
  environment: NodeJS.ProcessEnv = process.env,
  _cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = openclawModelsFromSettings(openclawSettings.customModels);

  if (!openclawSettings.enabled) {
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenClaw is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOpenClawVersionCommand(openclawSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("OpenClaw CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: openclawSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "OpenClaw CLI (`openclaw`) is not installed or not on PATH. Install it with `npm install -g openclaw` — see https://docs.openclaw.ai."
          : "Failed to execute OpenClaw CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: openclawSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "OpenClaw CLI is installed but timed out while running `openclaw --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseOpenClawVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("OpenClaw CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: openclawSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "OpenClaw CLI is installed but failed to run.",
      },
    });
  }
  if (!version) {
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: openclawSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Unable to determine the OpenClaw version. T3 Code requires v${MINIMUM_OPENCLAW_VERSION} or newer.`,
      },
    });
  }
  if (compareSemverVersions(version, MINIMUM_OPENCLAW_VERSION) < 0) {
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: openclawSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `OpenClaw v${version} is incompatible. Upgrade to v${MINIMUM_OPENCLAW_VERSION} or newer with \`openclaw update\`.`,
      },
    });
  }

  // `openclaw models list --json` works without a running gateway (cached
  // catalog) and reports configured models when one is up. It never boots
  // an agent, so it is safe to run on every health check.
  const cliModelsOption = yield* discoverOpenClawModelsViaCli(openclawSettings, environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
  );
  const cliModels = Option.isSome(cliModelsOption)
    ? cliModelsOption.value
    : ([] as ReadonlyArray<ServerProviderModel>);

  const discoveryExit = yield* discoverOpenClawModelsViaAcp(openclawSettings, environment).pipe(
    Effect.timeoutOption(OPENCLAW_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("OpenClaw ACP model discovery failed.", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    const models =
      cliModels.length > 0
        ? openclawModelsFromSettings(openclawSettings.customModels, cliModels)
        : fallbackModels;
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: openclawSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "OpenClaw CLI is installed but the Gateway is not reachable. Start it with `openclaw gateway run`, then refresh provider status. See https://docs.openclaw.ai.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `OpenClaw ACP model discovery timed out after ${OPENCLAW_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    const models =
      cliModels.length > 0
        ? openclawModelsFromSettings(openclawSettings.customModels, cliModels)
        : fallbackModels;
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: openclawSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `OpenClaw CLI is installed but ACP startup timed out after ${OPENCLAW_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms. Is the Gateway running? See https://docs.openclaw.ai.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;
  const discoveredModels = discovery.models.length > 0 ? discovery.models : cliModels;
  const models =
    discoveredModels.length > 0
      ? openclawModelsFromSettings(openclawSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: OPENCLAW_PRESENTATION,
    enabled: openclawSettings.enabled,
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

export const enrichOpenClawSnapshot = makeEnrichSnapshot("OpenClaw");
