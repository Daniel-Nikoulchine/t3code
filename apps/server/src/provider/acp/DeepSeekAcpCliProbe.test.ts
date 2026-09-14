/**
 * Optional integration check against a real `dsh --profile acp` install.
 * Enable with: T3_DEEPSEEK_ACP_PROBE=1 vp test run DeepSeekAcpCliProbe
 * Set T3_DEEPSEEK_LIVE_TURN=1 (plus DEEPSEEK_API_KEY) to also send a small
 * prompt to the real model.
 *
 * The harness needs no credentials for initialize/session-new; prompts bill
 * the configured DeepSeek account.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  currentDeepSeekSelectionFromConfigOptions,
  flattenDeepSeekModelOptionEntries,
  makeDeepSeekAcpRuntime,
  resolveDeepSeekModelOptionValue,
} from "./DeepSeekAcpSupport.ts";

const BINARY = process.env.T3_DEEPSEEK_ACP_BINARY ?? "dsh";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeDeepSeekAcpRuntime({
    deepseekSettings: { binaryPath: BINARY },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-deepseek-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_DEEPSEEK_ACP_PROBE === "1")("DeepSeek ACP CLI probe", () => {
  it.effect("starts a real dsh ACP session", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(typeof started.sessionId).toBe("string");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises model + reasoning_effort config options", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const configOptions = yield* runtime.getConfigOptions;

      // dsh has no typed SessionModelState; the catalog lives in config.
      const selection = currentDeepSeekSelectionFromConfigOptions(configOptions);
      expect(selection.modelId).toBeDefined();

      const modelOption = configOptions.find((option) => option.category === "model");
      expect(modelOption?.id).toBe("model");
      expect(
        "options" in (modelOption ?? {}) &&
          Array.isArray((modelOption as { options: unknown }).options) &&
          ((modelOption as { options: ReadonlyArray<unknown> }).options.length ?? 0),
      ).toBeGreaterThan(0);

      const effortOption = configOptions.find(
        (option) => option.id === "reasoning_effort" || option.id.trim() === "reasoning_effort",
      );
      expect(effortOption).toBeDefined();
      expect(started.sessionSetupResult).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_config_option switches the advertised model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      const configOptions = yield* runtime.getConfigOptions;
      const entries = flattenDeepSeekModelOptionEntries(configOptions);
      expect(entries.length).toBeGreaterThan(0);
      const first = entries[0]?.value;
      expect(first).toBeDefined();
      if (!first) return;
      // Resolve a friendly slug the way the adapter does, then apply it.
      const wired = resolveDeepSeekModelOptionValue(first, configOptions);
      yield* runtime.setModel(wired);
      const refreshed = currentDeepSeekSelectionFromConfigOptions(yield* runtime.getConfigOptions);
      expect(refreshed.modelId).toBe(wired);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_DEEPSEEK_LIVE_TURN !== "1")(
    "finishes a real DeepSeek turn and streams its answer",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped();
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const runtime = yield* makeDeepSeekAcpRuntime({
          deepseekSettings: { binaryPath: BINARY },
          environment: process.env,
          childProcessSpawner,
          cwd,
          runtimeMode: "approval-required",
          clientInfo: { name: "t3-deepseek-probe", version: "0.0.0" },
        });
        yield* runtime.start();
        const chunks: string[] = [];
        const events = yield* Stream.runForEach(runtime.getEvents(), (event) => {
          if (event._tag === "EventStreamBarrier") {
            return Deferred.succeed(event.acknowledge, undefined);
          }
          if (event._tag === "ContentDelta") {
            chunks.push(event.text);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);
        const result = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Reply exactly DEEPSEEK_T3_OK. Do not use any tools." }],
        });
        yield* runtime.drainEvents;
        expect(result.stopReason).toBe("end_turn");
        expect(chunks.join("")).toContain("DEEPSEEK_T3_OK");
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
