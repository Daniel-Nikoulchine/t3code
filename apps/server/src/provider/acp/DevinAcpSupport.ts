import { type DevinSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DEVIN_API_KEY_ENV = "WINDSURF_API_KEY";
const DEVIN_AUTH_METHOD_API_KEY = "devin_api_key";
const DEVIN_AUTH_METHOD_CACHED_TOKEN = "devin_login";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  readonly model?: string | undefined;
}

/**
 * Map T3 runtime modes onto Devin CLI `--permission-mode` values.
 *
 * Devin modes: `normal` (default, prompt on writes/exec), `accept-edits`
 * (auto-approve workspace edits), `smart` (fast-model judges safe actions),
 * `dangerous` (auto-approve everything, aliases yolo/bypass).
 * `autonomous` requires `--sandbox` and is intentionally not mapped — T3
 * never passes `--sandbox` itself.
 */
export function devinAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "approval-required":
      return ["--permission-mode", "normal", "acp"];
    case "auto-accept-edits":
      return ["--permission-mode", "accept-edits", "acp"];
    case "auto":
      return ["--permission-mode", "smart", "acp"];
    case "full-access":
      return ["--permission-mode", "dangerous", "acp"];
    default:
      return ["acp"];
  }
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
  model?: string | undefined,
): AcpSessionRuntime.AcpSpawnInput {
  const trimmedModel = model?.trim();
  return {
    command: devinSettings?.binaryPath || "devin",
    args: [...devinAcpSpawnArgs(runtimeMode), ...(trimmedModel ? ["--model", trimmedModel] : [])],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export function resolveDevinAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[DEVIN_API_KEY_ENV]?.trim()
    ? DEVIN_AUTH_METHOD_API_KEY
    : DEVIN_AUTH_METHOD_CACHED_TOKEN;
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(
          input.devinSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
          input.model,
        ),
        authMethodId: resolveDevinAuthMethodId(input.environment),
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

/**
 * T3's built-in Devin slug. It is a product label, not a model id the ACP
 * accepts, so selecting it means "use whatever model the Devin session
 * currently runs on".
 */
export const DEVIN_DEFAULT_MODEL_SLUG = "devin-default";

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEVIN_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? DEVIN_DEFAULT_MODEL_SLUG;
}

export function currentDevinModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  // The product slug is never sent over the wire; it keeps the session's current model.
  const requestedModelId =
    input.requestedModelId === DEVIN_DEFAULT_MODEL_SLUG ? undefined : input.requestedModelId;
  if (requestedModelId === undefined || requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  if (input.currentModelId === undefined) {
    return Effect.succeed(requestedModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}
