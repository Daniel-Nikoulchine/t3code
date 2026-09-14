import { type ClineSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const CLINE_AUTH_METHOD_ID = "cline";
export const CLINE_AUTO_APPROVE_CONFIG_ID = "auto_approve";
export const CLINE_MODEL_CONFIG_ID = "model";
export const CLINE_MODE_CONFIG_ID = "mode";

type ClineAcpSettings = Pick<ClineSettings, "binaryPath">;

interface ClineAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly clineSettings: ClineAcpSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export function clineAcpPermissionArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  // Cline ACP defaults auto-approve to false (permission UI). Only
  // full-access opts into `--auto-approve true` at spawn; every other mode
  // flows through T3's `session/request_permission` handler so approvals,
  // session-scoped accept, and audit events keep working.
  return runtimeMode === "full-access" ? ["--auto-approve", "true"] : [];
}

export function buildClineAcpSpawnInput(
  settings: ClineAcpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "cline",
    args: [...clineAcpPermissionArgs(runtimeMode), "--acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeClineAcpRuntime = (
  input: ClineAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildClineAcpSpawnInput(
          input.clineSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: CLINE_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

/**
 * T3's built-in Cline slug. It is not a model id the ACP accepts, so
 * selecting it means "use whatever model the Cline session currently runs
 * on" — mirroring the Hermes `default` convention.
 */
export const CLINE_DEFAULT_MODEL_SLUG = "default";

export function resolveClineModelId(model: string | null | undefined): string | undefined {
  const value = model?.trim();
  return value && value !== CLINE_DEFAULT_MODEL_SLUG ? value : undefined;
}

export function applyClineAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setModel">;
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const modelId = resolveClineModelId(input.model);
  return modelId
    ? input.runtime.setModel(modelId).pipe(Effect.mapError(input.mapError))
    : Effect.void;
}

export function resolveClineModeId(
  interactionMode: "default" | "plan" | null | undefined,
): string | undefined {
  if (interactionMode === "plan") return "plan";
  if (interactionMode === "default") return "act";
  return undefined;
}

export function applyClineAcpModeSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setMode">;
  readonly interactionMode: "default" | "plan" | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const modeId = resolveClineModeId(input.interactionMode);
  return modeId ? input.runtime.setMode(modeId).pipe(Effect.mapError(input.mapError)) : Effect.void;
}

export function applyClineAcpAutoApprove(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly runtimeMode: RuntimeMode | undefined;
}): Effect.Effect<void> {
  if (input.runtimeMode === undefined) return Effect.void;
  // Cline's `set_config_option` schema rejects a JSON boolean for this option
  // (verified live against cline 3.0.61: boolean yields -32602 Invalid
  // params); its parser accepts the string form, so send "true"/"false".
  const autoApprove = input.runtimeMode === "full-access" ? "true" : "false";
  return input.runtime.setConfigOption(CLINE_AUTO_APPROVE_CONFIG_ID, autoApprove).pipe(
    Effect.asVoid,
    // Older Cline builds may not advertise the boolean option yet; a failed
    // toggle must not fail session start because the spawn flag plus T3's
    // permission handler already enforce the requested mode.
    Effect.catchCause((cause) => Effect.logDebug("Cline auto-approve toggle skipped.", { cause })),
  );
}
