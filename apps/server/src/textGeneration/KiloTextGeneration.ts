import { type KiloSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "@t3tools/contracts";
import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  applyKiloAcpModelSelection,
  deleteKiloSession,
  makeKiloAcpRuntime,
} from "../provider/acp/KiloAcpSupport.ts";

export const makeKiloTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "Kilo",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<KiloSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const sessionIdRef = yield* Ref.make<string | undefined>(undefined);
      const probeEnvironment = {
        ...environment,
      };
      yield* Effect.addFinalizer(() =>
        Ref.get(sessionIdRef).pipe(
          Effect.flatMap((sessionId) =>
            sessionId
              ? deleteKiloSession({
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
      const runtime = yield* makeKiloAcpRuntime({
        kiloSettings: settings,
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
  configureSession: ({ runtime, modelSelection, operation }) =>
    applyKiloAcpModelSelection({
      runtime,
      model: modelSelection.model,
      mapError: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Failed to set Kilo ACP base model for text generation.",
          cause,
        }),
    }),
});
