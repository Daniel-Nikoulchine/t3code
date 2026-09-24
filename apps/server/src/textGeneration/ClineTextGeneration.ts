import { type ClineSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "@t3tools/contracts";
import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  applyClineAcpModelSelection,
  makeClineAcpRuntime,
} from "../provider/acp/ClineAcpSupport.ts";

export const makeClineTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "Cline",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<ClineSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeClineAcpRuntime({
        clineSettings: settings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return { runtime };
    }),
  configureSession: ({ runtime, modelSelection, operation }) =>
    Effect.gen(function* () {
      yield* applyClineAcpModelSelection({
        runtime,
        model: modelSelection.model,
        mapError: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to set Cline ACP base model for text generation.",
            cause,
          }),
      });
      // Plan mode is read-only: text generation must never edit files or
      // run commands as a side effect of summarizing a diff.
      yield* runtime.setMode("plan").pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to configure Cline for text generation.",
              cause,
            }),
        ),
      );
    }),
});
