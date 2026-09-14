import { type HermesSettings } from "@t3tools/contracts";
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

const HERMES_AUTH_METHOD = "hermes-setup";

type HermesAcpSettings = Pick<HermesSettings, "binaryPath">;

interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  settings: HermesAcpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: HERMES_AUTH_METHOD,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

export function resolveHermesModelId(model: string | null | undefined): string | undefined {
  const value = model?.trim();
  return value && value !== "default" ? value : undefined;
}

/**
 * Model ids Hermes advertised for the live ACP session (`availableModels`
 * plus `currentModelId`). `undefined` when Hermes reported no catalog, in
 * which case callers keep the legacy behavior of sending the id as-is.
 */
export function advertisedHermesModelIds(
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

function equalsFoldCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Resolve a stored model selection against the live Hermes catalog before
 * `session/set_model`.
 *
 * Only ids Hermes currently advertises are sent, canonicalized to the
 * advertised casing (provider namespaces are case-sensitive: `MiniMaxAI`
 * works where `minimax` 404s). Everything unresolvable returns `undefined`
 * so the caller keeps the session on its current model instead of a
 * `session/set_model` the backend rejects with `401 ... is not supported`.
 * Bare names are never sent: Hermes' own model-name detection misroutes
 * them the same way (observed 401 `Model glm-5.3-free is not supported`).
 */
export function resolveHermesSessionModelId(
  model: string | null | undefined,
  advertised: ReadonlySet<string> | null | undefined,
): string | undefined {
  const requested = resolveHermesModelId(model);
  if (!requested) return undefined;
  if (!advertised || advertised.size === 0) return requested;
  for (const choice of advertised) {
    if (choice === requested) return requested;
  }
  for (const choice of advertised) {
    if (equalsFoldCase(choice, requested)) return choice;
  }
  return undefined;
}

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly model: string | null | undefined;
  readonly advertisedModels?: ReadonlySet<string> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const modelId = resolveHermesSessionModelId(input.model, input.advertisedModels ?? undefined);
  if (!modelId) return Effect.succeed(undefined);
  return input.runtime
    .setSessionModel(modelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(modelId));
}

export const deleteHermesSession = Effect.fn("deleteHermesSession")(function* (input: {
  readonly settings: HermesAcpSettings;
  readonly sessionId: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const command = input.settings.binaryPath || "hermes";
  const spawnCommand = yield* resolveSpawnCommand(
    command,
    ["sessions", "delete", input.sessionId, "--yes"],
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
