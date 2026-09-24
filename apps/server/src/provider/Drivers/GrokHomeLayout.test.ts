// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ensureGrokBackendHome, mergeGrokBackendConfigToml } from "./GrokHomeLayout.ts";

const MARKER = "# Managed by T3 Code model routing; do not edit.";

describe("mergeGrokBackendConfigToml", () => {
  it("appends a managed model section to an empty file", () => {
    expect(
      mergeGrokBackendConfigToml(undefined, [
        {
          slug: "gpt-5.6-luna",
          model: "gpt-5.6-luna",
          baseUrl: "http://127.0.0.1:3773/openai/v1",
          apiKey: "k",
        },
      ]),
    ).toBe(
      `[model."gpt-5.6-luna"]\n${MARKER}\nmodel = "gpt-5.6-luna"\nbase_url = "http://127.0.0.1:3773/openai/v1"\napi_key = "k"\n`,
    );
  });

  it("replaces its own span in place and preserves user content", () => {
    const userToml = [
      "[cli]",
      'installer = "internal"',
      "",
      `[model."gpt-5.6-luna"]`,
      MARKER,
      'model = "old"',
      'base_url = "http://old/v1"',
      "",
      "[ui]",
      'screen_mode = "minimal"',
      "",
    ].join("\n");
    const merged = mergeGrokBackendConfigToml(userToml, [
      {
        slug: "gpt-5.6-luna",
        model: "gpt-5.6-luna",
        baseUrl: "http://127.0.0.1:3773/openai/v1",
      },
    ]);
    expect(merged).toContain('[model."gpt-5.6-luna"]');
    expect(merged).toContain('base_url = "http://127.0.0.1:3773/openai/v1"');
    expect(merged).toContain('installer = "internal"');
    expect(merged).toContain('screen_mode = "minimal"');
    expect(merged).not.toContain("http://old/v1");
    // No api_key line without a resolved key: grok falls back to its login.
    expect(merged).not.toContain("api_key");
  });

  it("drops stale managed spans and never touches user-owned sections", () => {
    const userToml = [
      `[model."gone"]`,
      MARKER,
      'model = "gone"',
      "",
      `[model."mine"]`,
      'model = "mine"',
      'base_url = "https://api.example.com/v1"',
      "",
    ].join("\n");
    const merged = mergeGrokBackendConfigToml(userToml, []);
    expect(merged).not.toContain('[model."gone"]');
    expect(merged).toContain('[model."mine"]');
    expect(merged).toContain("https://api.example.com/v1");
  });

  it("skips a slug the user defined themselves instead of duplicating it", () => {
    const userToml = [`[model."luna"]`, 'model = "luna"', ""].join("\n");
    const merged = mergeGrokBackendConfigToml(userToml, [
      { slug: "luna", model: "luna", baseUrl: "http://127.0.0.1:3773/openai/v1" },
    ]);
    expect(merged.match(/\[model\."luna"\]/g)).toHaveLength(1);
    expect(merged).not.toContain("127.0.0.1");
  });
});

const fsLayer = NodeServices.layer;

it.layer(fsLayer)("ensureGrokBackendHome", (it) => {
  it.effect("links shared entries and writes the merged config into the shadow home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-home-" });
      const realHome = NodePath.join(tempDir, "real");
      const shadowHome = NodePath.join(tempDir, "shadow");
      yield* fs.makeDirectory(NodePath.join(realHome, "sessions"), { recursive: true });
      yield* fs.writeFileString(
        NodePath.join(realHome, "config.toml"),
        `[cli]\ninstaller = "internal"\n`,
      );

      const result = yield* ensureGrokBackendHome({
        realHomePath: realHome,
        shadowHomePath: shadowHome,
        entries: [
          {
            slug: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            baseUrl: "http://127.0.0.1:3773/openai/v1",
          },
        ],
      });

      expect(result.shadowHomePath).toBe(shadowHome);
      // Shared entries stay usable from the shadow home through symlinks.
      expect(yield* fs.readLink(NodePath.join(shadowHome, "sessions"))).toBe(
        NodePath.join(realHome, "sessions"),
      );
      // The real home is untouched: no managed sections leak into it.
      expect(yield* fs.readFileString(NodePath.join(realHome, "config.toml"))).not.toContain(
        MARKER,
      );
      const shadowConfig = yield* fs.readFileString(NodePath.join(shadowHome, "config.toml"));
      expect(shadowConfig).toContain('installer = "internal"');
      expect(shadowConfig).toContain('[model."gpt-5.6-luna"]');
    }).pipe(Effect.scoped),
  );

  it.effect("leaves an existing shadow home alone except for the merged config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-home-" });
      const realHome = NodePath.join(tempDir, "real");
      const shadowHome = NodePath.join(tempDir, "shadow");
      yield* fs.makeDirectory(realHome, { recursive: true });
      yield* fs.makeDirectory(shadowHome, { recursive: true });

      yield* ensureGrokBackendHome({
        realHomePath: realHome,
        shadowHomePath: shadowHome,
        entries: [],
      });
      // Second run is a no-op for links and still rewrites the config.
      yield* ensureGrokBackendHome({
        realHomePath: realHome,
        shadowHomePath: shadowHome,
        entries: [],
      });
      const shadowConfig = yield* fs.readFileString(NodePath.join(shadowHome, "config.toml"));
      expect(shadowConfig).not.toContain(MARKER);
    }).pipe(Effect.scoped),
  );
});
