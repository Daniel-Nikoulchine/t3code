/**
 * ZcodeProvider — health snapshot for the ZCode (Z.ai GLM harness) CLI.
 *
 * Probes, cheapest first:
 *
 *   1. `zcode --version` — installed + version (never touches auth).
 *   2. `workspace/readState` over a single-shot `zcode app-server` —
 *      authoritative model catalog (`modelCatalog.available[]` with
 *      `ref.providerId/ref.modelId`) plus the workspace's current model,
 *      which is marked `isDefault` in the picker.
 *   3. `zcode skills list --json` — workspace skills for the `$` picker.
 *
 * Auth is heuristic: a configured model-access key (instance environment
 * entries like `ZAI_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, or the main provider's
 * `apiKey` in `~/.zcode/cli/config.json`) means authenticated. Otherwise the
 * state stays `unknown` — the desktop OAuth store is encrypted and the CLI
 * config may simply be unconfigured, so `unknown` avoids a lying red badge.
 *
 * @module provider/Layers/ZcodeProvider
 */
import {
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ZcodeSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
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
import { discoverZcodeSkills } from "../Drivers/ZcodeSkills.ts";
import { requestZcodeAppServerOnce } from "./ZcodeSessionRuntime.ts";

const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  badgeLabel: "Early Access",
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const ZCODE_DEFAULT_MODEL_SLUG = "glm-5.2";

const ZCODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "glm-5.2",
    name: "GLM-5.2",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  { slug: "glm-5-turbo", name: "GLM-5-Turbo", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "glm-5.3", name: "GLM-5.3", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  {
    slug: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const READ_STATE_PROBE_TIMEOUT_MS = 20_000;
const ZCODE_CLI_CONFIG_RELATIVE_PATH = ".zcode/cli/config.json";

const MODEL_ACCESS_ENV_PATTERN =
  /^(?:ZCODE|ZAI|BIGMODEL|ZHIPU|ANTHROPIC)_.*(?:KEY|TOKEN|MODEL|CONFIG|PROVIDER|BASE_URL)/;

function zcodeModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = ZCODE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export interface ZcodeReadStateModels {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly currentModelId: string | undefined;
}

/**
 * Map `workspace/readState` onto provider models. Unknown shapes yield an
 * empty list so callers fall back to the built-in catalog instead of
 * crashing the health check.
 */
export function parseZcodeReadStateModels(result: unknown): ZcodeReadStateModels {
  if (!isRecord(result)) {
    return { models: [], currentModelId: undefined };
  }
  const catalog = isRecord(result.modelCatalog) ? result.modelCatalog : undefined;
  const available = catalog && Array.isArray(catalog.available) ? catalog.available : [];
  const settings = isRecord(result.settings) ? result.settings : undefined;
  const modelSettings = settings && isRecord(settings.model) ? settings.model : undefined;
  const currentRef =
    modelSettings && isRecord(modelSettings.current) ? modelSettings.current : undefined;
  const currentModelId = nonEmptyString(currentRef?.modelId);

  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of available) {
    if (!isRecord(entry)) {
      continue;
    }
    const ref = isRecord(entry.ref) ? entry.ref : undefined;
    const slug = nonEmptyString(ref?.modelId);
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const label = nonEmptyString(entry.label) ?? slug;
    models.push({
      slug,
      name: label,
      isCustom: false,
      ...(currentModelId !== undefined && slug === currentModelId ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  // The catalog omits `isDefault` when the workspace pins an unlisted model;
  // the picker still wants a default, so keep the first entry's implicit order.
  return { models, currentModelId };
}

/** True when the instance environment already carries model-access credentials. */
export function hasZcodeModelAccessEnv(environment: NodeJS.ProcessEnv): boolean {
  return Object.entries(environment).some(
    ([key, value]) =>
      key !== "ZCODE_BASE_URL" &&
      typeof value === "string" &&
      value.trim().length > 0 &&
      MODEL_ACCESS_ENV_PATTERN.test(key),
  );
}

function configHomeDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  return (
    nonEmptyString(environment.HOME) ??
    nonEmptyString(environment.USERPROFILE) ??
    nonEmptyString(process.env.HOME)
  );
}

/**
 * Read the main provider's `apiKey` from the ZCode CLI config
 * (`~/.zcode/cli/config.json`). Returns the configured `providerId/model`
 * pair plus whether an API key is present. Missing/unparseable files yield
 * `undefined` fields — never a failure — so the health check degrades to
 * `auth: unknown` instead of erroring.
 */
export function readZcodeCliModelAccess(config: unknown): {
  readonly model: string | undefined;
  readonly hasApiKey: boolean;
} {
  if (!isRecord(config)) {
    return { model: undefined, hasApiKey: false };
  }
  const model = isRecord(config.model) ? nonEmptyString(config.model.main) : undefined;
  if (!model) {
    return { model: undefined, hasApiKey: false };
  }
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    return { model, hasApiKey: false };
  }
  const providerId = model.slice(0, separator);
  const providers = isRecord(config.provider) ? config.provider : undefined;
  const provider = providers && isRecord(providers[providerId]) ? providers[providerId] : undefined;
  const options = provider && isRecord(provider.options) ? provider.options : undefined;
  const apiKey = options ? nonEmptyString(options.apiKey) : undefined;
  return { model, hasApiKey: apiKey !== undefined };
}

const readZcodeCliConfigFile = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<unknown, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = configHomeDirectory(environment);
    if (!home) {
      return null;
    }
    const configPath = path.join(home, ZCODE_CLI_CONFIG_RELATIVE_PATH);
    const exists = yield* fileSystem.exists(configPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return null;
    }
    const raw = yield* fileSystem.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
    if (!raw.trim()) {
      return null;
    }
    return parseJsonConfig(raw);
  });

/** Best-effort CLI config parse. Unparseable files yield `null`. */
function parseJsonConfig(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function buildInitialZcodeProviderSnapshot(
  zcodeSettings: ZcodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = zcodeModelsFromSettings(zcodeSettings.customModels);

    if (!zcodeSettings.enabled) {
      return buildServerProvider({
        presentation: ZCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "ZCode is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking ZCode CLI availability...",
      },
    });
  });
}

const runZcodeCliCommand = (
  zcodeSettings: ZcodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = zcodeSettings.binaryPath || "zcode";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const discoverZcodeModelsViaReadState = (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
) =>
  Effect.gen(function* () {
    const workspacePath = cwd && cwd.trim() ? cwd.trim() : process.cwd();
    const result = yield* requestZcodeAppServerOnce({
      command: zcodeSettings.binaryPath || "zcode",
      cwd: workspacePath,
      env: environment,
      method: "workspace/readState",
      params: { workspace: { workspaceKey: workspacePath, workspacePath } },
      timeoutMs: READ_STATE_PROBE_TIMEOUT_MS,
    });
    return parseZcodeReadStateModels(result);
  });

export const checkZcodeProviderStatus = Effect.fn("checkZcodeProviderStatus")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = zcodeModelsFromSettings(zcodeSettings.customModels);

  if (!zcodeSettings.enabled) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "ZCode is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runZcodeCliCommand(zcodeSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("ZCode CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "ZCode CLI (`zcode`) is not installed or not on PATH."
          : "Failed to execute ZCode CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "ZCode CLI is installed but timed out while running `zcode --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("ZCode CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "ZCode CLI is installed but failed to run.",
      },
    });
  }

  const skills = yield* discoverZcodeSkills(zcodeSettings, environment, cwd).pipe(
    Effect.tapError((cause) => Effect.logDebug("ZCode skill discovery failed.", { cause })),
    Effect.orElseSucceed(() => []),
  );

  const catalogModels: ReadonlyArray<ServerProviderModel> = yield* discoverZcodeModelsViaReadState(
    zcodeSettings,
    environment,
    cwd,
  ).pipe(
    Effect.map((state) => state.models),
    Effect.tapError((cause) =>
      Effect.logWarning("ZCode model catalog probe failed.", {
        errorTag: cause._tag,
      }),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProviderModel>),
  );
  const catalogFailed = catalogModels.length === 0;
  const models =
    catalogModels.length > 0
      ? zcodeModelsFromSettings(zcodeSettings.customModels, catalogModels)
      : fallbackModels;

  const cliConfig = yield* readZcodeCliConfigFile(environment);
  const cliAccess = readZcodeCliModelAccess(cliConfig);
  const auth: ServerProviderAuth = hasZcodeModelAccessEnv(environment)
    ? { status: "authenticated", type: "api_key", label: "ZCode API key" }
    : cliAccess.hasApiKey
      ? { status: "authenticated", type: "api_key", label: "ZCode Coding Plan" }
      : { status: "unknown" };

  return buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled: zcodeSettings.enabled,
    checkedAt,
    models,
    skills,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: catalogFailed ? "warning" : "ready",
      auth,
      ...(catalogFailed
        ? {
            message:
              "ZCode CLI is installed but the model catalog is unavailable. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichZcodeSnapshot = makeEnrichSnapshot("ZCode");
