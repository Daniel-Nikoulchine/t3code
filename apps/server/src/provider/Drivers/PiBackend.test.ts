// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  buildPiBackendExtensionContent,
  ensurePiBackendExtension,
  PI_BACKEND_API_KEY_ENV,
  PI_BACKEND_PROVIDER_ID,
  resolvePiBackendWiring,
} from "./PiBackend.ts";

describe("resolvePiBackendWiring", () => {
  it("serves the router's route keys with the placeholder key when no key is stored", () => {
    const wiring = resolvePiBackendWiring({
      backend: { kind: "t3-router", baseUrl: "http://127.0.0.1:3773/openai" },
      routeKeys: ["gpt-5.6-luna"],
      baseEnv: {},
    });
    expect(wiring?.slugs).toEqual(["gpt-5.6-luna"]);
    expect(wiring?.customModels).toEqual([`${PI_BACKEND_PROVIDER_ID}/gpt-5.6-luna`]);
    expect(wiring?.apiKeyRef).toBe("t3-router");
    expect(wiring?.envOverlay).toEqual({});
    expect(wiring?.extensionContent).toContain(`"${PI_BACKEND_PROVIDER_ID}"`);
    expect(wiring?.extensionContent).toContain("http://127.0.0.1:3773/openai");
    expect(wiring?.extensionContent).toContain("supportsReasoningEffort");
    expect(wiring?.extensionContent).toContain("thinkingLevelMap");
  });

  it("prefers a stored key over the placeholder and keeps it out of the file", () => {
    const wiring = resolvePiBackendWiring({
      backend: {
        kind: "t3-router",
        baseUrl: "http://127.0.0.1:3773/openai",
        apiKey: "secret",
      },
      routeKeys: ["gpt-5.6-luna"],
      baseEnv: {},
    });
    expect(wiring?.apiKeyRef).toBe(`$${PI_BACKEND_API_KEY_ENV}`);
    expect(wiring?.envOverlay).toEqual({ [PI_BACKEND_API_KEY_ENV]: "secret" });
    expect(wiring?.extensionContent).toContain(`$${PI_BACKEND_API_KEY_ENV}`);
    expect(wiring?.extensionContent).not.toContain("secret");
  });

  it("resolves the key through apiKeyEnv", () => {
    const wiring = resolvePiBackendWiring({
      backend: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:3773/openai",
        models: ["gpt-5.6-luna"],
        apiKeyEnv: "PI_KEY",
      },
      routeKeys: ["other"],
      baseEnv: { PI_KEY: "env-secret" },
    });
    expect(wiring?.slugs).toEqual(["gpt-5.6-luna"]);
    expect(wiring?.envOverlay).toEqual({ [PI_BACKEND_API_KEY_ENV]: "env-secret" });
  });

  it("strips a stale harness bucket prefix from connection model slugs", () => {
    const wiring = resolvePiBackendWiring({
      backend: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:3773/openai",
        models: ["t3-backend/probe-go"],
        apiKey: "secret",
      },
      routeKeys: [],
      baseEnv: {},
    });
    expect(wiring?.slugs).toEqual(["probe-go"]);
    expect(wiring?.customModels).toEqual([`${PI_BACKEND_PROVIDER_ID}/probe-go`]);
  });

  it("stays native without servable slugs, endpoints, or keys", () => {
    expect(
      resolvePiBackendWiring({ backend: undefined, routeKeys: ["x"], baseEnv: {} }),
    ).toBeUndefined();
    expect(
      resolvePiBackendWiring({ backend: { kind: "native" }, routeKeys: ["x"], baseEnv: {} }),
    ).toBeUndefined();
    expect(
      resolvePiBackendWiring({
        backend: { kind: "t3-router", baseUrl: "http://127.0.0.1:3773/openai" },
        routeKeys: [],
        baseEnv: {},
      }),
    ).toBeUndefined();
    expect(
      resolvePiBackendWiring({ backend: { kind: "t3-router" }, routeKeys: ["x"], baseEnv: {} }),
    ).toBeUndefined();
    // Anthropic-only endpoints stay on the Pi login (unverified wire).
    expect(
      resolvePiBackendWiring({
        backend: { kind: "openai-compatible", baseUrl: "http://x/v1", protocols: ["anthropic"] },
        routeKeys: ["x"],
        baseEnv: {},
      }),
    ).toBeUndefined();
    // A direct backend without a key would list models Pi can never call.
    expect(
      resolvePiBackendWiring({
        backend: {
          kind: "openai-compatible",
          baseUrl: "http://x/v1",
          models: ["gpt-5.6-luna"],
        },
        routeKeys: [],
        baseEnv: {},
      }),
    ).toBeUndefined();
  });
});

describe("buildPiBackendExtensionContent", () => {
  it("registers the provider over the OpenAI-completions wire with stringified values", () => {
    const content = buildPiBackendExtensionContent({
      baseUrl: "http://127.0.0.1:3773/openai",
      apiKeyRef: "$PI_T3_BACKEND_API_KEY",
      slugs: ['weird"/slug'],
    });
    expect(content).toContain("registerProvider");
    expect(content).toContain(`"${PI_BACKEND_PROVIDER_ID}"`);
    expect(content).toContain('"openai-completions"');
    expect(content).toContain('apiKey: "$PI_T3_BACKEND_API_KEY"');
    // Slugs are JSON-encoded, never interpolated raw.
    expect(content).toContain(JSON.stringify('weird"/slug'));
    expect(content).not.toContain('weird"/slug');
  });
});

const fsLayer = NodeServices.layer;

it.layer(fsLayer)("ensurePiBackendExtension", (it) => {
  it.effect("writes the generated provider file under the server base dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-backend-" });
      const filePath = yield* ensurePiBackendExtension({
        baseDir,
        instanceId: "pi",
        content: "// test",
      });
      expect(filePath).toBe(NodePath.join(baseDir, "pi-extensions", "pi", "t3-backend.js"));
      expect(yield* fs.readFileString(filePath)).toBe("// test");
    }).pipe(Effect.scoped),
  );
});
