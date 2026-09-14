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

import { DevinSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeDevinTextGeneration } from "./DevinTextGeneration.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const DevinTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpAgentWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const agentPath = NodePath.join(binDir, "devin");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    agentPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec node ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(agentPath, 0o755);
  return agentPath;
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const agentPath = makeAcpAgentWrapper(tempDir, { T3_ACP_DEVIN: "1", ...env });
    const config = decodeDevinSettings({ binaryPath: agentPath });
    const textGeneration = yield* makeDevinTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(DevinTextGenerationTestLayer)("DevinTextGeneration", (it) => {
  it.effect("generates a commit message through the Devin ACP runtime", () =>
    withFakeAcpAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Devin provider wiring",
          body: "- verify devin acp text generation",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/devin-provider",
            stagedSummary: "M apps/server/src/textGeneration/DevinTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/textGeneration/DevinTextGeneration.ts b/apps/server/src/textGeneration/DevinTextGeneration.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "opus"),
          });
          expect(generated.subject).toBe("Add Devin provider wiring");
          expect(generated.body).toContain("verify devin acp text generation");
        }),
    ),
  );

  it.effect("generates a thread title through the Devin ACP runtime", () =>
    withFakeAcpAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Devin provider review" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "implement devin as a provider",
            modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "opus"),
          });
          expect(generated.title).toBe("Devin provider review");
        }),
    ),
  );
});
