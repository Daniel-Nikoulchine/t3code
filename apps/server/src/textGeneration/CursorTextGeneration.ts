import { type CursorSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "@t3tools/contracts";
import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
} from "../provider/acp/CursorAcpSupport.ts";

/**
 * Build a Cursor text-generation closure bound to a specific `CursorSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCursorTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "Cursor",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<CursorSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeCursorAcpRuntime({
        cursorSettings: settings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return { runtime };
    }),
  configureSession: ({ runtime, modelSelection, operation }) =>
    Effect.gen(function* () {
      yield* Effect.ignore(runtime.setMode("ask"));
      yield* applyCursorAcpModelSelection({
        runtime,
        model: modelSelection.model,
        selections: modelSelection.options,
        mapError: ({ cause, configId, step }) =>
          new TextGenerationError({
            operation,
            detail:
              step === "set-config-option"
                ? `Failed to set Cursor ACP config option "${configId}" for text generation.`
                : "Failed to set Cursor ACP base model for text generation.",
            cause,
          }),
      });
    }),
});
