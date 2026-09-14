// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { buildPiRpcSpawnArgs, makePiRpcRuntime, type PiRpcEvent } from "./PiRpcRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-rpc-mock-agent.ts");

async function makeMockPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-rpc-mock-"));
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

it("builds rpc spawn args for sessions and one-shot overrides", () => {
  assert.deepStrictEqual(buildPiRpcSpawnArgs({}), ["--mode", "rpc"]);
  assert.deepStrictEqual(buildPiRpcSpawnArgs({ ephemeral: true }), [
    "--mode",
    "rpc",
    "--no-session",
  ]);
  assert.deepStrictEqual(
    buildPiRpcSpawnArgs({
      sessionDir: "/tmp/pi-sessions",
      provider: "openai",
      modelId: "gpt-5-nano",
      thinkingLevel: "off",
      appendSystemPrompts: ["be nice", "  "],
    }),
    [
      "--mode",
      "rpc",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "openai",
      "--model",
      "gpt-5-nano",
      "--thinking",
      "off",
      "--append-system-prompt",
      "be nice",
    ],
  );
});

it.layer(NodeServices.layer)("PiRpcRuntime", (it) => {
  it.effect("lists models and reports state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
        const runtime = yield* makePiRpcRuntime({
          binaryPath,
          cwd: process.cwd(),
          environment: process.env,
          ephemeral: true,
        }).pipe(Effect.orDie);

        const models = yield* runtime.getAvailableModels().pipe(Effect.orDie);
        assert.equal(models.length, 2);
        assert.equal(models[0]?.id, "mock-model");
        assert.equal(models[0]?.provider, "mock-provider");

        const state = yield* runtime.getState().pipe(Effect.orDie);
        assert.equal((state.model as { id?: unknown } | undefined)?.id, "mock-model");
      }),
    ),
  );

  it.effect("streams a prompt turn through to agent_end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* Effect.promise(() =>
          makeMockPiWrapper({ PI_MOCK_TOOLS: "1", PI_MOCK_TEXT: "streamed reply" }),
        );
        const runtime = yield* makePiRpcRuntime({
          binaryPath,
          cwd: process.cwd(),
          environment: process.env,
          ephemeral: true,
        }).pipe(Effect.orDie);

        const events: PiRpcEvent[] = [];
        const agentEnd = yield* Deferred.make<void>();
        const fiber = yield* Stream.runForEach(runtime.events, (event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "agent_end" ? Deferred.succeed(agentEnd, undefined) : Effect.void,
            ),
          ),
        ).pipe(Effect.forkScoped);

        const response = yield* runtime.prompt("hello pi").pipe(Effect.orDie);
        assert.isTrue(response.success);
        yield* Deferred.await(agentEnd);

        const types = events.map((event) => event.type);
        assert.includeMembers(types, [
          "agent_start",
          "turn_start",
          "message_update",
          "tool_execution_start",
          "tool_execution_end",
          "agent_end",
        ]);
        const delta = events.find(
          (event) =>
            event.type === "message_update" &&
            (event.assistantMessageEvent as { type?: unknown } | undefined)?.type === "text_delta",
        );
        assert.isDefined(delta);
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      }),
    ),
  );

  it.effect("aborts without hanging and sends fire-and-forget notifies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
        const runtime = yield* makePiRpcRuntime({
          binaryPath,
          cwd: process.cwd(),
          environment: process.env,
          ephemeral: true,
        }).pipe(Effect.orDie);

        const abort = yield* runtime.abort().pipe(Effect.orDie);
        assert.isTrue(abort.success);

        // extension_ui_response is fire-and-forget: no response is expected.
        yield* runtime.notify({ type: "extension_ui_response", id: "dlg-1", cancelled: true });

        const failure = yield* runtime
          .send({ type: "definitely-not-a-pi-command" })
          .pipe(Effect.orDie);
        assert.isFalse(failure.success);
      }),
    ),
  );
});
