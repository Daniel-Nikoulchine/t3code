/**
 * Optional integration check against a real `hermes acp` install.
 * Enable with: T3_HERMES_ACP_PROBE=1 vp test run HermesReasoningProbe
 *
 * Sends no prompt, so this costs nothing and touches no model: it only
 * verifies the installed Hermes accepts the exact RPCs T3 Code's Reasoning
 * picker sends (`session/set_config_option` with `reasoning_effort`, plus a
 * no-op `session/set_model`). If an assertion here fails, the Hermes build
 * under test has regressed its ACP surface.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeHermesAcpRuntime } from "./HermesAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeHermesAcpRuntime({
    hermesSettings: { binaryPath: process.env.HERMES_BINARY_PATH || "hermes" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-hermes-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_HERMES_ACP_PROBE === "1")("Hermes reasoning effort probe", () => {
  it.effect("session/set_config_option accepts reasoning_effort", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      // Must succeed: this is the RPC the Reasoning picker sends.
      yield* runtime.setConfigOption("reasoning_effort", "high");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("unknown reasoning effort is tolerated, not fatal", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      // Real Hermes keeps the previous effort on unknown values (CLI
      // precedent: warn instead of swapping). It must not fail the session.
      yield* runtime.setConfigOption("reasoning_effort", "bogus-level");
      yield* runtime.setConfigOption("reasoning_effort", "medium");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_model accepts a no-op switch to the current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      yield* runtime.setSessionModel(currentModelId);
      // Effort survives the rebuild: re-applying it afterwards must succeed.
      yield* runtime.setConfigOption("reasoning_effort", "high");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
