import { type DroidSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const DROID_DRIVER_KIND = ProviderDriverKind.make("droid");
export const DROID_API_KEY_ENV = "FACTORY_API_KEY";

/** Advertised by `initialize.authMethods`: browser device-pairing login. */
export const DROID_AUTH_METHOD_DEVICE_PAIRING = "device-pairing";
/** Advertised by `initialize.authMethods`: `FACTORY_API_KEY` validation. */
export const DROID_AUTH_METHOD_API_KEY = "factory-api-key";

/**
 * Session-start RPC budget. Droid answers `authenticate` immediately when
 * logged in, but a logged-out `device-pairing` flow waits on a browser step
 * that headless sessions can never complete — without this the ACP runtime
 * (which never times out `authenticate` itself) would hang session start
 * forever instead of surfacing the login remediation.
 */
export const DROID_SESSION_START_TIMEOUT_MS = 60_000;

/** Login remediation shared by the provider probe and session start errors. */
export const DROID_LOGIN_HINT =
  "If Droid is not logged in, run `droid` and complete the login flow, or set FACTORY_API_KEY.";

/**
 * Default model slug. Droid routes to the workspace default model when the
 * session keeps its current model, so selecting it means "use whatever model
 * the Droid session currently runs on" — never sent over the wire.
 */
export const DROID_DEFAULT_MODEL_SLUG = "auto";

type DroidAcpRuntimeDroidSettings = Pick<DroidSettings, "binaryPath">;

export interface DroidAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly droidSettings: DroidAcpRuntimeDroidSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Autonomy args for `droid exec --output-format acp`.
 *
 * `droid exec` is read-only by default (spec-mode); `--auto <level>` opts
 * into mutations with risk tiers gating what can run, and
 * `--skip-permissions-unsafe` bypasses all permission checks (only for
 * isolated full-access sessions — T3 gates those behind its own approval
 * surface, same as other ACP drivers' force flags).
 */
export function droidAcpAutonomyArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "approval-required":
      return [];
    case "auto-accept-edits":
      return ["--auto", "low"];
    case "auto":
      return ["--auto", "medium"];
    case "full-access":
      return ["--skip-permissions-unsafe"];
    default:
      return [];
  }
}

export function buildDroidAcpSpawnInput(
  droidSettings: DroidAcpRuntimeDroidSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: droidSettings?.binaryPath || "droid",
    args: ["exec", "--output-format", "acp", ...droidAcpAutonomyArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * Pick the `authenticate` method id Droid advertised over ACP. An explicit
 * API key wins (non-interactive, validates without a browser); otherwise the
 * CLI falls back to its cached device-pairing login.
 */
export function resolveDroidAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[DROID_API_KEY_ENV]?.trim()
    ? DROID_AUTH_METHOD_API_KEY
    : DROID_AUTH_METHOD_DEVICE_PAIRING;
}

export const makeDroidAcpRuntime = (
  input: DroidAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDroidAcpSpawnInput(
          input.droidSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: resolveDroidAuthMethodId(input.environment),
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

export function resolveDroidAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DROID_DEFAULT_MODEL_SLUG;
  const withoutVariant = base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
  return normalizeModelSlug(withoutVariant, DROID_DRIVER_KIND) ?? DROID_DEFAULT_MODEL_SLUG;
}

export function currentDroidModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Resolve a stored model selection against the live Droid catalog before
 * `session/set_model`. The product slug (`auto`) is never sent over the
 * wire; it keeps the session's current model.
 */
export function resolveDroidSessionModelId(
  model: string | null | undefined,
  advertised: ReadonlySet<string> | null | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === DROID_DEFAULT_MODEL_SLUG) return undefined;
  if (!advertised || advertised.size === 0) return trimmed;
  for (const choice of advertised) {
    if (choice === trimmed) return trimmed;
  }
  const lower = trimmed.toLowerCase();
  for (const choice of advertised) {
    if (choice.toLowerCase() === lower) return choice;
  }
  return undefined;
}

export function advertisedDroidModelIds(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): Set<string> | undefined {
  const ids = new Set<string>();
  for (const model of modelState?.availableModels ?? []) {
    const id = typeof model.modelId === "string" ? model.modelId.trim() : "";
    if (id) ids.add(id);
  }
  const current =
    typeof modelState?.currentModelId === "string" ? modelState.currentModelId.trim() : "";
  if (current) ids.add(current);
  return ids.size > 0 ? ids : undefined;
}

export function applyDroidAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly model: string | null | undefined;
  readonly advertisedModels?: ReadonlySet<string> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const modelId = resolveDroidSessionModelId(input.model, input.advertisedModels ?? undefined);
  if (!modelId) return Effect.succeed(undefined);
  return input.runtime
    .setSessionModel(modelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(modelId));
}
