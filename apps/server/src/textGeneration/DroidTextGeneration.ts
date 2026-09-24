import { type DroidSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { TextGenerationError } from "@t3tools/contracts";
import {
  isAcpTextGenerationError,
  makeAcpJsonTextGeneration,
  type AcpJsonMakeRuntimeArgs,
} from "./AcpJsonTextGeneration.ts";
import {
  advertisedDroidModelIds,
  applyDroidAcpModelSelection,
  DROID_LOGIN_HINT,
  DROID_SESSION_START_TIMEOUT_MS,
  makeDroidAcpRuntime,
  resolveDroidAcpBaseModelId,
} from "../provider/acp/DroidAcpSupport.ts";

export const makeDroidTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "Droid",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<DroidSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeDroidAcpRuntime({
        droidSettings: settings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return { runtime };
    }),
  startSession: ({ runtime, operation }) =>
    runtime.start().pipe(
      Effect.timeoutOption(DROID_SESSION_START_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail:
                  `Droid session start timed out after ${DROID_SESSION_START_TIMEOUT_MS}ms while waiting for authentication. ` +
                  DROID_LOGIN_HINT,
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
        isAcpTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Droid ACP request failed.",
              cause,
            }),
      ),
    ),
  configureSession: ({ runtime, started, modelSelection, operation }) =>
    Effect.gen(function* () {
      const resolvedModel = resolveDroidAcpBaseModelId(modelSelection.model);
      yield* applyDroidAcpModelSelection({
        runtime,
        model: resolvedModel,
        advertisedModels: advertisedDroidModelIds(started.sessionSetupResult.models),
        mapError: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to set Droid ACP base model for text generation.",
            cause,
          }),
      });
    }),
});
