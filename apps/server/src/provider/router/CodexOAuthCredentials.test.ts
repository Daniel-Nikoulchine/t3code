// @effect-diagnostics nodeBuiltinImport:off
// Unit coverage for the Codex OAuth token source: the harness's own
// `codex app-server` RPC is the only way a bearer token is minted, and the
// account-id header comes from decoding the token — never from settings.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { decodeTokenClaims, resolveCodexOAuthCredentials } from "./CodexOAuthCredentials.ts";

const accountToken =
  "header." +
  Buffer.from(
    JSON.stringify({
      email: "dev@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    }),
  )
    .toString("base64url")
    .replace(/=+$/, "") +
  ".sig";

const noSpawn = ChildProcessSpawner.make(() => Effect.die("no spawn in this test"));

describe("decodeTokenClaims", () => {
  it("extracts the ChatGPT account id and email from the access token", () => {
    const claims = decodeTokenClaims(accountToken);
    expect(claims?.chatgptAccountId).toBe("acct-123");
    expect(claims?.email).toBe("dev@example.com");
  });

  it("returns undefined for non-JWT tokens", () => {
    expect(decodeTokenClaims("not-a-jwt")).toBeUndefined();
  });
});

const decodeRequestLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const encodeResponseLine = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeAuthSpawner = Effect.fn("makeAuthSpawner")(function* (authToken: string | null) {
  const output = yield* Queue.unbounded<Uint8Array>();
  const requests: Array<{ method: string; params?: unknown }> = [];
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((bytes: Uint8Array) =>
      Effect.gen(function* () {
        for (const line of new TextDecoder().decode(bytes).trim().split("\n")) {
          const request = decodeRequestLine(line);
          requests.push(request);
          if (request.id === undefined) continue;
          const result =
            request.method === "initialize"
              ? {
                  userAgent: "test-codex",
                  codexHome: "/tmp/codex-test",
                  platformFamily: "unix",
                  platformOs: "linux",
                }
              : { authMethod: "chatgpt", authToken, requiresOpenaiAuth: true };
          yield* Queue.offer(
            output,
            new TextEncoder().encode(`${encodeResponseLine({ id: request.id, result })}\n`),
          );
        }
      }),
    ),
    stdout: Stream.fromQueue(output),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  return { spawner: ChildProcessSpawner.make(() => Effect.succeed(handle)), requests };
});

describe("resolveCodexOAuthCredentials", () => {
  it.effect("reads refreshed credentials through the app-server handshake", () =>
    Effect.gen(function* () {
      const fake = yield* makeAuthSpawner(accountToken);
      const credentials = yield* resolveCodexOAuthCredentials({ binaryPath: "codex" }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      expect(credentials).toEqual({
        authToken: accountToken,
        chatgptAccountId: "acct-123",
        email: "dev@example.com",
      });
      expect(fake.requests.map((request) => request.method)).toEqual([
        "initialize",
        "initialized",
        "getAuthStatus",
      ]);
      expect(fake.requests.at(-1)?.params).toEqual({ includeToken: true, refreshToken: true });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a missing login", () =>
    Effect.gen(function* () {
      const fake = yield* makeAuthSpawner(null);
      const outcome = yield* resolveCodexOAuthCredentials({ binaryPath: "codex" }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
        Effect.result,
      );
      expect(outcome._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );
  it.effect("fails cleanly when the harness cannot answer", () =>
    Effect.gen(function* () {
      const outcome = yield* resolveCodexOAuthCredentials({
        binaryPath: "/nonexistent/codex",
      }).pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );
});
