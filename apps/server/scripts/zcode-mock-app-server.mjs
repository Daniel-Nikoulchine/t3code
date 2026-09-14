#!/usr/bin/env node
// Minimal fake for `zcode app-server` used by ZcodeSessionRuntime tests.
// Speaks the same NDJSON JSON-RPC framing as the real server for the subset
// of methods the tests exercise. No dependencies.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const answerLogPath = process.env.T3_ZCODE_MOCK_ANSWER_LOG_PATH;
const emitPermission = process.env.T3_ZCODE_MOCK_EMIT_PERMISSION === "1";
const failSend = process.env.T3_ZCODE_MOCK_FAIL_SEND === "1";

const logAnswer = (line) => {
  if (answerLogPath) {
    appendFileSync(answerLogPath, `${line}\n`);
  }
};

const send = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

let serverSeq = 0;
const nextServerId = () => `mock-server-${(serverSeq += 1)}`;

// Pending client response resolver: method id -> resolve envelope result.
const pendingServerRequests = new Map();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

const requestClient = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextServerId();
    pendingServerRequests.set(id, { resolve, reject });
    send({ id, method, params });
    setTimeout(() => {
      if (pendingServerRequests.has(id)) {
        pendingServerRequests.delete(id);
        reject(new Error(`mock client request timed out: ${method}`));
      }
    }, 5000);
  });

const SESSION_ID = "sess_mock-0001";

rl.on("line", async (raw) => {
  const line = raw.trim();
  if (!line) {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Answer to one of our server-initiated requests.
  if (
    (typeof msg.id === "string" || typeof msg.id === "number") &&
    ("result" in msg || "error" in msg)
  ) {
    const pending = pendingServerRequests.get(String(msg.id)) ?? pendingServerRequests.get(msg.id);
    if (pending) {
      pendingServerRequests.delete(String(msg.id));
      pendingServerRequests.delete(msg.id);
      if ("error" in msg) {
        pending.reject(new Error(msg.error?.message ?? "mock error"));
      } else {
        logAnswer(JSON.stringify({ id: msg.id, result: msg.result }));
        pending.resolve(msg.result);
      }
    }
    return;
  }
  if (typeof msg.method !== "string") {
    return;
  }
  const { id, method, params } = msg;
  const respond = (result) => send({ id, result });
  try {
    switch (method) {
      case "workspace/readState": {
        respond({
          modelCatalog: {
            available: [
              {
                contextWindow: 1000000,
                label: "GLM-5.2",
                providerLabel: "Z.AI Coding Plan",
                ref: { modelId: "glm-5.2", providerId: "zai" },
              },
              {
                contextWindow: 200000,
                label: "GLM-5-Turbo",
                providerLabel: "Z.AI Coding Plan",
                ref: { modelId: "glm-5-turbo", providerId: "zai" },
              },
            ],
          },
          settings: {
            model: { current: { modelId: "glm-5.2", providerId: "zai" } },
          },
        });
        break;
      }
      case "session/create": {
        await requestClient("session/requestRuntimePreferences", {
          sessionId: SESSION_ID,
          scope: "runtime-materialization",
        });
        respond({
          session: {
            sessionId: SESSION_ID,
            model: { modelId: "glm-5.2", providerId: "zai" },
            mode: "build",
          },
        });
        break;
      }
      case "session/send": {
        if (failSend) {
          send({ id, error: { code: -32000, message: "mock send failed" } });
          break;
        }
        await requestClient("session/requestRuntimePreferences", {
          sessionId: params?.sessionId ?? SESSION_ID,
          scope: "user-execution",
        });
        respond({ accepted: true, sessionId: params?.sessionId ?? SESSION_ID, stateRevision: 1 });
        const turnId = "turn_mock-0001";
        if (emitPermission) {
          const answer = await requestClient("interaction/requestPermission", {
            input: { command: "rm -rf /tmp/mock" },
            reason: "Mock permission",
            requestId: "perm-1",
            sessionId: params?.sessionId ?? SESSION_ID,
            toolCallId: "tool-1",
            toolName: "Bash",
            turnId,
            options: [
              {
                kind: "allow_once",
                name: "Allow once",
                optionId: "allow_once",
                response: { decision: "allow" },
              },
              { kind: "deny", name: "Deny", optionId: "deny", response: { decision: "deny" } },
            ],
          });
          logAnswer(JSON.stringify({ permissionAnswer: answer }));
        }
        send({
          method: "computer-use/operation-event",
          params: { kind: "turn-started", sessionId: params?.sessionId ?? SESSION_ID, turnId },
        });
        send({
          method: "v4/telemetry/event",
          params: {
            kind: "turn.terminal",
            status: "completed",
            sessionId: params?.sessionId ?? SESSION_ID,
            turnId,
          },
        });
        break;
      }
      case "session/messages": {
        respond({
          messages: [
            {
              info: { role: "assistant", messageId: "msg_mock-0001" },
              parts: [{ type: "text", text: process.env.T3_ZCODE_MOCK_REPLY_TEXT ?? "MOCK-REPLY" }],
            },
          ],
        });
        break;
      }
      case "session/stop":
      case "session/close":
      case "session/setModel":
      case "session/setMode": {
        respond({ ok: true });
        break;
      }
      default: {
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    }
  } catch (error) {
    send({ id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
});
