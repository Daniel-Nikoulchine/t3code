// @effect-diagnostics nodeBuiltinImport:off - resolves the mock app-server script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ZcodeSettings } from "@t3tools/contracts";

import {
  buildInitialZcodeProviderSnapshot,
  checkZcodeProviderStatus,
  hasZcodeModelAccessEnv,
  parseZcodeReadStateModels,
  readZcodeCliModelAccess,
  ZCODE_DEFAULT_MODEL_SLUG,
} from "./ZcodeProvider.ts";

const decodeZcodeSettings = Schema.decodeSync(ZcodeSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

// Single-quotes a path for /bin/sh. Temp dirs and execPath never contain quotes.
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// Serializes a canned ZCode CLI config. Module scope: JSON helpers stay out
// of Effect contexts per the preferSchemaOverJson diagnostic.
const zcodeCliConfigJson = (apiKey: string) =>
  JSON.stringify({
    provider: { zai: { options: { apiKey } } },
    model: { main: "zai/glm-5.2" },
  });

// A shell stand-in for the ZCode CLI: `--version` prints canned text,
// `skills list --json` prints an empty catalog, and `app-server` execs the
// mock app-server so `workspace/readState` returns model metadata.
const writeFakeZcodeCli = (input: {
  readonly versionOutput?: string;
  readonly versionExitCode?: number;
  readonly appServer?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-zcode-probe-" });
    const zcodePath = path.join(dir, "zcode");
    const mockAgentPath = path.resolve(__dirname, "../../../scripts/zcode-mock-app-server.mjs");
    const versionOutput = input.versionOutput ?? "zcode 0.16.5";
    const versionExitCode = input.versionExitCode ?? 0;
    yield* fs.writeFileString(
      zcodePath,
      [
        "#!/bin/sh",
        'case "$1" in',
        `  --version) printf "%s\\n" ${shellQuote(versionOutput)}; exit ${versionExitCode};;`,
        '  skills) printf "{\\"cwd\\":\\".\\",\\"diagnostics\\":[],\\"skills\\":[],\\"totalDiscovered\\":0}\\n"; exit 0;;',
        input.appServer === false
          ? "  app-server) exit 3;;"
          : `  app-server) shift; exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@";;`,
        "esac",
        "exit 1",
        "",
      ].join("\n"),
    );
    yield* fs.chmod(zcodePath, 0o755);
    return zcodePath;
  });

describe("parseZcodeReadStateModels", () => {
  it("maps catalog entries onto provider models, marking the current model", () => {
    const parsed = parseZcodeReadStateModels({
      modelCatalog: {
        available: [
          {
            label: "GLM-5.2",
            ref: { modelId: "glm-5.2", providerId: "zai" },
          },
          {
            label: "GLM-5-Turbo",
            ref: { modelId: "glm-5-turbo", providerId: "zai" },
          },
        ],
      },
      settings: { model: { current: { modelId: "glm-5-turbo", providerId: "zai" } } },
    });

    expect(parsed.currentModelId).toBe("glm-5-turbo");
    expect(parsed.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["glm-5.2", false],
      ["glm-5-turbo", true],
    ]);
  });

  it("dedupes repeated model ids and tolerates unknown shapes", () => {
    const parsed = parseZcodeReadStateModels({
      modelCatalog: {
        available: [
          { label: "GLM-5.2", ref: { modelId: "glm-5.2", providerId: "zai" } },
          { label: "GLM-5.2 again", ref: { modelId: "glm-5.2", providerId: "zai" } },
          { label: "Missing ref" },
          "not-an-object",
        ],
      },
    });

    expect(parsed.models.map((model) => model.slug)).toEqual(["glm-5.2"]);
    expect(parseZcodeReadStateModels(null)).toEqual({ models: [], currentModelId: undefined });
    expect(parseZcodeReadStateModels({})).toEqual({ models: [], currentModelId: undefined });
  });
});

describe("readZcodeCliModelAccess", () => {
  it("reads the main provider apiKey from the CLI config", () => {
    expect(
      readZcodeCliModelAccess({
        provider: {
          zai: { options: { apiKey: "secret", baseURL: "https://api.z.ai/api/anthropic" } },
        },
        model: { main: "zai/glm-5.2" },
      }),
    ).toEqual({ model: "zai/glm-5.2", hasApiKey: true });

    expect(
      readZcodeCliModelAccess({
        provider: { zai: { options: {} } },
        model: { main: "zai/glm-5.2" },
      }).hasApiKey,
    ).toBe(false);

    expect(readZcodeCliModelAccess({}).hasApiKey).toBe(false);
    expect(readZcodeCliModelAccess(null).hasApiKey).toBe(false);
  });
});

describe("hasZcodeModelAccessEnv", () => {
  it("detects provider credential environment entries", () => {
    expect(hasZcodeModelAccessEnv({ ZAI_API_KEY: "secret" })).toBe(true);
    expect(hasZcodeModelAccessEnv({ ANTHROPIC_AUTH_TOKEN: "secret" })).toBe(true);
    expect(hasZcodeModelAccessEnv({ ZCODE_BASE_URL: "https://example.test" })).toBe(false);
    expect(hasZcodeModelAccessEnv({})).toBe(false);
  });
});

describe("buildInitialZcodeProviderSnapshot", () => {
  it.effect("marks a disabled instance without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialZcodeProviderSnapshot(
        decodeZcodeSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toContain(ZCODE_DEFAULT_MODEL_SLUG);
    }),
  );

  it.effect("marks an enabled instance as checking", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialZcodeProviderSnapshot(
        decodeZcodeSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking ZCode");
    }),
  );
});

it.layer(NodeServices.layer)("checkZcodeProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkZcodeProviderStatus(
        decodeZcodeSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/zcode-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const zcodePath = yield* writeFakeZcodeCli({
            versionOutput: "broken",
            versionExitCode: 2,
          });
          return yield* checkZcodeProviderStatus(
            decodeZcodeSettings({ enabled: true, binaryPath: zcodePath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("ZCode CLI is installed but failed to run.");
    }),
  );

  it.effect("reports ready with catalog models when the app-server answers", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const zcodePath = yield* writeFakeZcodeCli({});
          return yield* checkZcodeProviderStatus(
            decodeZcodeSettings({ enabled: true, binaryPath: zcodePath }),
            { ...process.env, ZAI_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.16.5");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["glm-5.2", "glm-5-turbo"]);
      expect(snapshot.models.find((model) => model.slug === "glm-5.2")?.isDefault).toBe(true);
    }),
  );

  it.effect("treats a configured CLI apiKey as authenticated", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const zcodePath = yield* writeFakeZcodeCli({});
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-zcode-home-" });
          yield* fs.makeDirectory(path.join(home, ".zcode", "cli"), { recursive: true });
          yield* fs.writeFileString(
            path.join(home, ".zcode", "cli", "config.json"),
            zcodeCliConfigJson("test-key"),
          );
          return yield* checkZcodeProviderStatus(
            decodeZcodeSettings({ enabled: true, binaryPath: zcodePath }),
            { ...process.env, HOME: home, ZAI_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "ZCode Coding Plan",
      });
      expect(snapshot.status).toBe("ready");
    }),
  );

  it.effect("treats ZAI_API_KEY as authenticated regardless of CLI config", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const zcodePath = yield* writeFakeZcodeCli({});
          return yield* checkZcodeProviderStatus(
            decodeZcodeSettings({ enabled: true, binaryPath: zcodePath }),
            { ...process.env, ZAI_API_KEY: "zai-test-key" },
          );
        }),
      );

      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "ZCode API key",
      });
      expect(snapshot.status).toBe("ready");
    }),
  );

  it.effect("warns with fallback models when the app-server is unreachable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const zcodePath = yield* writeFakeZcodeCli({ appServer: false });
          return yield* checkZcodeProviderStatus(
            decodeZcodeSettings({ enabled: true, binaryPath: zcodePath }),
            { ...process.env, ZAI_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toContain(ZCODE_DEFAULT_MODEL_SLUG);
      expect(snapshot.message).toContain("model catalog is unavailable");
    }),
  );
});
