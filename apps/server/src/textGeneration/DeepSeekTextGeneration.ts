import { type DeepSeekSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { TextGenerationError } from "@t3tools/contracts";
import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  applyDeepSeekAcpModelSelection,
  currentDeepSeekModelIdFromSessionSetup,
  currentDeepSeekReasoningEffortFromSessionSetup,
  makeDeepSeekAcpRuntime,
  resolveDeepSeekAcpBaseModelId,
} from "../provider/acp/DeepSeekAcpSupport.ts";

export const makeDeepSeekTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "DeepSeek",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<DeepSeekSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeDeepSeekAcpRuntime({
        deepseekSettings: settings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return { runtime };
    }),
  configureSession: ({ runtime, started, modelSelection, operation }) =>
    Effect.gen(function* () {
      const resolvedModel = resolveDeepSeekAcpBaseModelId(modelSelection.model);
      const requestedReasoningEffort = getModelSelectionStringOptionValue(
        modelSelection,
        "reasoningEffort",
      );
      yield* applyDeepSeekAcpModelSelection({
        runtime,
        currentModelId: currentDeepSeekModelIdFromSessionSetup(started.sessionSetupResult),
        currentReasoningEffort: currentDeepSeekReasoningEffortFromSessionSetup(
          started.sessionSetupResult,
        ),
        requestedModelId: resolvedModel,
        requestedReasoningEffort,
        mapError: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to set DeepSeek ACP base model for text generation.",
            cause,
          }),
      });
    }),
});
