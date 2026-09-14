// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { DeepSeekSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeDeepSeekTextGeneration } from "./DeepSeekTextGeneration.ts";
const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const DeepSeekTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-deepseek-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpDeepSeekWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const deepseekPath = NodePath.join(binDir, "deepseek");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    deepseekPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "--profile" ] || [ "$2" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(deepseekPath, 0o755);
  return deepseekPath;
}

function withFakeAcpDeepSeek<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-deepseek-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpDeepSeekWrapper(tempDir, { T3_ACP_DEEPSEEK: "1", ...env });
    const config = decodeDeepSeekSettings({ binaryPath });
    const textGeneration = yield* makeDeepSeekTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(DeepSeekTextGenerationTestLayer)("DeepSeekTextGeneration", (it) => {
  it.effect("uses ACP with disabled tool capabilities and forwards the requested model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-deepseek-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpDeepSeek(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add DeepSeek provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/deepseek",
            stagedSummary: "M apps/server/src/provider/Drivers/DeepSeekDriver.ts",
            stagedPatch: "diff --git a/.../DeepSeekDriver.ts b/.../DeepSeekDriver.ts",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("deepseek"),
              "deepseek-v4-pro",
            ),
          });

          expect(generated.subject).toBe("Add DeepSeek provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                (request.params as { configId?: string } | undefined)?.configId === "model" &&
                (request.params as { value?: string } | undefined)?.value ===
                  '["deepseek-official","deepseek-v4-pro"]',
            ),
          ).toBe(true);
          expect(requests.some((request) => request.method === "session/set_model")).toBe(false);
        }),
    );
  });

  it.effect("extracts the JSON object when DeepSeek wraps it in conversational text", () =>
    withFakeAcpDeepSeek(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("deepseek"),
              "deepseek-v4-pro",
            ),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("surfaces ACP request failures as text generation errors", () =>
    withFakeAcpDeepSeek(
      {
        T3_ACP_FAIL_SET_CONFIG_OPTION: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up deepseek",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("deepseek"),
                "deepseek-v4-pro",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("DeepSeek ACP base model");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAcpDeepSeek(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("deepseek"),
                "deepseek-v4-flash",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );

  it.effect("decodes a structured PR title + body", () =>
    withFakeAcpDeepSeek(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "feat(deepseek): wire up session/set_config_option",
          body: "## Summary\n- Select the model through the typed ACP `session/set_config_option`.\n- Translate `MODEL_SWITCH_INCOMPATIBLE_AGENT` into a validation error.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feat/deepseek-provider",
            commitSummary: "feat: add deepseek provider",
            diffSummary: "M apps/server/src/provider/Drivers/DeepSeekDriver.ts",
            diffPatch: "diff --git a/.../DeepSeekDriver.ts b/.../DeepSeekDriver.ts",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("deepseek"),
              "deepseek-v4-flash",
            ),
          });

          expect(generated.title).toBe("feat(deepseek): wire up session/set_config_option");
          expect(generated.body).toContain("Translate `MODEL_SWITCH_INCOMPATIBLE_AGENT`");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    withFakeAcpDeepSeek(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "totally not json output from a confused model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("deepseek"),
                "deepseek-v4-flash",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );
});
