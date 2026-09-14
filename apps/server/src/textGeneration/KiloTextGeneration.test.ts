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
import { KiloSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeKiloTextGeneration } from "./KiloTextGeneration.ts";
const decodeKiloSettings = Schema.decodeSync(KiloSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const KiloTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kilo-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpKiloWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const kiloPath = NodePath.join(binDir, "kilo");
  NodeFS.mkdirSync(binDir, { recursive: true });
  // The text-generation finalizer deletes the transient session via
  // `kilo session delete`. The ACP mock only speaks JSON-RPC on stdin and
  // would wait there forever, so answer the CLI call directly here.
  NodeFS.writeFileSync(
    kiloPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" = "session" ]; then',
      "  exit 0",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(kiloPath, 0o755);
  return kiloPath;
}

function withFakeAcpKilo<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-kilo-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpKiloWrapper(tempDir, env);
    const config = decodeKiloSettings({ binaryPath });
    const textGeneration = yield* makeKiloTextGeneration(config);
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

it.layer(KiloTextGenerationTestLayer)("KiloTextGeneration", (it) => {
  it.effect("generates a commit message without sending the auto model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-kilo-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpKilo(
      {
        T3_ACP_KILO: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Kilo provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/kilo",
            stagedSummary: "M apps/server/src/provider/Drivers/KiloDriver.ts",
            stagedPatch: "diff --git a/.../KiloDriver.ts b/.../KiloDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("kilo"), "auto"),
          });

          expect(generated.subject).toBe("Add Kilo provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(requests.some((request) => request.method === "session/set_model")).toBe(false);
        }),
    );
  });

  it.effect("extracts the JSON object when Kilo wraps it in conversational text", () =>
    withFakeAcpKilo(
      {
        T3_ACP_KILO: "1",
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
            modelSelection: createModelSelection(ProviderInstanceId.make("kilo"), "auto"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );
});
