import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  OpenCodeRuntimeLive,
  mergeOpenCodeBackendConfigContent,
  resolveOpenCodeConfigContent,
  resolveOpenCodeServerPassword,
  verifyOpenCodeServerVersion,
} from "./opencodeRuntime.ts";

describe("resolveOpenCodeConfigContent", () => {
  it("prefers the caller environment over the inherited environment", () => {
    expect(
      resolveOpenCodeConfigContent(
        { OPENCODE_CONFIG_CONTENT: '{"source":"caller"}' },
        { OPENCODE_CONFIG_CONTENT: '{"source":"process"}' },
      ),
    ).toBe('{"source":"caller"}');
  });

  it("falls back to the inherited environment and then an empty config", () => {
    expect(
      resolveOpenCodeConfigContent(undefined, {
        OPENCODE_CONFIG_CONTENT: '{"source":"process"}',
      }),
    ).toBe('{"source":"process"}');
    expect(resolveOpenCodeConfigContent(undefined, {})).toBe("{}");
  });
});

describe("mergeOpenCodeBackendConfigContent", () => {
  const backend = {
    kind: "openai-compatible" as const,
    baseUrl: "http://127.0.0.1:20128/v1",
    models: ["glm-4.6", "kimi-k2"],
  };

  it("injects a t3-backend provider with models into empty config content", () => {
    const content = mergeOpenCodeBackendConfigContent({
      backend,
      existingContent: undefined,
      apiKey: "secret",
    });
    expect(content).toBeDefined();
    const parsed = JSON.parse(content ?? "{}") as {
      provider: Record<
        string,
        {
          npm: string;
          name: string;
          options: Record<string, string>;
          models: Record<string, unknown>;
        }
      >;
    };
    const entry = parsed.provider["t3-backend"];
    if (entry === undefined) {
      return expect.fail("Expected the t3-backend provider entry");
    }
    expect(entry.npm).toBe("@ai-sdk/openai-compatible");
    expect(entry.name).toBe("T3 Backend");
    expect(entry.options.baseURL).toBe("http://127.0.0.1:20128/v1");
    expect(entry.options.apiKey).toBe("secret");
    expect(Object.keys(entry.models)).toEqual(["glm-4.6", "kimi-k2"]);
  });

  it("strips a stale harness bucket prefix from injected model ids", () => {
    const content = mergeOpenCodeBackendConfigContent({
      backend: { ...backend, models: ["t3-backend/probe-go", "glm-4.6"] },
      existingContent: undefined,
      apiKey: "secret",
    });
    const parsed = JSON.parse(content ?? "{}") as {
      provider: Record<string, { models: Record<string, unknown> }>;
    };
    const entry = parsed.provider["t3-backend"];
    if (entry === undefined) {
      return expect.fail("Expected the t3-backend provider entry");
    }
    expect(Object.keys(entry.models)).toEqual(["probe-go", "glm-4.6"]);
  });

  it("preserves the user's existing providers and merges over the reserved id only", () => {
    const content = mergeOpenCodeBackendConfigContent({
      backend,
      existingContent: JSON.stringify({
        theme: "dark",
        provider: {
          "my-gateway": {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://mine/v1" },
          },
          "t3-backend": {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://stale/v1" },
          },
        },
      }),
      apiKey: undefined,
    });
    expect(content).toBeDefined();
    const parsed = JSON.parse(content ?? "{}") as {
      theme: string;
      provider: Record<string, { options: Record<string, string> }>;
    };
    expect(parsed.theme).toBe("dark");
    const myGateway = parsed.provider["my-gateway"];
    const injected = parsed.provider["t3-backend"];
    if (myGateway === undefined || injected === undefined) {
      return expect.fail("Expected existing providers to be preserved");
    }
    expect(myGateway.options.baseURL).toBe("http://mine/v1");
    expect(injected.options.baseURL).toBe("http://127.0.0.1:20128/v1");
    expect(injected.options.apiKey).toBeUndefined();
  });

  it("uses the Anthropic wire for an anthropic-only endpoint and omits models when absent", () => {
    const content = mergeOpenCodeBackendConfigContent({
      backend: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:20128/v1",
        protocols: ["anthropic"],
      },
      existingContent: undefined,
      apiKey: "anthropic-secret",
    });
    expect(content).toBeDefined();
    const parsed = JSON.parse(content ?? "{}") as {
      provider: Record<string, { npm: string; options: Record<string, string>; models?: unknown }>;
    };
    const entry = parsed.provider["t3-backend"];
    if (entry === undefined) {
      return expect.fail("Expected the t3-backend provider entry");
    }
    expect(entry.npm).toBe("@ai-sdk/anthropic");
    expect(entry.options.apiKey).toBe("anthropic-secret");
    expect(entry.models).toBeUndefined();
  });

  it("returns undefined for content that is not a JSON object", () => {
    expect(
      mergeOpenCodeBackendConfigContent({
        backend,
        existingContent: "not json",
        apiKey: undefined,
      }),
    ).toBeUndefined();
    expect(
      mergeOpenCodeBackendConfigContent({ backend, existingContent: "[1,2]", apiKey: undefined }),
    ).toBeUndefined();
  });

  it("returns undefined for native backends", () => {
    expect(
      mergeOpenCodeBackendConfigContent({
        backend: { kind: "native" },
        existingContent: "{}",
        apiKey: "x",
      }),
    ).toBeUndefined();
  });
});

describe("resolveOpenCodeServerPassword", () => {
  it("uses the local environment password when settings do not provide one", () => {
    expect(
      resolveOpenCodeServerPassword(
        { external: false, environment: { OPENCODE_SERVER_PASSWORD: " env password " } },
        {},
      ),
    ).toBe(" env password ");
  });

  it("uses the settings password for a local server", () => {
    expect(
      resolveOpenCodeServerPassword({ external: false, serverPassword: " settings password " }, {}),
    ).toBe(" settings password ");
  });

  it("uses the settings password when local settings and environment differ", () => {
    expect(
      resolveOpenCodeServerPassword(
        {
          external: false,
          serverPassword: "settings-password",
          environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        },
        {},
      ),
    ).toBe("settings-password");
  });

  it("does not send an inherited local password to an external server", () => {
    expect(
      resolveOpenCodeServerPassword(
        { external: true, environment: { OPENCODE_SERVER_PASSWORD: "local-secret" } },
        { OPENCODE_SERVER_PASSWORD: "inherited-secret" },
      ),
    ).toBeUndefined();
  });
});

function makeHealthClient(
  result: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>,
): OpencodeClient {
  return {
    global: {
      health: result,
    },
  } as unknown as OpencodeClient;
}

describe("verifyOpenCodeServerVersion", () => {
  effectIt.effect("accepts a supported server version", () =>
    Effect.gen(function* () {
      const version = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.19" } })),
      );
      expect(version).toBe("1.14.19");
    }),
  );

  effectIt.effect("rejects a server below the supported version", () =>
    Effect.gen(function* () {
      const error = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.18" } })),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntimeError);
      expect(error.detail).toContain("v1.14.18 is too old");
    }),
  );

  for (const data of [
    { healthy: true },
    { healthy: true, version: "not-a-version" },
    { healthy: false, version: "1.14.19" },
  ]) {
    effectIt.effect(`rejects an invalid health response: ${JSON.stringify(data)}`, () =>
      Effect.gen(function* () {
        const error = yield* verifyOpenCodeServerVersion(
          makeHealthClient(() => Promise.resolve({ data })),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(OpenCodeRuntimeError);
        expect(error.detail).toContain("requires OpenCode v1.14.19 or newer");
      }),
    );
  }

  effectIt.effect("preserves an unauthorized health error", () =>
    Effect.gen(function* () {
      const error = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() =>
          Promise.reject({ response: { status: 401 }, error: { message: "Unauthorized" } }),
        ),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntimeError);
      expect(error.detail).toContain("status=401");
      expect(error.detail).toContain("Unauthorized");
    }),
  );

  effectIt.effect("aborts a health request when the version check times out", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined;
      const checkFiber = yield* verifyOpenCodeServerVersion(
        makeHealthClient((options) => {
          requestSignal = options?.signal;
          return new Promise(() => undefined);
        }),
      ).pipe(Effect.flip, Effect.forkChild);

      yield* Effect.yieldNow;
      expect(requestSignal).toBeDefined();
      yield* TestClock.adjust("6 seconds");

      const error = yield* Fiber.join(checkFiber);
      expect(error.detail).toBe("Timed out while checking the OpenCode server version.");
      expect(requestSignal?.aborted).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("OpenCode server output", () => {
  effectIt.live(
    "drains stdout and stderr after startup so server requests can finish",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* HostProcessEnvironment;
        const executablePath = yield* HostProcessExecutablePath;
        const platform = yield* HostProcessPlatform;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-output-" });
        const isWindows = platform === "win32";
        const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
        const scriptPath = path.join(tempDir, "opencode.mjs");

        yield* fs.writeFileString(
          scriptPath,
          `import { createServer } from "node:http";
const writeOutput = (stream) => new Promise((resolve, reject) => {
  stream.write("x".repeat(2 * 1024 * 1024), (error) => error ? reject(error) : resolve());
});
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/global/health")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ healthy: true, version: "1.14.19" }));
    return;
  }
  await Promise.all([writeOutput(process.stdout), writeOutput(process.stderr)]);
  response.end("drained");
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("opencode server listening on http://127.0.0.1:" + server.address().port + "\\n");
});
`,
        );
        yield* fs.writeFileString(
          binaryPath,
          [
            ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
            isWindows
              ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
              : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
            "",
          ].join("\n"),
        );
        if (!isWindows) {
          yield* fs.chmod(binaryPath, 0o755);
        }

        const runtime = yield* OpenCodeRuntime;
        const server = yield* runtime.startOpenCodeServerProcess({
          binaryPath,
          directory: tempDir,
          port: 0,
          environment: {
            ...environment,
            T3_TEST_NODE_BINARY: executablePath,
            T3_TEST_OPENCODE_SCRIPT: scriptPath,
          },
        });
        const response = yield* HttpClient.get(`${server.url}/output`);

        expect(yield* response.text).toBe("drained");
        expect(yield* server.isRunning).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide([
          OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer)),
          FetchHttpClient.layer,
        ]),
      ),
    10_000,
  );
});
