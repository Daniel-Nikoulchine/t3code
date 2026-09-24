import { type OpenClawSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "@t3tools/contracts";
import { makeAcpJsonTextGeneration, type AcpJsonMakeRuntimeArgs } from "./AcpJsonTextGeneration.ts";
import {
  applyOpenClawAcpModelSelection,
  deleteOpenClawSession,
  makeOpenClawAcpRuntime,
} from "../provider/acp/OpenClawAcpSupport.ts";

export const makeOpenClawTextGeneration = makeAcpJsonTextGeneration({
  providerLabel: "OpenClaw",
  makeRuntime: ({ settings, cwd, environment }: AcpJsonMakeRuntimeArgs<OpenClawSettings>) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const sessionIdRef = yield* Ref.make<string | undefined>(undefined);
      const probeEnvironment = {
        ...environment,
        OPENCLAW_ACP_SKIP_CONFIGURED_MCP: "1",
      };
      yield* Effect.addFinalizer(() =>
        Ref.get(sessionIdRef).pipe(
          Effect.flatMap((sessionId) =>
            sessionId
              ? deleteOpenClawSession({
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
      const runtime = yield* makeOpenClawAcpRuntime({
        openclawSettings: settings,
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
    Effect.gen(function* () {
      yield* applyOpenClawAcpModelSelection({
        runtime,
        model: modelSelection.model,
        mapError: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to set OpenClaw ACP base model for text generation.",
            cause,
          }),
      });
      // The bridge documents only partial `session/set_mode` support;
      // a rejected mode must not fail commit/PR/title generation.
      yield* runtime.setMode("default").pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to configure OpenClaw approval mode for text generation.",
              cause,
            }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Failed to set OpenClaw session mode for text generation; continuing with bridge default.",
            { cause },
          ),
        ),
      );
    }),
});
