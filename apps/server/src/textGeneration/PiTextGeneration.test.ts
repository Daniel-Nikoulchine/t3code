// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";

import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/pi-rpc-mock-agent.ts");

async function makeMockPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-textgen-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-pi.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

it.layer(NodeServices.layer)("PiTextGeneration", (it) => {
  it.effect("generates a thread title through pi print mode", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_PRINT_OUTPUT: '{"title": "  Mock Title  "}' }),
      );
      const textGeneration = yield* makePiTextGeneration(
        decodePiSettings({ binaryPath, enabled: true }),
        process.env,
      );
      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "hello",
        modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
      });
      assert.equal(result.title, "Mock Title");
    }),
  );

  it.effect("routes explicit provider/model slugs to pi flags", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-textgen-log-")),
      );
      const requestLog = NodePath.join(dir, "requests.jsonl");
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({
          PI_MOCK_PRINT_OUTPUT: '{"title": "X"}',
          PI_MOCK_REQUEST_LOG: requestLog,
        }),
      );
      const textGeneration = yield* makePiTextGeneration(
        decodePiSettings({ binaryPath, enabled: true }),
        process.env,
      );
      yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "mock-provider/mock-model",
        },
      });
      const logged = yield* Effect.promise(() => NodeFSP.readFile(requestLog, "utf8"));
      // @effect-diagnostics-next-line preferSchemaOverJson:off - test reads the mock's JSONL log.
      const entry = JSON.parse(logged.trim().split("\n")[0] ?? "{}") as { args?: unknown };
      assert.includeMembers(entry.args as Array<string>, [
        "--provider",
        "mock-provider",
        "--model",
        "mock-model",
      ]);
    }),
  );

  it.effect("surfaces invalid structured output as a generation error", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_PRINT_OUTPUT: "not json at all" }),
      );
      const textGeneration = yield* makePiTextGeneration(
        decodePiSettings({ binaryPath, enabled: true }),
        process.env,
      );
      const exit = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "hello",
          modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
