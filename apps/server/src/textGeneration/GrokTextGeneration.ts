import { type GrokSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { TextGenerationError } from "@t3tools/contracts";
import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  currentGrokReasoningEffortFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../provider/acp/GrokAcpSupport.ts";

export const makeGrokTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "Grok",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<GrokSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeGrokAcpRuntime({
        grokSettings: settings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return { runtime };
    }),
  configureSession: ({ runtime, started, modelSelection, operation }) =>
    Effect.gen(function* () {
      const resolvedModel = resolveGrokAcpBaseModelId(modelSelection.model);
      const requestedReasoningEffort = getModelSelectionStringOptionValue(
        modelSelection,
        "reasoningEffort",
      );
      yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
        currentReasoningEffort: currentGrokReasoningEffortFromSessionSetup(
          started.sessionSetupResult,
        ),
        requestedModelId: resolvedModel,
        requestedReasoningEffort,
        mapError: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to set Grok ACP base model for text generation.",
            cause,
          }),
      });
    }),
});
