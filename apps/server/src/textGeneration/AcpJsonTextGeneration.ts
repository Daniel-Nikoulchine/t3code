/**
 * AcpJsonTextGeneration — the structured-output text generation loop every
 * ACP harness repeats.
 *
 * Ten harnesses (Copilot, DeepSeek, Kilo, Droid, Devin, Cline, Grok, Hermes,
 * OpenClaw, MiniMax) carried this identical ~200-line core: spawn an ACP
 * runtime, collect `agent_message_chunk` text, prompt with 180s timeout,
 * extract the JSON object, and decode it — plus the same four methods
 * (commit message, PR content, branch name, thread title) over the shared
 * prompt builders. The only per-harness inputs are the runtime factory, the
 * post-start session configuration (model selection, mode switches, login
 * timeouts), and the provider label in error texts.
 *
 * Deliberately NOT covered: Claude/Codex/OpenCode-style harnesses with
 * native (non-ACP) text generation, and Grok's prompt-completion runtime
 * only insofar as it shares this shape (it does — same chunk loop).
 *
 * @module textGeneration/AcpJsonTextGeneration
 */
import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import type { AcpSessionRuntimeStartResult } from "../provider/acp/AcpSessionRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

export type AcpJsonOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export type AcpJsonRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"];

export interface AcpJsonMakeRuntimeArgs<S> {
  readonly settings: S;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelSelection: ModelSelection;
}

/**
 * Runtime plus an optional post-start hook. Harnesses with probe sessions
 * worth deleting (Kilo, Hermes, OpenClaw) register their own scope
 * finalizer inside `makeRuntime` and stash the session id here; the shared
 * loop only calls the hook.
 */
export interface AcpJsonRuntimeHandle {
  readonly runtime: AcpJsonRuntime;
  readonly onSessionStarted?: (sessionId: string) => Effect.Effect<void>;
}

export interface AcpJsonConfigureArgs {
  readonly runtime: AcpJsonRuntime;
  readonly started: AcpSessionRuntimeStartResult;
  readonly modelSelection: ModelSelection;
  readonly operation: AcpJsonOperation;
}

export interface AcpJsonTextGenerationConfig<S, R> {
  /** Provider label used in every error text (`"<label> ACP request timed out."`). */
  readonly providerLabel: string;
  /** Timeout override; every harness uses 180s today. */
  readonly timeoutMs?: number;
  /** Timeout text override (Devin: `"Devin Agent request timed out."`). */
  readonly timedOutDetail?: string;
  readonly makeRuntime: (
    args: AcpJsonMakeRuntimeArgs<S>,
  ) => Effect.Effect<AcpJsonRuntimeHandle, EffectAcpErrors.AcpError, R>;
  /**
   * Start the session. Defaults to a bare `runtime.start()` whose ACP
   * errors the shared mapping turns into `"<label> ACP request failed."`.
   * Droid overrides it with an authentication-aware start timeout (which is
   * why the hook sees the operation for its error text).
   */
  readonly startSession?: (args: {
    readonly runtime: AcpJsonRuntime;
    readonly operation: AcpJsonOperation;
  }) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError | TextGenerationError>;
  /**
   * Post-start configuration before prompting: model selection, mode
   * switches. Absent for harnesses that configure at spawn (Copilot).
   * Errors must already be `TextGenerationError`.
   */
  readonly configureSession?: (
    args: AcpJsonConfigureArgs,
  ) => Effect.Effect<void, TextGenerationError>;
}

/** Shared `TextGenerationError` passthrough check for session hooks. */
export const isAcpTextGenerationError = Schema.is(TextGenerationError);

const DEFAULT_TIMEOUT_MS = 180_000;

export const makeAcpJsonTextGeneration = <S, R>(config: AcpJsonTextGenerationConfig<S, R>) =>
  Effect.fn("AcpJsonTextGeneration")(function* (
    settings: S,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    const crypto = yield* Crypto.Crypto;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timedOutDetail =
      config.timedOutDetail ?? `${config.providerLabel} ACP request timed out.`;
    const startSession =
      config.startSession ??
      (({ runtime }: { readonly runtime: AcpJsonRuntime }) => runtime.start());

    const runJson = <S extends Schema.Top>({
      operation,
      cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
    }: {
      operation: AcpJsonOperation;
      cwd: string;
      prompt: string;
      outputSchemaJson: S;
      modelSelection: ModelSelection;
    }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const outputRef = yield* Ref.make("");
        const { runtime, onSessionStarted } = yield* config
          .makeRuntime({ settings, cwd, environment, modelSelection })
          .pipe(Effect.provideService(Crypto.Crypto, crypto));

        yield* runtime.handleSessionUpdate((notification) => {
          const update: EffectAcpSchema.SessionNotification["update"] = notification.update;
          if (update.sessionUpdate !== "agent_message_chunk") {
            return Effect.void;
          }
          const content = update.content;
          if (content.type !== "text") {
            return Effect.void;
          }
          return Ref.update(outputRef, (current) => current + content.text);
        });

        const promptResult = yield* Effect.gen(function* () {
          const started = yield* startSession({ runtime, operation });
          if (onSessionStarted !== undefined) {
            yield* onSessionStarted(started.sessionId);
          }
          if (config.configureSession !== undefined) {
            yield* config.configureSession({ runtime, started, modelSelection, operation });
          }

          return yield* runtime.prompt({
            prompt: [{ type: "text", text: prompt }],
          });
        }).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new TextGenerationError({ operation, detail: timedOutDetail })),
              onSome: (value) => Effect.succeed(value),
            }),
          ),
          Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
            isAcpTextGenerationError(cause)
              ? cause
              : new TextGenerationError({
                  operation,
                  detail: `${config.providerLabel} ACP request failed.`,
                  cause,
                }),
          ),
        );

        const trimmed = (yield* Ref.get(outputRef)).trim();
        if (!trimmed) {
          return yield* new TextGenerationError({
            operation,
            detail:
              promptResult.stopReason === "cancelled"
                ? `${config.providerLabel} ACP request was cancelled.`
                : `${config.providerLabel} Agent returned empty output.`,
          });
        }

        const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
        return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
          Effect.catchTags({
            SchemaError: (cause) =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: `${config.providerLabel} Agent returned invalid structured output.`,
                  cause,
                }),
              ),
          }),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isAcpTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: `${config.providerLabel} ACP text generation failed.`,
                cause,
              }),
        ),
        Effect.scoped,
      );

    const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
      Effect.fn("AcpJsonTextGeneration.generateCommitMessage")(function* (input) {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });

        const generated = yield* runJson({
          operation: "generateCommitMessage",
          cwd: input.cwd,
          prompt,
          outputSchemaJson: outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        };
      });

    const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
      Effect.fn("AcpJsonTextGeneration.generatePrContent")(function* (input) {
        const { prompt, outputSchema } = buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        });

        const generated = yield* runJson({
          operation: "generatePrContent",
          cwd: input.cwd,
          prompt,
          outputSchemaJson: outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          title: sanitizePrTitle(generated.title),
          body: generated.body.trim(),
        };
      });

    const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
      Effect.fn("AcpJsonTextGeneration.generateBranchName")(function* (input) {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        });

        const generated = yield* runJson({
          operation: "generateBranchName",
          cwd: input.cwd,
          prompt,
          outputSchemaJson: outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          branch: sanitizeBranchFragment(generated.branch),
        };
      });

    const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
      Effect.fn("AcpJsonTextGeneration.generateThreadTitle")(function* (input) {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          attachments: input.attachments,
        });

        const generated = yield* runJson({
          operation: "generateThreadTitle",
          cwd: input.cwd,
          prompt,
          outputSchemaJson: outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          title: sanitizeThreadTitle(generated.title),
        } satisfies TextGeneration.ThreadTitleGenerationResult;
      });

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    } satisfies TextGeneration.TextGeneration["Service"];
  });
