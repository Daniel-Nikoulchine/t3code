// @effect-diagnostics nodeBuiltinImport:off - test file utilities (temp dirs, log reads, script paths).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  defaultZcodePermissionOptionId,
  makeZcodeAppServer,
  requestZcodeAppServerOnce,
  type ZcodeNotification,
} from "./ZcodeSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/zcode-mock-app-server.mjs");

const mockEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  ...extra,
});

describe("ZcodeSessionRuntime", () => {
  it.effect("answers runtime-preference probes and returns readState models", () =>
    Effect.gen(function* () {
      const result = (yield* requestZcodeAppServerOnce({
        command: "node",
        args: [mockAgentPath],
        cwd: process.cwd(),
        env: mockEnv(),
        method: "workspace/readState",
        params: { workspace: { workspaceKey: "/tmp", workspacePath: "/tmp" } },
        timeoutMs: 15_000,
      })) as {
        modelCatalog: { available: Array<{ ref: { modelId: string; providerId: string } }> };
      };
      expect(result.modelCatalog.available.map((model) => model.ref.modelId)).toEqual([
        "glm-5.2",
        "glm-5-turbo",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("streams turn notifications around session/send", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeZcodeAppServer({
          command: "node",
          args: [mockAgentPath],
          cwd: process.cwd(),
          env: mockEnv(),
        });
        const notifications: Array<ZcodeNotification> = [];
        const terminal = yield* Deferred.make<void>();
        yield* server.notifications.pipe(
          Stream.runForEach((notification) =>
            Effect.gen(function* () {
              notifications.push(notification);
              if (
                notification.method === "v4/telemetry/event" &&
                (notification.params as { kind?: string })?.kind === "turn.terminal"
              ) {
                yield* Deferred.succeed(terminal, undefined);
              }
            }),
          ),
          Effect.forkScoped,
        );

        const created = (yield* server.request("session/create", {
          workspace: { workspaceKey: "/tmp", workspacePath: "/tmp" },
        })) as { session: { sessionId: string } };
        expect(created.session.sessionId).toBe("sess_mock-0001");

        const accepted = (yield* server.request("session/send", {
          sessionId: created.session.sessionId,
          content: "hello",
        })) as { accepted: boolean };
        expect(accepted.accepted).toBe(true);

        yield* Deferred.await(terminal);

        const kinds = notifications.map((notification) => notification.method);
        expect(kinds).toContain("computer-use/operation-event");
        expect(kinds).toContain("v4/telemetry/event");

        const messages = (yield* server.request("session/messages", {
          sessionId: created.session.sessionId,
        })) as { messages: Array<{ parts: Array<{ text: string }> }> };
        expect(messages.messages[0]?.parts[0]?.text).toBe("MOCK-REPLY");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bridges permission requests through the caller handler", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const answerLog = NodePath.join(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-perm-")),
          "answers.ndjson",
        );
        const server = yield* makeZcodeAppServer({
          command: "node",
          args: [mockAgentPath],
          cwd: process.cwd(),
          env: mockEnv({
            T3_ZCODE_MOCK_EMIT_PERMISSION: "1",
            T3_ZCODE_MOCK_ANSWER_LOG_PATH: answerLog,
          }),
          handlers: {
            onPermissionRequest: (params) => Effect.succeed(defaultZcodePermissionOptionId(params)),
          },
        });
        // The mock answers `session/send` before the permission round-trip
        // finishes, and logs the permission answer right before emitting
        // `turn.terminal` — so awaiting the terminal event (no sleeps: the
        // suite runs on a TestClock) guarantees the log line exists.
        const terminal = yield* Deferred.make<void>();
        yield* server.notifications.pipe(
          Stream.runForEach((notification) =>
            notification.method === "v4/telemetry/event" &&
            (notification.params as { kind?: string })?.kind === "turn.terminal"
              ? Deferred.succeed(terminal, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* server.request("session/create", {
          workspace: { workspaceKey: "/tmp", workspacePath: "/tmp" },
        });
        yield* server.request("session/send", { sessionId: "sess_mock-0001", content: "hi" });
        yield* Deferred.await(terminal);
        const logged = NodeFS.readFileSync(answerLog, "utf8").trim().split("\n");
        const permissionLine = logged.find((line) => line.includes("permissionAnswer"));
        expect(permissionLine).toContain(`"optionId":"deny"`);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("picks deny by default for permission options", () => {
    expect(
      defaultZcodePermissionOptionId({
        options: [
          { kind: "allow_once", optionId: "allow_once" },
          { kind: "deny", optionId: "deny" },
        ],
      }),
    ).toBe("deny");
    expect(defaultZcodePermissionOptionId({})).toBe("deny");
  });
});
