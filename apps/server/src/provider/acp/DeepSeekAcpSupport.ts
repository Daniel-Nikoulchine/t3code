import { type DeepSeekSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
const DEEPSEEK_AUTH_METHOD_API_KEY = "deepseek.api_key";
const DEEPSEEK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const DEEPSEEK_DRIVER_KIND = ProviderDriverKind.make("deepseek");
/** Config-option id the dsh ACP bridge advertises for reasoning effort. */
const DEEPSEEK_REASONING_EFFORT_CONFIG_ID = "reasoning_effort";

type DeepSeekAcpRuntimeDeepSeekSettings = Pick<DeepSeekSettings, "binaryPath">;

interface DeepSeekAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly deepseekSettings: DeepSeekAcpRuntimeDeepSeekSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Spawn args for the official DeepSeek harness (`dsh`). The shipped `acp`
 * profile serves standard ACP v1 over stdio and takes no per-mode flags:
 * T3 enforces the runtime mode at the `session/request_permission` layer
 * (auto-approving in full-access), the same way the other ACP adapters do.
 */
export function deepseekAcpSpawnArgs(_runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  return ["--profile", "acp"];
}

export function buildDeepSeekAcpSpawnInput(
  deepseekSettings: DeepSeekAcpRuntimeDeepSeekSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: deepseekSettings?.binaryPath || "dsh",
    args: [...deepseekAcpSpawnArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

function resolveDeepSeekAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[DEEPSEEK_API_KEY_ENV]?.trim()
    ? DEEPSEEK_AUTH_METHOD_API_KEY
    : DEEPSEEK_AUTH_METHOD_CACHED_TOKEN;
}

export const makeDeepSeekAcpRuntime = (
  input: DeepSeekAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        // dsh implements session/resume (log restore without replay) but not
        // session/load; thread resume must take the resume path.
        resumeMethod: "resume",
        spawn: buildDeepSeekAcpSpawnInput(
          input.deepseekSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: resolveDeepSeekAuthMethodId(input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/** T3's default DeepSeek model (friendly slug; resolved to the wire value per session). */
export const DEEPSEEK_DEFAULT_MODEL_SLUG = "deepseek-v4-flash";

/** Friendly slugs shipped as the built-in picker catalog. */
export const DEEPSEEK_BUILT_IN_MODEL_SLUGS: ReadonlyArray<string> = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-flash",
  "deepseek-v4-flash-vision-exp",
];

export function resolveDeepSeekAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEEPSEEK_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, DEEPSEEK_DRIVER_KIND) ?? DEEPSEEK_DEFAULT_MODEL_SLUG;
}

const DEEPSEEK_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function isValidDeepSeekReasoningEffortToken(value: string): boolean {
  return DEEPSEEK_REASONING_EFFORT_TOKEN.test(value);
}

export function normalizeDeepSeekReasoningEffort(value: string | undefined): string | undefined {
  const effort = value?.trim();
  return effort && isValidDeepSeekReasoningEffortToken(effort) ? effort : undefined;
}

export function currentDeepSeekModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function currentDeepSeekReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelState = sessionSetupResult.models;
  if (!modelState) {
    return undefined;
  }
  const currentModelId = modelState.currentModelId.trim();
  if (currentModelId.length === 0) {
    return undefined;
  }
  const currentModel = modelState.availableModels.find(
    (model) => model.modelId.trim() === currentModelId,
  );
  const reasoningEffort = currentModel?._meta?.reasoningEffort;
  return typeof reasoningEffort === "string"
    ? normalizeDeepSeekReasoningEffort(reasoningEffort)
    : undefined;
}

type DeepSeekModelSelectionRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "getConfigOptions" | "setConfigOption" | "setModel"
>;

function configOptionString(
  option: EffectAcpSchema.SessionConfigOption,
  field: "id" | "name",
): string | undefined {
  const value = field === "id" ? option.id : "name" in option ? option.name : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function findModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model");
}

/**
 * Current model/reasoning selection read from the session's live config
 * options. dsh reports both through `session/new` (no typed model state),
 * so this is the primary source; the typed `models` state is only a fallback.
 */
export function currentDeepSeekSelectionFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): { readonly modelId: string | undefined; readonly reasoningEffort: string | undefined } {
  if (!configOptions) {
    return { modelId: undefined, reasoningEffort: undefined };
  }
  const modelOption = findModelConfigOption(configOptions);
  const modelId =
    modelOption && "currentValue" in modelOption && typeof modelOption.currentValue === "string"
      ? modelOption.currentValue.trim() || undefined
      : undefined;
  const reasoningOption = configOptions.find(
    (option) =>
      configOptionString(option, "id") === DEEPSEEK_REASONING_EFFORT_CONFIG_ID ||
      configOptionString(option, "name") === DEEPSEEK_REASONING_EFFORT_CONFIG_ID,
  );
  const reasoningEffort =
    reasoningOption &&
    "currentValue" in reasoningOption &&
    typeof reasoningOption.currentValue === "string"
      ? normalizeDeepSeekReasoningEffort(reasoningOption.currentValue)
      : undefined;
  return { modelId, reasoningEffort };
}

function normalizeModelToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

interface DeepSeekModelOptionEntry {
  readonly value: string;
  readonly name: string | undefined;
}

/**
 * Flatten a `model` config option's entries. dsh groups its routes
 * (`{ group, name, options: [{ value, name, description }] }`); plain
 * `{ value, name }` entries pass through unchanged.
 */
export function flattenDeepSeekModelOptionEntries(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<DeepSeekModelOptionEntry> {
  if (!configOptions) {
    return [];
  }
  const modelOption = configOptions.find((option) => option.category === "model");
  if (!modelOption || !("options" in modelOption) || !Array.isArray(modelOption.options)) {
    return [];
  }
  const entries: Array<DeepSeekModelOptionEntry> = [];
  for (const entry of modelOption.options as ReadonlyArray<Record<string, unknown>>) {
    if (typeof entry.value === "string" && entry.value.trim().length > 0) {
      entries.push({
        value: entry.value.trim(),
        name: typeof entry.name === "string" ? entry.name : undefined,
      });
      continue;
    }
    if (Array.isArray(entry.options)) {
      for (const nested of entry.options as ReadonlyArray<Record<string, unknown>>) {
        if (typeof nested.value === "string" && nested.value.trim().length > 0) {
          entries.push({
            value: nested.value.trim(),
            name: typeof nested.name === "string" ? nested.name : undefined,
          });
        }
      }
    }
  }
  return entries;
}

/**
 * Resolve a T3 model slug to the exact `model` config-option value the dsh
 * session accepts. dsh advertises opaque route values such as
 * `["deepseek-official","deepseek-v4-flash"]`; T3 ships the friendly second
 * element as the picker slug. Exact values pass through untouched, friendly
 * slugs (and option display names) resolve to their advertised value, and
 * anything else is sent raw so the server validates it.
 */
export function resolveDeepSeekModelOptionValue(
  requestedModelId: string,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string {
  const requested = requestedModelId.trim();
  const entries = flattenDeepSeekModelOptionEntries(configOptions);
  if (entries.length === 0) {
    return requested;
  }
  if (entries.some((entry) => entry.value === requested)) {
    return requested;
  }
  const normalizedRequested = normalizeModelToken(requested);
  for (const entry of entries) {
    // Route pairs look like ["deepseek-official","deepseek-v4-flash"].
    try {
      const parsed: unknown = JSON.parse(entry.value);
      if (
        Array.isArray(parsed) &&
        parsed.some(
          (item) => typeof item === "string" && normalizeModelToken(item) === normalizedRequested,
        )
      ) {
        return entry.value;
      }
    } catch {
      // Not a route pair; fall through to name matching.
    }
  }
  for (const entry of entries) {
    if (entry.name !== undefined && normalizeModelToken(entry.name) === normalizedRequested) {
      return entry.value;
    }
  }
  return requested;
}

/** Friendly display slug for a wired model value (`["…","deepseek-v4-flash"]` → `deepseek-v4-flash`). */
export function displayDeepSeekModelSlug(wiredModelId: string | undefined): string | undefined {
  if (wiredModelId === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(wiredModelId);
    if (Array.isArray(parsed)) {
      for (let index = parsed.length - 1; index >= 0; index--) {
        const entry = parsed[index];
        if (typeof entry === "string" && entry.trim().length > 0) {
          return resolveDeepSeekAcpBaseModelId(entry);
        }
      }
    }
  } catch {
    // Not a route pair; use the value as-is.
  }
  return resolveDeepSeekAcpBaseModelId(wiredModelId);
}

function findReasoningEffortConfigId(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const match = configOptions.find(
    (option) =>
      configOptionString(option, "id") === DEEPSEEK_REASONING_EFFORT_CONFIG_ID ||
      configOptionString(option, "name") === DEEPSEEK_REASONING_EFFORT_CONFIG_ID,
  );
  return match?.id;
}

export interface DeepSeekAppliedModelSelection {
  /** Exact value the session now runs on (dsh route pair or plain id). */
  readonly wiredModelId: string | undefined;
  /** Friendly slug for display (route pairs collapse to their model element). */
  readonly displayModelId: string | undefined;
}

export function applyDeepSeekAcpModelSelection<E>(input: {
  readonly runtime: DeepSeekModelSelectionRuntime;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<DeepSeekAppliedModelSelection, E> {
  return Effect.gen(function* () {
    // dsh exposes `model` and `reasoning_effort` as session config options
    // (`session/set_config_option`); it does not implement `session/set_model`.
    // `setModel` on the shared runtime already targets the session's model
    // config id, so model selection stays correct even if dsh renames it.
    const configOptions = yield* input.runtime.getConfigOptions.pipe(
      Effect.mapError(input.mapError),
    );
    const requestedModelId = input.requestedModelId?.trim() || undefined;
    const requestedWired =
      requestedModelId !== undefined
        ? resolveDeepSeekModelOptionValue(requestedModelId, configOptions)
        : undefined;
    const modelChanged = requestedWired !== undefined && requestedWired !== input.currentModelId;
    if (modelChanged && requestedWired !== undefined) {
      yield* input.runtime.setModel(requestedWired).pipe(Effect.mapError(input.mapError));
    }
    const wiredModelId = requestedWired ?? input.currentModelId;

    const reasoningProvided = input.requestedReasoningEffort !== undefined;
    const reasoningEffort = reasoningProvided
      ? normalizeDeepSeekReasoningEffort(input.requestedReasoningEffort)
      : undefined;
    // An explicitly provided but malformed effort is dropped rather than
    // forwarded. An omitted effort never clears the advertised default.
    if (reasoningProvided && reasoningEffort !== undefined) {
      if (reasoningEffort !== input.currentReasoningEffort || modelChanged) {
        const refreshedOptions = modelChanged
          ? yield* input.runtime.getConfigOptions.pipe(Effect.mapError(input.mapError))
          : configOptions;
        const configId = findReasoningEffortConfigId(refreshedOptions);
        if (configId !== undefined) {
          yield* input.runtime
            .setConfigOption(configId, reasoningEffort)
            .pipe(Effect.mapError(input.mapError));
        }
      }
    }
    return {
      wiredModelId,
      displayModelId: requestedModelId ?? displayDeepSeekModelSlug(wiredModelId),
    } satisfies DeepSeekAppliedModelSelection;
  });
}
