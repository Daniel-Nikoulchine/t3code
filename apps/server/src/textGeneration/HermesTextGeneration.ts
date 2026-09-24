import { type HermesSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "@t3tools/contracts";
import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  advertisedHermesModelIds,
  applyHermesAcpModelSelection,
  deleteHermesSession,
  makeHermesAcpRuntime,
} from "../provider/acp/HermesAcpSupport.ts";

export const makeHermesTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "Hermes",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<HermesSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const sessionIdRef = yield* Ref.make<string | undefined>(undefined);
      const probeEnvironment = {
        ...environment,
        HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
      };
      yield* Effect.addFinalizer(() =>
        Ref.get(sessionIdRef).pipe(
          Effect.flatMap((sessionId) =>
            sessionId
              ? deleteHermesSession({
                  settings,
                  sessionId,
                  environment: probeEnvironment,
                }).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
                  Effect.ignore,
                )
              : Effect.void,
          ),
        ),
      );
      const runtime = yield* makeHermesAcpRuntime({
        hermesSettings: settings,
        environment: probeEnvironment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return {
        runtime,
        onSessionStarted: (sessionId: string) => Ref.set(sessionIdRef, sessionId),
      };
    }),
  configureSession: ({ runtime, started, modelSelection, operation }) =>
    Effect.gen(function* () {
      yield* applyHermesAcpModelSelection({
        runtime,
        model: modelSelection.model,
        advertisedModels: advertisedHermesModelIds(started.sessionSetupResult.models),
        mapError: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to set Hermes ACP base model for text generation.",
            cause,
          }),
      });
      yield* runtime.setMode("default").pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to configure Hermes approval mode for text generation.",
              cause,
            }),
        ),
      );
    }),
});
