import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import {
  CODEX_BACKEND_CONFIG_MARKER,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
  codexBackendWiresProvider,
  materializeCodexShadowHome,
  mergeCodexBackendConfigToml,
  resolveCodexHomeLayout,
  writeCodexBackendShadowConfig,
} from "./CodexHomeLayout.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => decodeCodexSettingsValue(input);

const makeTempDir = Effect.fn("CodexHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  describe("resolveCodexHomeLayout", () => {
    it.effect("uses direct CODEX_HOME when no shadow home is configured", () =>
      Effect.gen(function* () {
        const homePath = yield* makeTempDir("t3code-codex-home-");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath,
          }),
        );

        expect(layout).toMatchObject({
          mode: "direct",
          sharedHomePath: homePath,
          effectiveHomePath: homePath,
          continuationKey: `codex:home:${homePath}`,
        });
      }),
    );

    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
      }),
    );
  });

  describe("materializeCodexShadowHome", () => {
    it.effect.skipIf(!symlinksSupported)(
      "materializes a shadow home with shared state links and private auth",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(
            path.join(sharedHome, "models_cache.json"),
            '{"models":["shared"]}\n',
          );
          yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.symlink(
            path.join(sharedHome, "models_cache.json"),
            path.join(shadowHome, "models_cache.json"),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const mcpOauthLocksTarget = yield* fileSystem.readLink(
            path.join(shadowHome, "mcp-oauth-locks"),
          );
          const modelsCacheExists = yield* fileSystem.exists(
            path.join(shadowHome, "models_cache.json"),
          );
          const authLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.json"))
            .pipe(Effect.result);
          const authContents = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(mcpOauthLocksTarget).toBe(path.join(sharedHome, "mcp-oauth-locks"));
          expect(modelsCacheExists).toBe(false);
          expect(authLinkResult._tag).toBe("Failure");
          expect(authContents).toContain("shadow");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces Codex-created local MCP OAuth locks with the shared lock directory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLocks = path.join(sharedHome, "mcp-oauth-locks");
          const shadowLocks = path.join(shadowHome, "mcp-oauth-locks");

          yield* writeTextFile(path.join(sharedLocks, "file-store.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, "file-store.lock"), "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const locksTarget = yield* fileSystem.readLink(shadowLocks);
          const sharedLockExists = yield* fileSystem.exists(
            path.join(sharedLocks, "file-store.lock"),
          );

          expect(locksTarget).toBe(sharedLocks);
          expect(sharedLockExists).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "accepts Codex-created shadow-local runtime directories",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "log"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "memories"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "tmp"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.makeDirectory(path.join(shadowHome, "log"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "memories"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "tmp"), { recursive: true });

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const logLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "log"))
            .pipe(Effect.result);
          const memoriesLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "memories"))
            .pipe(Effect.result);
          const tmpLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "tmp"))
            .pipe(Effect.result);

          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(logLinkResult._tag).toBe("Failure");
          expect(memoriesLinkResult._tag).toBe("Failure");
          expect(tmpLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect("rejects shadow homes that point at the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: sharedHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
        expect(error).toMatchObject({
          sharedHomePath: sharedHome,
          effectiveHomePath: sharedHome,
        });
        expect(error.message).toBe(
          `Codex shadow home path '${sharedHome}' must be different from the shared home path '${sharedHome}'.`,
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects shared entries that already exist in the shadow home as real files",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeEntryConflictError);
          expect(error).toMatchObject({
            sharedHomePath: sharedHome,
            effectiveHomePath: shadowHome,
            entryName: "config.toml",
            linkPath: path.join(shadowHome, "config.toml"),
            targetPath: path.join(sharedHome, "config.toml"),
          });
          expect(error.message).toBe(
            `Cannot create Codex shadow home entry 'config.toml' because '${path.join(shadowHome, "config.toml")}' already exists and is not a symlink.`,
          );
        }),
    );

    it.effect("preserves filesystem operation, paths, and cause", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedRoot = yield* makeTempDir("t3code-codex-shared-root-");
        const sharedHome = path.join(sharedRoot, "shared-home");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        yield* writeTextFile(sharedHome, "not a directory\n");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error._tag).toBe("CodexShadowHomeFileSystemError");
        if (error._tag !== "CodexShadowHomeFileSystemError") {
          return expect.fail("Expected CodexShadowHomeFileSystemError");
        }
        expect(error).toMatchObject({
          operation: "makeDirectory",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
        });
        expect(error.path.startsWith(sharedHome)).toBe(true);
        expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
        expect(error.message).toBe(
          `Codex shadow home filesystem operation 'makeDirectory' failed for '${error.path}'.`,
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps a private config.toml when privateConfigToml is set",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout, { privateConfigToml: true });

          const configLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "config.toml"))
            .pipe(Effect.result);
          expect(configLinkResult._tag).toBe("Failure");
          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "restores the shared config.toml symlink over a generated backend file",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout, { privateConfigToml: true });
          yield* writeCodexBackendShadowConfig(
            layout,
            {
              kind: "openai-compatible",
              baseUrl: "http://127.0.0.1:20128/v1",
            },
            { OPENAI_API_KEY: "secret" },
          );
          const generated = yield* fileSystem.readFileString(path.join(shadowHome, "config.toml"));
          expect(generated.startsWith(CODEX_BACKEND_CONFIG_MARKER)).toBe(true);

          // The reverse transition: without a backend the generated file is
          // dropped and the shared symlink returns.
          yield* materializeCodexShadowHome(layout);
          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves a user-owned private config.toml alone when no backend is wired",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
          expect(error).toBeInstanceOf(CodexShadowHomeEntryConflictError);
        }),
    );
  });

  describe("mergeCodexBackendConfigToml", () => {
    it("appends the provider block and selection to a user config", () => {
      const merged = mergeCodexBackendConfigToml(
        'model = "gpt-5-codex"\napproval_policy = "never"\n',
        {
          baseUrl: "http://127.0.0.1:20128/v1",
          envKey: "OPENAI_API_KEY",
        },
      );
      expect(merged).toContain('model = "gpt-5-codex"');
      expect(merged).toContain('approval_policy = "never"');
      expect(merged).toContain('model_provider = "t3_backend"');
      expect(merged).toContain("[model_providers.t3_backend]");
      expect(merged).toContain('base_url = "http://127.0.0.1:20128/v1"');
      expect(merged).toContain('wire_api = "chat"');
      expect(merged).toContain('env_key = "OPENAI_API_KEY"');
    });

    it("omits env_key when no key resolves", () => {
      const merged = mergeCodexBackendConfigToml(undefined, {
        baseUrl: "http://127.0.0.1:20128/v1",
      });
      expect(merged).not.toContain("env_key");
      expect(merged).toContain("[model_providers.t3_backend]");
    });

    it("replaces an existing top-level model_provider selection in place", () => {
      const merged = mergeCodexBackendConfigToml(
        [
          'model = "gpt-5-codex"',
          'model_provider = "oss"',
          "",
          "[profiles.fast]",
          'model = "gpt-5"',
        ].join("\n"),
        { baseUrl: "http://127.0.0.1:20128/v1" },
      );
      expect(merged).toContain('model_provider = "t3_backend"');
      expect(merged).not.toContain('model_provider = "oss"');
      // Content after the first header belongs to other tables and is kept.
      expect(merged).toContain("[profiles.fast]");
      expect(merged.match(/model_provider\s*=/g)).toHaveLength(1);
    });

    it("replaces an existing t3_backend section instead of duplicating it", () => {
      const first = mergeCodexBackendConfigToml(undefined, {
        baseUrl: "http://old:1/v1",
        envKey: "OPENAI_API_KEY",
      });
      const second = mergeCodexBackendConfigToml(first, { baseUrl: "http://new:2/v1" });
      expect(second).not.toContain("http://old:1/v1");
      expect(second.match(/\[model_providers\.t3_backend\]/g)).toHaveLength(1);
      expect(second).toContain('base_url = "http://new:2/v1"');
    });

    it("drops a hand-written inline t3_backend entry under [model_providers]", () => {
      const merged = mergeCodexBackendConfigToml(
        [
          "[model_providers]",
          'oss = { base_url = "http://localhost:11434/v1" }',
          't3_backend = { base_url = "http://stale/v1" }',
        ].join("\n"),
        { baseUrl: "http://127.0.0.1:20128/v1" },
      );
      expect(merged).not.toContain("http://stale/v1");
      expect(merged).toContain('oss = { base_url = "http://localhost:11434/v1" }');
      expect(merged.match(/t3_backend/g)).toHaveLength(2); // selection key + section header
    });
  });

  describe("writeCodexBackendShadowConfig", () => {
    const makeLayouts = Effect.gen(function* () {
      const path = yield* Path.Path;
      const sharedHome = yield* makeTempDir("t3code-codex-shared-");
      const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
      const shadowHome = path.join(shadowRoot, "shadow");
      const authOverlay = yield* resolveCodexHomeLayout(
        decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
      );
      const direct = yield* resolveCodexHomeLayout(decodeCodexSettings({ homePath: sharedHome }));
      return { path, sharedHome, shadowHome, authOverlay, direct };
    });

    const backendWithKey = {
      kind: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:20128/v1",
    };

    it.effect("writes a private merged config into the shadow home", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { path, sharedHome, shadowHome, authOverlay } = yield* makeLayouts;
        yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });

        yield* writeCodexBackendShadowConfig(authOverlay, backendWithKey, {
          OPENAI_API_KEY: "secret",
        });

        const sharedContents = yield* fileSystem.readFileString(
          path.join(sharedHome, "config.toml"),
        );
        expect(sharedContents).toBe('model = "gpt-5-codex"\n');
        const shadowContents = yield* fileSystem.readFileString(
          path.join(shadowHome, "config.toml"),
        );
        expect(shadowContents.startsWith(CODEX_BACKEND_CONFIG_MARKER)).toBe(true);
        expect(shadowContents).toContain('model = "gpt-5-codex"');
        expect(shadowContents).toContain('model_provider = "t3_backend"');
        expect(shadowContents).toContain('env_key = "OPENAI_API_KEY"');
        expect(shadowContents).not.toContain("secret");
      }),
    );

    it.effect("does nothing in direct mode", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { path, sharedHome, direct } = yield* makeLayouts;
        yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');

        yield* writeCodexBackendShadowConfig(direct, backendWithKey, { OPENAI_API_KEY: "secret" });

        const sharedContents = yield* fileSystem.readFileString(
          path.join(sharedHome, "config.toml"),
        );
        expect(sharedContents).toBe('model = "gpt-5-codex"\n');
        expect(yield* fileSystem.exists(path.join(sharedHome, "config.toml"))).toBe(true);
      }),
    );

    it.effect("does nothing for backends that cannot serve the OpenAI wire", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { path, shadowHome, authOverlay } = yield* makeLayouts;
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });

        yield* writeCodexBackendShadowConfig(
          authOverlay,
          {
            kind: "openai-compatible",
            baseUrl: "http://127.0.0.1:20128/v1",
            protocols: ["anthropic"],
          },
          {},
        );

        expect(yield* fileSystem.exists(path.join(shadowHome, "config.toml"))).toBe(false);
      }),
    );

    it.effect("does nothing without a backend", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { path, shadowHome, authOverlay } = yield* makeLayouts;
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });

        yield* writeCodexBackendShadowConfig(authOverlay, undefined, {});

        expect(yield* fileSystem.exists(path.join(shadowHome, "config.toml"))).toBe(false);
      }),
    );
  });

  describe("codexBackendWiresProvider", () => {
    const wiredBackend = {
      kind: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:20128/v1",
    };

    it("wires openai-compatible backends with a base url", () => {
      expect(codexBackendWiresProvider(wiredBackend)).toBe(true);
      expect(codexBackendWiresProvider(undefined)).toBe(false);
      expect(codexBackendWiresProvider({ kind: "native" })).toBe(false);
      expect(
        codexBackendWiresProvider({
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:20128/v1",
          protocols: ["anthropic"],
        }),
      ).toBe(false);
    });
  });
});
