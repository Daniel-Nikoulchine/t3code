// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  DevinSettings,
  ProviderDriverKind,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { DevinAdapterShape } from "../Services/DevinAdapter.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

// Test-local service tag so the rest of the file can keep using `yield* DevinAdapter`.
class DevinAdapter extends Context.Service<DevinAdapter, DevinAdapterShape>()(
  "t3/provider/Layers/DevinAdapter.test/DevinAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath] as const;

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-agent.sh");
  const envExports = Object.entries({ T3_ACP_DEVIN: "1", ...extraEnv })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeProbeWrapper(requestLogPath: string, argvLogPath: string) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-probe-"));
  const wrapperPath = NodePath.join(dir, "fake-agent.sh");
  const script = `#!/bin/sh
printf '%s\t' "$@" >> ${JSON.stringify(argvLogPath)}
printf '\n' >> ${JSON.stringify(argvLogPath)}
export T3_ACP_DEVIN="1"
export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(requestLogPath)}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Tests mutate `ServerSettingsService` mid-flight (e.g. setting
// `providers.devin.binaryPath` to a mock ACP wrapper). The adapter
// captures `devinSettings` once at construction, so without a resolver
// the mutation is invisible — sessions would spawn the constructor's
// (empty) binary path. Wiring `resolveSettings` through
// `ServerSettingsService.getSettings` makes each session read the latest
// snapshot.
const makeResolveDevinSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.devin),
      Effect.orDie,
    ),
  );
});

const devinAdapterTestLayer = it.layer(
  Layer.effect(
    DevinAdapter,
    Effect.gen(function* () {
      const devinConfig = decodeDevinSettings({});
      const resolveSettings = yield* makeResolveDevinSettings;
      return yield* makeDevinAdapter(devinConfig, { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-devin-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

devinAdapterTestLayer("DevinAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "opus" },
      });

      assert.equal(session.provider, "devin");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((e) => e.type);

      for (const t of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const) {
        assert.include(types, t);
      }

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("sends selected project skills in Devin's native slash form", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-skill-dispatch");
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-skill-dispatch-")),
      );
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      const argvLogPath = NodePath.join(workspace, "argv.txt");
      const skillDirectory = NodePath.join(workspace, ".devin", "skills", "review");
      yield* Effect.promise(() => NodeFSP.mkdir(skillDirectory, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(skillDirectory, "SKILL.md"), "# Review\n", "utf8"),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: workspace,
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "opus" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "please $review this",
        attachments: [],
      });
      const snapshot = yield* adapter.readThread(threadId);
      assert.deepStrictEqual(
        snapshot.turns.map((turn) => turn.items),
        [
          [
            {
              prompt: [{ type: "text", text: "please /review this" }],
              result: { stopReason: "end_turn" },
            },
          ],
        ],
      );
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptRequests = requests.filter((entry) => entry.method === "session/prompt");
      assert.deepStrictEqual(
        promptRequests.map(
          (request) => (request.params as Record<string, unknown> | undefined)?.prompt,
        ),
        [
          [
            { type: "text", text: "please /review this" },
            { type: "text", text: buildRuntimeInstructions({ harness: "Devin", model: "opus" }) },
          ],
        ],
      );
    }),
  );

  it.effect("rejects sessions with the wrong provider or a missing cwd", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const wrongProvider = yield* Effect.exit(
        adapter.startSession({
          threadId: ThreadId.make("devin-wrong-provider"),
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );
      assert.isTrue(Exit.isFailure(wrongProvider));

      const missingCwd = yield* Effect.exit(
        adapter.startSession({
          threadId: ThreadId.make("devin-missing-cwd"),
          provider: ProviderDriverKind.make("devin"),
          cwd: "   ",
          runtimeMode: "full-access",
        }),
      );
      assert.isTrue(Exit.isFailure(missingCwd));
    }),
  );

  it.effect("rolls back thread history and interrupts cleanly", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-rollback-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "opus" },
      });
      yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      yield* adapter.sendTurn({ threadId, input: "second", attachments: [] });
      assert.lengthOf((yield* adapter.readThread(threadId)).turns, 2);

      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      assert.lengthOf(rolledBack.turns, 1);

      yield* adapter.interruptTurn(threadId);
      yield* adapter.stopAll();
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );
});
