import {
  type CustomModelSetting,
  type ModelCapabilities,
  type OmpSettings,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeEnrichSnapshot } from "../providerMaintenance.ts";
import { buildOmpRpcSpawnArgs, resolveOmpAgentDir } from "./OmpAdapter.ts";
import { isBackendBucketProviderId, stripBackendBucketPrefix } from "../ModelBackendEnvironment.ts";
import { makePiRpcClient, makePiRpcProcessTransport } from "../pi/PiRpcClient.ts";
import {
  extractSkillNames,
  extractSlashCommands,
  isNotLoggedInText,
  parseAvailableModels,
  parseCommandDescriptors,
  parseMissingApiKeyProvider,
  parseSessionState,
  type PiRpcModel,
} from "../pi/PiRpcProtocol.ts";

const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const OMP_THINKING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "off", label: "Off" },
        { id: "minimal", label: "Minimal" },
        { id: "low", label: "Low", isDefault: true },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
      ],
      currentValue: "low",
    },
  ],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const OMP_RPC_DISCOVERY_TIMEOUT_MS = 30_000;

const OMP_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Oh My Pi Default",
    isCustom: false,
    isDefault: true,
    capabilities: OMP_THINKING_CAPABILITIES,
  },
];

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = ompModelsFromSettings(ompSettings.customModels);

    if (!ompSettings.enabled) {
      return buildServerProvider({
        presentation: OMP_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Oh My Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Oh My Pi CLI availability...",
      },
    });
  });
}

export function ompModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = OMP_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/** Model slug for the picker: `provider/id`, or the bare id. */
export function ompModelSlug(model: PiRpcModel): string {
  return model.provider?.trim() ? `${model.provider.trim()}/${model.id}` : model.id;
}

export function ompModelsFromCatalog(
  catalog: ReadonlyArray<PiRpcModel>,
  currentModelId: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of catalog) {
    const slug = ompModelSlug(entry);
    if (seen.has(slug)) continue;
    seen.add(slug);
    const provider = entry.provider?.trim() || undefined;
    const isBucket = isBackendBucketProviderId(provider);
    // Strip stale bucket segments first (see Pi's discovery mapping): a
    // prefixed slug copied into the connection's model list must not turn
    // the bucket into its own subtitle.
    const cleanId = isBucket ? stripBackendBucketPrefix(entry.id) : entry.id;
    const hasUpstreamPath = isBucket ? cleanId.includes("/") : entry.id.includes("/");
    // `t3-backend` is T3's harness bucket for backend-wired instances, not a
    // model provider — never surface it. With an upstream path in the id the
    // upstream is the subtitle; bare backend models fall back to the instance
    // name. Native providers keep their provider label as-is (mirrors pi's
    // `buildPiModelsFromDiscovery`).
    let subProvider: string | undefined;
    if (isBucket) {
      subProvider = hasUpstreamPath ? cleanId.slice(0, cleanId.indexOf("/")) : undefined;
    } else {
      subProvider = provider;
    }
    const bareName =
      isBucket && hasUpstreamPath ? cleanId.slice(cleanId.indexOf("/") + 1) : cleanId;
    models.push({
      slug,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : bareName,
      ...(subProvider ? { subProvider } : {}),
      isCustom: false,
      ...(currentModelId !== undefined && entry.id === currentModelId ? { isDefault: true } : {}),
      capabilities: OMP_THINKING_CAPABILITIES,
    });
  }
  return models;
}

export function ompSkillsFromCommands(
  commands: ReturnType<typeof parseCommandDescriptors>,
): ReadonlyArray<ServerProviderSkill> {
  return extractSkillNames(commands).flatMap((skill) => {
    if (!skill.path?.trim()) return [];
    return [
      {
        name: skill.name,
        path: skill.path.trim(),
        scope: skill.location === "project" ? "project" : "user",
        enabled: true,
        ...(skill.description ? { description: skill.description } : {}),
      } satisfies ServerProviderSkill,
    ];
  });
}

export function ompSlashCommandsFromCommands(
  commands: ReturnType<typeof parseCommandDescriptors>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return extractSlashCommands(commands).map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
  }));
}

const runOmpCliCommand = (
  ompSettings: OmpSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(command, [...args], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export interface OmpDiscoveryResult {
  readonly currentModelId: string | undefined;
  readonly currentProvider: string | undefined;
  readonly catalog: ReadonlyArray<PiRpcModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/**
 * Short-lived RPC discovery: spawn an ephemeral harness (`--no-session`),
 * read `get_state` + `get_available_models` + `get_commands`, then kill it.
 * Never starts an agent run — no prompt is ever sent.
 */
const discoverOmpViaRpc = (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.gen(function* () {
      const transport = yield* makePiRpcProcessTransport({
        command: ompSettings.binaryPath || "omp",
        args: buildOmpRpcSpawnArgs({ noSession: true }),
        ...(cwd ? { cwd } : {}),
        env: resolveOmpAgentDir(ompSettings, environment),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
      const rpc = yield* makePiRpcClient(transport);
      const state = parseSessionState(
        yield* rpc.request({ type: "get_state" }, OMP_RPC_DISCOVERY_TIMEOUT_MS),
      );
      const catalog = parseAvailableModels(
        yield* rpc.request({ type: "get_available_models" }, OMP_RPC_DISCOVERY_TIMEOUT_MS),
      );
      const commands = parseCommandDescriptors(
        yield* rpc.request({ type: "get_commands" }, OMP_RPC_DISCOVERY_TIMEOUT_MS),
      );
      yield* rpc.close;
      return {
        currentModelId: state?.model?.id,
        currentProvider: state?.model?.provider,
        catalog,
        skills: ompSkillsFromCommands(commands),
        slashCommands: ompSlashCommandsFromCommands(commands),
      } satisfies OmpDiscoveryResult;
    }).pipe(Effect.scoped);
  });

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(ompSettings.customModels);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Oh My Pi is disabled in T3 Code settings.",
      },
    });
  }

  const binaryLabel = ompSettings.binaryPath || "omp";
  const versionResult = yield* runOmpCliCommand(ompSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Oh-My-Pi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `Oh-My-Pi CLI (\`${binaryLabel}\`) is not installed or not on PATH. Install it with \`bun install -g @oh-my-pi/pi-coding-agent\`, or point the binary path at upstream \`pi\`.`
          : "Failed to execute Oh-My-Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Oh-My-Pi CLI is installed but timed out while running \`${binaryLabel} --version\`.`,
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Oh-My-Pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh-My-Pi CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverOmpViaRpc(ompSettings, environment, cwd).pipe(
    Effect.timeoutOption(OMP_RPC_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit) || Option.isNone(discoveryExit.value)) {
    const errorTag = Exit.isFailure(discoveryExit) ? causeErrorTag(discoveryExit.cause) : "Timeout";
    yield* Effect.logWarning("Oh-My-Pi RPC discovery failed or timed out.", { errorTag });
    const detail = Exit.isFailure(discoveryExit) ? String(discoveryExit.cause) : "timeout";
    const missingProvider = parseMissingApiKeyProvider(detail);
    if (missingProvider || isNotLoggedInText(detail)) {
      return buildServerProvider({
        presentation: OMP_PRESENTATION,
        enabled: ompSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unauthenticated" },
          message: missingProvider
            ? `Oh-My-Pi has no API key for ${missingProvider}. Run \`${binaryLabel}\` and /login.`
            : `Oh-My-Pi CLI is installed but not logged in. Run \`${binaryLabel}\` and /login.`,
        },
      });
    }
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Oh-My-Pi CLI is installed but RPC discovery failed. Run \`${binaryLabel} --list-models\` to diagnose.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;

  const auth: ServerProviderAuth =
    discovery.catalog.length > 0
      ? { status: "authenticated", type: "cached_token", label: "Harness providers" }
      : { status: "unknown" };
  const models =
    discovery.catalog.length > 0
      ? ompModelsFromSettings(
          ompSettings.customModels,
          ompModelsFromCatalog(discovery.catalog, discovery.currentModelId),
        )
      : fallbackModels;

  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: ompSettings.enabled,
    checkedAt,
    models,
    skills: discovery.skills,
    slashCommands: discovery.slashCommands,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichOmpSnapshot = makeEnrichSnapshot("Oh-My-Pi");
