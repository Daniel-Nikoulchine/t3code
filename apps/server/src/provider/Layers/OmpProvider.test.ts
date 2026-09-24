import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { OmpSettings } from "@t3tools/contracts";

import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  ompModelsFromCatalog,
  ompModelsFromSettings,
  ompModelSlug,
  ompSkillsFromCommands,
  ompSlashCommandsFromCommands,
} from "./OmpProvider.ts";
import { parseCommandDescriptors } from "../pi/PiRpcProtocol.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

describe("OmpProvider mappings", () => {
  it("builds slugs, catalog models, skills, and slash commands", () => {
    expect(ompModelSlug({ id: "opus", provider: "anthropic" })).toBe("anthropic/opus");
    expect(ompModelSlug({ id: "local" })).toBe("local");

    const models = ompModelsFromCatalog(
      [
        { id: "opus", name: "Opus", provider: "anthropic" },
        { id: "opus", name: "Opus dup", provider: "anthropic" },
        { id: "mini", provider: "anthropic" },
      ],
      "opus",
    );
    expect(models.map((model) => model.slug)).toEqual(["anthropic/opus", "anthropic/mini"]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[1]?.isDefault).toBeUndefined();
    expect(models[0]?.name).toBe("Opus");
    expect(models[0]?.subProvider).toBe("anthropic");
    expect(models[1]?.name).toBe("mini");
    expect(models[1]?.subProvider).toBe("anthropic");

    const commands = parseCommandDescriptors({
      commands: [
        { name: "skill:search", description: "Search", source: "skill", path: "/s/SKILL.md" },
        { name: "skill:nopath", source: "skill" },
        { name: "fix", description: "Fix", source: "prompt" },
      ],
    });
    expect(ompSkillsFromCommands(commands)).toEqual([
      { name: "search", path: "/s/SKILL.md", scope: "user", enabled: true, description: "Search" },
    ]);
    expect(ompSlashCommandsFromCommands(commands)).toEqual([{ name: "fix", description: "Fix" }]);

    expect(ompModelsFromSettings([]).map((model) => model.slug)).toEqual(["default"]);
    expect(
      ompModelsFromSettings([{ slug: "custom-1", name: "custom" }]).map((model) => model.slug),
    ).toContain("custom-1");
  });

  it("never surfaces the t3-backend harness bucket as subProvider", () => {
    const models = ompModelsFromCatalog(
      [
        { id: "opencode-go/gpt-5.6-luna", provider: "t3-backend", name: "GPT 5.6 Luna" },
        { id: "claude-opus-4.7", provider: "t3-backend" },
        { id: "local-model" },
      ],
      undefined,
    );
    expect(models.map((model) => [model.slug, model.subProvider ?? null, model.name])).toEqual([
      ["t3-backend/opencode-go/gpt-5.6-luna", "opencode-go", "GPT 5.6 Luna"],
      ["t3-backend/claude-opus-4.7", null, "claude-opus-4.7"],
      ["local-model", null, "local-model"],
    ]);
  });

  it("degrades a stale bucket-prefixed catalog id to the bare model", () => {
    const models = ompModelsFromCatalog(
      [{ id: "t3-backend/probe-go", provider: "t3-backend" }],
      undefined,
    );
    expect(models.map((model) => [model.slug, model.subProvider ?? null, model.name])).toEqual([
      ["t3-backend/t3-backend/probe-go", null, "probe-go"],
    ]);
  });

  it.effect("builds a disabled initial snapshot", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(decodeOmpSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );
});

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-mock-agent.ts");

async function makeMockOmpWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-provider-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
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

effectIt.layer(NodeServices.layer)("OmpProviderLive", (it) => {
  it.effect("reports a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(decodeOmpSettings({ enabled: false }));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({ enabled: true, binaryPath: "/nonexistent-omp-binary-xyz" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unknown");
    }),
  );

  it.effect("reports ready with RPC-discovered models, skills, and slash commands", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({ enabled: true, binaryPath: wrapperPath }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.73.1");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "test-provider/test-model",
        "test-provider/test-model-mini",
      ]);
      expect(snapshot.models.map((model) => model.subProvider)).toEqual([
        "test-provider",
        "test-provider",
      ]);
      expect(snapshot.models[0]?.isDefault).toBe(true);
      expect(snapshot.skills?.map((skill) => skill.name)).toEqual(["brave-search"]);
      expect(snapshot.skills?.[0]?.scope).toBe("project");
      expect(snapshot.skills?.[0]?.path).toBe("/mock/skills/brave-search/SKILL.md");
      expect(snapshot.slashCommands?.map((command) => command.name)).toEqual(["fix-tests"]);
    }).pipe(TestClock.withLive),
  );

  it.effect("reports unauthenticated when the catalog probe fails with a missing key", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_PI_MODELS_ERROR: "1" }),
      );
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({ enabled: true, binaryPath: wrapperPath }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("test-provider");
    }).pipe(TestClock.withLive),
  );

  it.effect("warns when the version probe exits non-zero", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-bad-version-")),
      );
      const wrapperPath = NodePath.join(dir, "bad-omp.sh");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(wrapperPath, "#!/bin/sh\necho nope >&2\nexit 3\n", "utf8"),
      );
      yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({ enabled: true, binaryPath: wrapperPath }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
    }).pipe(TestClock.withLive),
  );
});
