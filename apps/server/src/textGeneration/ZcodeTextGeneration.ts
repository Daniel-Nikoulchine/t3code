/**
 * ZcodeTextGeneration — commit/PR/branch/title text generation through a
 * short-lived `zcode app-server` session.
 *
 * Each generation spawns one app-server, creates a session pinned to the
 * requested model, sends the structured prompt, waits for `turn.terminal`,
 * reads the assistant text back through `session/messages`, and closes the
 * session again. No approvals are bridged (generation prompts run
 * uninterrupted); a permission request answers itself with the default deny
 * option so the turn degrades to a tool error instead of hanging.
 *
 * @module textGeneration/ZcodeTextGeneration
 */
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type ModelSelection, type ZcodeSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
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
import { resolveZcodeModelRef } from "../provider/Layers/ZcodeAdapter.ts";
import { makeZcodeAppServer } from "../provider/Layers/ZcodeSessionRuntime.ts";

const ZCODE_TEXT_GENERATION_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantTextFromMessages(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.messages)) {
    return "";
  }
  const chunks: string[] = [];
  for (const entry of result.messages) {
    if (!isRecord(entry) || !isRecord(entry.info) || entry.info.role !== "assistant") {
      continue;
    }
    if (!Array.isArray(entry.parts)) {
      continue;
    }
    for (const part of entry.parts) {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        continue;
      }
      chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

export const makeZcodeTextGeneration = Effect.fn("makeZcodeTextGeneration")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runZcodeJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const modelRef = resolveZcodeModelRef(modelSelection.model);
      const terminal = yield* Deferred.make<{ status: string; errorMessage?: string }>();
      const server = yield* makeZcodeAppServer({
        command: zcodeSettings.binaryPath || "zcode",
        cwd,
        env: environment,
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to start ZCode text generation session.",
              cause,
            }),
        ),
      );

      const failGeneration = (detail: string, cause?: unknown) =>
        new TextGenerationError({ operation, detail, ...(cause ? { cause } : {}) });

      const created = (yield* server
        .request("session/create", {
          workspace: { workspaceKey: cwd, workspacePath: cwd },
          model: modelRef,
        })
        .pipe(
          Effect.mapError((cause) =>
            failGeneration("Failed to create ZCode text generation session.", cause),
          ),
        )) as unknown;
      const sessionId =
        isRecord(created) && isRecord(created.session)
          ? typeof created.session.sessionId === "string"
            ? created.session.sessionId
            : undefined
          : undefined;
      if (!sessionId) {
        return yield* failGeneration("ZCode session/create returned no sessionId.");
      }

      yield* server.notifications.pipe(
        Stream.runForEach((notification) => {
          if (
            notification.method !== "v4/telemetry/event" ||
            !isRecord(notification.params) ||
            notification.params.kind !== "turn.terminal"
          ) {
            return Effect.void;
          }
          const params = notification.params;
          return Deferred.succeed(terminal, {
            status: typeof params.status === "string" ? params.status : "failed",
            ...(typeof params.errorMessage === "string"
              ? { errorMessage: params.errorMessage }
              : {}),
          }).pipe(Effect.ignore);
        }),
        Effect.forkScoped,
      );

      const sendResult = yield* server
        .request("session/send", { sessionId, content: prompt })
        .pipe(
          Effect.mapError((cause) =>
            failGeneration(`Failed to send ZCode text generation prompt: ${cause.message}`, cause),
          ),
        );
      void sendResult;

      const outcome = yield* Deferred.await(terminal).pipe(
        Effect.timeoutOption(ZCODE_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failGeneration("ZCode text generation timed out.")),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      const messages = yield* server.request("session/messages", { sessionId }).pipe(
        Effect.orElseSucceed(() => ({ messages: [] }) as unknown),
        Effect.mapError((cause) =>
          failGeneration("Failed to read ZCode generation output.", cause),
        ),
      );
      yield* server.request("session/close", { sessionId }).pipe(Effect.ignore);

      if (outcome.status !== "completed") {
        return yield* failGeneration(
          outcome.errorMessage?.trim() || "ZCode text generation turn failed.",
        );
      }

      const trimmed = assistantTextFromMessages(messages);
      if (!trimmed) {
        return yield* failGeneration("ZCode returned empty output.");
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(failGeneration("ZCode returned invalid structured output.", cause)),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "ZCode text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("ZcodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runZcodeJson({
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
    Effect.fn("ZcodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runZcodeJson({
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
    Effect.fn("ZcodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runZcodeJson({
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
    Effect.fn("ZcodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runZcodeJson({
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
