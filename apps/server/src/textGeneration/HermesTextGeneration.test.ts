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
import { HermesSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeHermesTextGeneration } from "./HermesTextGeneration.ts";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const HermesTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpHermesWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const hermesPath = NodePath.join(binDir, "hermes");
  NodeFS.mkdirSync(binDir, { recursive: true });
  // The text-generation finalizer deletes the transient session via
  // `hermes sessions delete`. The ACP mock only speaks JSON-RPC on stdin and
  // would wait there forever, so answer the CLI call directly here.
  NodeFS.writeFileSync(
    hermesPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" = "sessions" ]; then',
      "  exit 0",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(hermesPath, 0o755);
  return hermesPath;
}

function withFakeAcpHermes<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-hermes-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpHermesWrapper(tempDir, env);
    const config = decodeHermesSettings({ binaryPath });
    const textGeneration = yield* makeHermesTextGeneration(config);
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

it.layer(HermesTextGenerationTestLayer)("HermesTextGeneration", (it) => {
  it.effect("generates a commit message without sending the default model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-hermes-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpHermes(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Hermes provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/hermes",
            stagedSummary: "M apps/server/src/provider/Drivers/HermesDriver.ts",
            stagedPatch: "diff --git a/.../HermesDriver.ts b/.../HermesDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), "default"),
          });

          expect(generated.subject).toBe("Add Hermes provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(requests.some((request) => request.method === "session/set_model")).toBe(false);
        }),
    );
  });

  it.effect("extracts the JSON object when Hermes wraps it in conversational text", () =>
    withFakeAcpHermes(
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
            modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), "default"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );
});
