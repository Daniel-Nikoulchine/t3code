/**
 * MinimaxAcpSupport — ACP runtime wiring for the MiniMax Code CLI (`mcode acp`).
 *
 * `mcode acp` serves the standard Agent Client Protocol over stdio
 * (verified live against 0.4.12: `initialize` with protocolVersion 1).
 * `session/new` is gated on the default model's auth route, not on a login
 * per se: with mcode's default model on the managed route it fails with
 * "Authentication required" until `mcode login` runs; with the default model
 * on a custom API-key provider (e.g. t3-backend on the t3-router loopback)
 * sessions open login-free. Model switching goes through the negotiated
 * `model` select (`session/set_config_option`): mcode implements no
 * `session/set_model`. Thinking effort rides the `thinkingEffort` select
 * (`session/set_config_option`, id `thinkingEffort`): it appears once a
 * thinking-capable model variant is active, advertises the model's own
 * effort levels, and the runtime merges the chosen level into the turn
 * payload (`reasoning_effort` on openai-completions, verified live:
 * effort `high` accepted, turn answered EFFORT-HIGH-OK).
 *
 * Effort levels are NOT hardcoded here: mcode validates the value against
 * the selected model's advertised `effortOptions` at set time and rejects
 * unknown ones, so the adapter reads levels from discovery and sends the
 * picker's choice back verbatim.
 *
 * @module provider/acp/MinimaxAcpSupport
 */
import { type MinimaxSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const MINIMAX_AUTH_METHOD_ID = "minimax-code-login";

type MinimaxAcpSettings = Pick<MinimaxSettings, "binaryPath">;

interface MinimaxAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly minimaxSettings: MinimaxAcpSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildMinimaxAcpSpawnInput(
  settings: MinimaxAcpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "mcode",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeMinimaxAcpRuntime = (
  input: MinimaxAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildMinimaxAcpSpawnInput(input.minimaxSettings, input.cwd, input.environment),
        authMethodId: MINIMAX_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

/**
 * Product slugs that mean "keep the session's current model". They are never
 * sent over the wire; `applyMinimaxAcpModelSelection` turns them into a no-op.
 */
const MINIMAX_KEEP_CURRENT_MODEL_SLUGS: ReadonlySet<string> = new Set(["auto", "default"]);

export function resolveMinimaxModelId(model: string | null | undefined): string | undefined {
  const value = model?.trim();
  if (!value || MINIMAX_KEEP_CURRENT_MODEL_SLUGS.has(value.toLowerCase())) {
    return undefined;
  }
  return value;
}

export function applyMinimaxAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setModel">;
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const modelId = resolveMinimaxModelId(input.model);
  return modelId
    ? input.runtime.setModel(modelId).pipe(Effect.mapError(input.mapError))
    : Effect.void;
}

/**
 * Read the session's current model from a session-setup response: the
 * `models.currentModelId` when present, else the `model` select's
 * `currentValue`.
 */
export function currentMinimaxModelFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const fromModels = sessionSetupResult.models?.currentModelId?.trim();
  if (fromModels) {
    return fromModels;
  }
  const modelOption = sessionSetupResult.configOptions?.find((option) => option.id === "model");
  const currentValue = modelOption?.type === "select" ? modelOption.currentValue : undefined;
  return currentValue?.trim() || undefined;
}

/** `mcode --version` prints a bare semver (`0.4.12`). */
export function parseMinimaxVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

/** Config-option id mcode uses for the effort select (verified live). */
export const MINIMAX_THINKING_EFFORT_CONFIG_ID = "thinkingEffort";

/**
 * One advertised effort level of the `thinkingEffort` select.
 */
export interface MinimaxThinkingEffortOption {
  readonly value: string;
  readonly name: string;
}

/**
 * Read the advertised thinking-effort levels from a session-setup response.
 * Returns the select's options plus its current value, or undefined when
 * the active model offers no effort control (mcode only advertises the
 * select for thinking-capable variants).
 */
export function minimaxThinkingEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
):
  | {
      readonly options: ReadonlyArray<MinimaxThinkingEffortOption>;
      readonly current: string | undefined;
    }
  | undefined {
  const selectOptions = (sessionSetupResult as { configOptions?: unknown }).configOptions as
    | ReadonlyArray<{
        id?: unknown;
        type?: unknown;
        currentValue?: unknown;
        options?: ReadonlyArray<{ value?: unknown; name?: unknown }>;
      }>
    | undefined;
  const effortSelect = selectOptions?.find(
    (option) => option.id === MINIMAX_THINKING_EFFORT_CONFIG_ID,
  );
  if (effortSelect?.type !== "select") return undefined;
  const options: MinimaxThinkingEffortOption[] = [];
  const seen = new Set<string>();
  for (const option of effortSelect.options ?? []) {
    const value = typeof option.value === "string" ? option.value.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const name = typeof option.name === "string" && option.name.trim() ? option.name.trim() : value;
    options.push({ value, name });
  }
  if (options.length === 0) return undefined;
  const current =
    typeof effortSelect.currentValue === "string" && effortSelect.currentValue.trim()
      ? effortSelect.currentValue.trim()
      : undefined;
  return { options, current };
}
