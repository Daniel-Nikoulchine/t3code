// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { ProviderInstanceId, ZcodeSettings } from "@t3tools/contracts";

import { makeZcodeTextGeneration } from "./ZcodeTextGeneration.ts";
import * as TextGeneration from "./TextGeneration.ts";

const decodeZcodeSettings = Schema.decodeSync(ZcodeSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/zcode-mock-app-server.mjs");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeZcodeWrapperScript(env: Record<string, string>): string {
  return [
    "#!/bin/sh",
    ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"`,
    "",
  ].join("\n");
}

function withFakeZcode<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-zcode-text-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binDir = NodePath.join(tempDir, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
    const zcodePath = NodePath.join(binDir, "zcode");
    NodeFS.writeFileSync(zcodePath, makeZcodeWrapperScript(env), "utf8");
    NodeFS.chmodSync(zcodePath, 0o755);
    const textGeneration = yield* makeZcodeTextGeneration(
      decodeZcodeSettings({ binaryPath: zcodePath }),
      { ...process.env, ...env },
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(NodeServices.layer)("ZcodeTextGeneration", (it) => {
  it.effect("generates a commit message from mock JSON output", () =>
    withFakeZcode(
      {
        T3_ZCODE_MOCK_REPLY_TEXT: JSON.stringify({
          subject: "Add ZCode provider",
          body: "Wire up the app-server runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/zcode",
            stagedSummary: "M apps/server/src/provider/Drivers/ZcodeDriver.ts",
            stagedPatch: "diff --git a/.../ZcodeDriver.ts b/.../ZcodeDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("zcode"), "glm-5.2"),
          });

          expect(generated.subject).toBe("Add ZCode provider");
          expect(generated.body).toBe(
            "Wire up the app-server runtime and headless text generation path.",
          );
        }),
    ),
  );

  it.effect("extracts the JSON object when ZCode wraps it in conversational text", () =>
    withFakeZcode(
      {
        T3_ZCODE_MOCK_REPLY_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(ProviderInstanceId.make("zcode"), "glm-5.2"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeZcode({ T3_ZCODE_MOCK_REPLY_TEXT: "   \n  " }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "anything",
            modelSelection: createModelSelection(ProviderInstanceId.make("zcode"), "glm-5.2"),
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toMatch(/empty/i);
      }),
    ),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    withFakeZcode(
      { T3_ZCODE_MOCK_REPLY_TEXT: "totally not json output from a confused model" },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("zcode"), "glm-5.2"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );

  it.effect("decodes a structured PR title + body", () =>
    withFakeZcode(
      {
        T3_ZCODE_MOCK_REPLY_TEXT: JSON.stringify({
          title: "feat(zcode): wire up app-server runtime",
          body: "## Summary\n- Add the ZCode provider driver.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feat/zcode-provider",
            commitSummary: "feat: add zcode provider",
            diffSummary: "M apps/server/src/provider/Drivers/ZcodeDriver.ts",
            diffPatch: "diff --git a/.../ZcodeDriver.ts b/.../ZcodeDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("zcode"), "glm-5.2"),
          });

          expect(generated.title).toBe("feat(zcode): wire up app-server runtime");
          expect(generated.body).toContain("Add the ZCode provider driver.");
        }),
    ),
  );
});
