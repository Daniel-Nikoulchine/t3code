// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type ModelBackendConfig, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

const BACKEND_BASE_URL = "http://127.0.0.1:20128/v1";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-claude-driver-backend-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("ClaudeDriver backend test must not make HTTP requests")),
    ),
  ),
);

// Every spawn (status probe, maintenance checks) is answered with an
// immediately-exited empty process, so no CLI binary is ever executed. The
// capabilities probe runs the Agent SDK against a nonexistent executable and
// degrades to "no capabilities" without touching a real CLI.
const makeCapturingSpawner = (captures: Array<ChildProcess.StandardCommand>) =>
  ChildProcessSpawner.make((command) => {
    if (ChildProcess.isStandardCommand(command)) {
      captures.push(command);
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.empty),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

const makeInstance = (input: {
  readonly binaryPath: string;
  readonly homePath: string;
  readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly backend?: ModelBackendConfig | undefined;
  readonly captures: Array<ChildProcess.StandardCommand>;
}) =>
  ClaudeDriver.create({
    instanceId: ProviderInstanceId.make("claude-backend-test"),
    displayName: "Claude backend test",
    enabled: true,
    environment: (input.environment ?? []).map((variable) => ({ ...variable, sensitive: false })),
    ...(input.backend === undefined ? {} : { backend: input.backend }),
    config: {
      ...ClaudeDriver.defaultConfig(),
      enabled: true,
      binaryPath: input.binaryPath,
      homePath: input.homePath,
    },
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      makeCapturingSpawner(input.captures),
    ),
  );

const spawnEnvsOf = (captures: ReadonlyArray<ChildProcess.StandardCommand>) =>
  captures.flatMap((command) => (command.options.env ? [command.options.env] : []));

it.layer(testLayer)("ClaudeDriver model backend", (it) => {
  it.effect("merges the backend env overlay into the spawned probe environment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const captures: Array<ChildProcess.StandardCommand> = [];
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-driver-" });

      const instance = yield* makeInstance({
        binaryPath: `${tempDir}/missing/claude`,
        homePath: tempDir,
        environment: [{ name: "T3_CUSTOM_KEEP", value: "kept" }],
        backend: { kind: "openai-compatible", baseUrl: BACKEND_BASE_URL },
        captures,
      });
      const snapshot = yield* instance.snapshot.refresh;

      // The status stamp carries the redacted backend summary.
      expect(snapshot.backend).toMatchObject({ kind: "openai-compatible", viaProxy: true });

      const probeEnvs = spawnEnvsOf(captures);
      expect(probeEnvs.length).toBeGreaterThan(0);
      for (const env of probeEnvs) {
        expect(env.ANTHROPIC_BASE_URL).toBe(BACKEND_BASE_URL);
        // The backend overlay wins on ANTHROPIC_* while unrelated instance env
        // is preserved.
        expect(env.T3_CUSTOM_KEEP).toBe("kept");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("injects no ANTHROPIC_* variables without a backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const captures: Array<ChildProcess.StandardCommand> = [];
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-driver-" });

      const instance = yield* makeInstance({
        binaryPath: `${tempDir}/missing/claude`,
        homePath: tempDir,
        environment: [{ name: "OPENAI_BASE_URL", value: "http://instance:9999/v1" }],
        captures,
      });
      yield* instance.snapshot.refresh;

      const probeEnvs = spawnEnvsOf(captures);
      expect(probeEnvs.length).toBeGreaterThan(0);
      for (const env of probeEnvs) {
        expect(env.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL);
        expect(env.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("appends connection models to the snapshot model list", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const captures: Array<ChildProcess.StandardCommand> = [];
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-driver-" });

      const instance = yield* makeInstance({
        binaryPath: `${tempDir}/missing/claude`,
        homePath: tempDir,
        backend: {
          kind: "openai-compatible",
          baseUrl: BACKEND_BASE_URL,
          models: ["glm-4.6", "kimi-k2"],
        },
        captures,
      });
      const snapshot = yield* instance.snapshot.refresh;

      const slugs = snapshot.models.map((model) => model.slug);
      expect(slugs).toContain("glm-4.6");
      expect(slugs).toContain("kimi-k2");
      expect(snapshot.models.find((model) => model.slug === "glm-4.6")?.isCustom).toBe(true);
    }).pipe(Effect.scoped),
  );
});
