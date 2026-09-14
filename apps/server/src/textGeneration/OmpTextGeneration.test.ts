import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics preferSchemaOverJson:off -- Mock harness fixtures are raw JSON strings.
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

import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";

import { makeOmpTextGeneration, resolveOmpTextFlags } from "./OmpTextGeneration.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const OMP_INSTANCE = ProviderInstanceId.make("omp");

describe("OmpTextGeneration flags", () => {
  it("resolves one-shot CLI flags", () => {
    expect(
      resolveOmpTextFlags({
        settings: decodeOmpSettings({}),
        modelSelection: { instanceId: OMP_INSTANCE, model: "default" },
      }),
    ).toEqual(["-p", "--no-session", "--thinking", "low"]);
    expect(
      resolveOmpTextFlags({
        settings: decodeOmpSettings({
          provider: "openai",
          model: "",
          thinkingLevel: "high",
        }),
        modelSelection: { instanceId: OMP_INSTANCE, model: "openai/gpt-4o" },
      }),
    ).toEqual([
      "-p",
      "--no-session",
      "--provider",
      "openai",
      "--model",
      "openai/gpt-4o",
      "--thinking",
      "high",
    ]);
    expect(
      resolveOmpTextFlags({
        settings: decodeOmpSettings({}),
        modelSelection: {
          instanceId: OMP_INSTANCE,
          model: "anthropic/opus",
          options: [{ id: "reasoningEffort", value: "minimal" }],
        },
      }),
    ).toContain("minimal");
  });
});

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/pi-mock-agent.ts");

effectIt.layer(NodeServices.layer)("OmpTextGenerationLive", (it) => {
  it.effect("generates a thread title through the mock harness", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-textgen-")),
      );
      const wrapperPath = NodePath.join(dir, "fake-omp.sh");
      const titleJson = JSON.stringify({ title: "Mock Title" });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          wrapperPath,
          `#!/bin/sh\nexport T3_PI_PRINT_TEXT=${JSON.stringify(titleJson)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
          "utf8",
        ),
      );
      yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));
      const textGeneration = yield* makeOmpTextGeneration(
        decodeOmpSettings({ binaryPath: wrapperPath }),
      );
      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "hello world",
        modelSelection: { instanceId: OMP_INSTANCE, model: "default" },
      });
      expect(result.title).toBe("Mock Title");
    }).pipe(TestClock.withLive),
  );
});
