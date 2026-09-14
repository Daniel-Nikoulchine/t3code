/**
 * KiloAcpSupport — ACP runtime wiring for the Kilo Code CLI (`kilo acp`).
 *
 * Kilo's ACP server requires `authenticate` with method id `kilo-login`
 * (see `AuthMethodID` in Kilo's `packages/opencode/src/acp/service.ts`); any
 * other id is rejected with `UnknownAuthMethodError`.
 *
 * @module provider/acp/KiloAcpSupport
 */
import { type KiloSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KILO_AUTH_METHOD = "kilo-login";

type KiloAcpSettings = Pick<KiloSettings, "binaryPath">;

interface KiloAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiloSettings: KiloAcpSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildKiloAcpSpawnInput(
  settings: KiloAcpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "kilo",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKiloAcpRuntime = (
  input: KiloAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiloAcpSpawnInput(input.kiloSettings, input.cwd, input.environment),
        authMethodId: KILO_AUTH_METHOD,
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
 * sent over the wire; `applyKiloAcpModelSelection` turns them into a no-op.
 */
const KILO_KEEP_CURRENT_MODEL_SLUGS: ReadonlySet<string> = new Set(["auto", "default"]);

export function resolveKiloModelId(model: string | null | undefined): string | undefined {
  const value = model?.trim();
  if (!value || KILO_KEEP_CURRENT_MODEL_SLUGS.has(value.toLowerCase())) {
    return undefined;
  }
  return value;
}

export function applyKiloAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const modelId = resolveKiloModelId(input.model);
  return modelId
    ? input.runtime.setSessionModel(modelId).pipe(Effect.mapError(input.mapError))
    : Effect.void;
}

/**
 * Read the session's current model from a session-setup response. Real Kilo
 * answers `session/new` with config options only (no `models` payload); the
 * active model is the `model` select's `currentValue`.
 */
export function currentKiloModelFromSessionSetup(
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

export const deleteKiloSession = Effect.fn("deleteKiloSession")(function* (input: {
  readonly settings: KiloAcpSettings;
  readonly sessionId: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const command = input.settings.binaryPath || "kilo";
  const spawnCommand = yield* resolveSpawnCommand(
    command,
    ["session", "delete", input.sessionId],
    input.environment ? { env: input.environment } : {},
  );
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      ...(input.environment ? { env: input.environment } : {}),
      shell: spawnCommand.shell,
    }),
  );
});
