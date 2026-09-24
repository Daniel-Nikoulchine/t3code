import { type MinimaxSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "@t3tools/contracts";
import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  applyMinimaxAcpModelSelection,
  makeMinimaxAcpRuntime,
} from "../provider/acp/MinimaxAcpSupport.ts";

export const makeMinimaxTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "MiniMax",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<MinimaxSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const probeEnvironment = {
        ...environment,
      };
      const runtime = yield* makeMinimaxAcpRuntime({
        minimaxSettings: settings,
        environment: probeEnvironment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return { runtime };
    }),
  configureSession: ({ runtime, modelSelection, operation }) =>
    applyMinimaxAcpModelSelection({
      runtime,
      model: modelSelection.model,
      mapError: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Failed to set MiniMax ACP base model for text generation.",
          cause,
        }),
    }),
});
