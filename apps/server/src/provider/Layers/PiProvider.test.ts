// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PiSettings } from "@t3tools/contracts";

import { buildInitialPiProviderSnapshot, checkPiProviderStatus } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-rpc-mock-agent.ts");

async function makeMockPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-provider-mock-"));
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

it.layer(NodeServices.layer)("PiProvider", (it) => {
  it.effect("builds a disabled initial snapshot when opted out", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({ enabled: false }));
      assert.isFalse(snapshot.enabled);
      assert.equal(snapshot.models[0]?.slug, "default");
    }),
  );

  it.effect("discovers models, skills surface, and slash commands from the mock CLI", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ binaryPath, enabled: true }),
        process.env,
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.isNotNull(snapshot.version);
      const slugs = snapshot.models.map((model) => model.slug);
      assert.includeMembers(slugs, ["mock-provider/mock-model", "mock-provider/mock-model-2"]);
      // Extension commands surface as slash commands; skills stay in the
      // skills picker and the compact helper is always present.
      const commandNames = snapshot.slashCommands.map((command) => command.name);
      assert.includeMembers(commandNames, ["plan", "compact"]);
      assert.notIncludeMembers(commandNames, ["skill:mock-skill"]);
    }),
  );

  it.effect("reports unauthenticated when pi has no models", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_MODELS_JSON: "[]" }),
      );
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ binaryPath, enabled: true }),
        process.env,
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.include(snapshot.message ?? "", "/login");
    }),
  );

  it.effect("reports a missing binary instead of failing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ binaryPath: "/nonexistent/pi-binary-xyz", enabled: true }),
        process.env,
      );
      assert.equal(snapshot.status, "error");
      assert.isFalse(snapshot.installed);
    }),
  );
});
