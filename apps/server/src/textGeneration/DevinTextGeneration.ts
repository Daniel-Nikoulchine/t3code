import { type DevinSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "@t3tools/contracts";
import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  applyDevinAcpModelSelection,
  currentDevinModelIdFromSessionSetup,
  makeDevinAcpRuntime,
  resolveDevinAcpBaseModelId,
} from "../provider/acp/DevinAcpSupport.ts";

/**
 * Build a Devin text-generation closure bound to a specific `DevinSettings`
 * payload. See `makeCursorAdapter` for the overall per-instance rationale.
 */
export const makeDevinTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "Devin",
  timedOutDetail: "Devin Agent request timed out.",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<DevinSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeDevinAcpRuntime({
        devinSettings: settings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return { runtime };
    }),
  configureSession: ({ runtime, started, modelSelection, operation }) =>
    Effect.gen(function* () {
      yield* Effect.ignore(runtime.setMode("ask"));
      yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: currentDevinModelIdFromSessionSetup(started.sessionSetupResult),
        requestedModelId: resolveDevinAcpBaseModelId(modelSelection.model),
        mapError: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to set Devin ACP base model for text generation.",
            cause,
          }),
      });
    }),
});
