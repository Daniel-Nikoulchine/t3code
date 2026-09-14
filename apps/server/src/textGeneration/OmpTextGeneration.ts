import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type ModelSelection, type OmpSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

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
import { getOmpReasoningEffort } from "../provider/Layers/OmpAdapter.ts";
import { resolveOmpAgentDir } from "../provider/Layers/OmpAdapter.ts";
import { splitProviderModel } from "../provider/pi/PiRpcProtocol.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";

const OMP_TEXT_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Resolve one-shot CLI flags for a text-generation call. The harness
 * default (`default`) means "no flag" so pi/omp falls back to its own
 * configured provider/model.
 */
export function resolveOmpTextFlags(input: {
  readonly settings: OmpSettings;
  readonly modelSelection: ModelSelection;
}): ReadonlyArray<string> {
  const flags: string[] = ["-p", "--no-session"];
  const selectionModel = input.modelSelection.model.trim();
  const model =
    selectionModel && selectionModel !== "default" ? selectionModel : input.settings.model.trim();
  const { provider } = model ? splitProviderModel(model) : { provider: undefined };
  const settingsProvider = input.settings.provider.trim();
  const effectiveProvider = provider ?? (settingsProvider || undefined);
  if (effectiveProvider) flags.push("--provider", effectiveProvider);
  // pi accepts `provider/id` in --model; keep the full reference.
  if (model) flags.push("--model", model);
  const thinking =
    getOmpReasoningEffort(input.modelSelection) ?? input.settings.thinkingLevel.trim() ?? undefined;
  if (thinking) flags.push("--thinking", thinking);
  return flags;
}

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runOmpJson = <S extends Schema.Top>({
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
      const flags = [...resolveOmpTextFlags({ settings: ompSettings, modelSelection })];
      const command = ompSettings.binaryPath || "omp";
      const env = resolveOmpAgentDir(ompSettings, environment);
      const spawnCommand = yield* resolveSpawnCommand(command, flags, { env }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Oh-My-Pi text call failed to spawn.",
              cause,
            }),
        ),
      );
      const collected = yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, [...spawnCommand.args, prompt], {
          cwd,
          env,
          shell: spawnCommand.shell,
        }),
      ).pipe(
        Effect.timeoutOption(OMP_TEXT_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Oh-My-Pi text call timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({ operation, detail: "Oh-My-Pi text call failed.", cause }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      );

      if (collected.code !== 0) {
        const detail = `${collected.stdout}\n${collected.stderr}`.trim().slice(0, 2000);
        return yield* new TextGenerationError({
          operation,
          detail: detail || "Oh-My-Pi text call exited non-zero.",
        });
      }
      const trimmed = collected.stdout.trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "Oh-My-Pi returned empty output.",
        });
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Oh-My-Pi returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Oh-My-Pi text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OmpTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runOmpJson({
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
    Effect.fn("OmpTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runOmpJson({
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
    Effect.fn("OmpTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runOmpJson({
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
    Effect.fn("OmpTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runOmpJson({
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
