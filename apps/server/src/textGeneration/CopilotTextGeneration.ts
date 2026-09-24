import { type CopilotSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  makeCopilotAcpRuntime,
  resolveCopilotAcpBaseModelId,
} from "../provider/acp/CopilotAcpSupport.ts";

/**
 * Build a Copilot text-generation closure bound to a specific
 * `CopilotSettings` payload. Copilot configures model and effort at spawn
 * (BYOK endpoint mapping), so no post-start session configuration runs —
 * the shared ACP/JSON loop owns everything else.
 */
export const makeCopilotTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "Copilot",
  makeRuntime: ({
    settings,
    cwd,
    environment,
    modelSelection,
  }: AcpJsonMakeRuntimeArgs<CopilotSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const resolvedModel = resolveCopilotAcpBaseModelId(modelSelection.model);
      const requestedEffort =
        getModelSelectionStringOptionValue(modelSelection, "effort") ??
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
      const runtime = yield* makeCopilotAcpRuntime({
        copilotSettings: settings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(requestedEffort ? { effort: requestedEffort } : {}),
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return { runtime };
    }),
});
