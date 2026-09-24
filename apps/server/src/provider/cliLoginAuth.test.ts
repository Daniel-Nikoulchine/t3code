import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  claudeLoginRecipe,
  codexLoginRecipe,
  makeCliLoginAuthController,
  type CliLoginRecipe,
} from "./cliLoginAuth.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

const instanceId = ProviderInstanceId.make("cli-login-auth-test");
const owner = "t3-auth-session-owner";
const otherOwner = "t3-auth-session-other";

const CODEX_DEVICE_OUTPUT = [
  "Welcome to Codex [v0.154.0]",
  "OpenAI's command-line coding agent",
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  "   https://auth.openai.com/codex/device",
  "",
  "2. Enter this one-time code (expires in 15 minutes)",
  "   ESK2-2VIU7",
  "",
  "Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.",
].join("\n");

// Real `codex login --device-auth` colorizes its output; parsing must be
// ANSI-blind.
const CODEX_DEVICE_OUTPUT_COLORED = `Welcome to Codex [v0.154.0]\n${CODEX_DEVICE_OUTPUT}`;

const CLAUDE_LOGIN_OUTPUT = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&code_challenge=abc&code_challenge_method=S256&state=xyz",
  "Paste code here if prompted > ",
].join("\n");

describe("cliLogin recipes", () => {
  it("parses the Codex device flow URL and user code", () => {
    expect(codexLoginRecipe.parseLoginOutput(CODEX_DEVICE_OUTPUT)).toEqual({
      authorizationUrl: "https://auth.openai.com/codex/device",
      userCode: "ESK2-2VIU7",
    });
  });

  it("parses Codex output with ANSI color codes", () => {
    expect(codexLoginRecipe.parseLoginOutput(CODEX_DEVICE_OUTPUT_COLORED)).toEqual({
      authorizationUrl: "https://auth.openai.com/codex/device",
      userCode: "ESK2-2VIU7",
    });
  });

  it("parses the Claude authorize URL", () => {
    expect(claudeLoginRecipe.parseLoginOutput(CLAUDE_LOGIN_OUTPUT)).toEqual({
      authorizationUrl:
        "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&code_challenge=abc&code_challenge_method=S256&state=xyz",
    });
  });

  it("parses Codex login status text", () => {
    expect(codexLoginRecipe.parseStatus("Not logged in", 0)).toBe("unauthenticated");
    expect(codexLoginRecipe.parseStatus("Logged in as user@example.com", 0)).toBe("authenticated");
    expect(codexLoginRecipe.parseStatus("", 1)).toBe("unknown");
  });

  it("parses Claude login status JSON", () => {
    expect(claudeLoginRecipe.parseStatus('{"loggedIn":true,"authMethod":"oauth"}', 0)).toBe(
      "authenticated",
    );
    expect(claudeLoginRecipe.parseStatus('{"loggedIn":false}', 0)).toBe("unauthenticated");
    expect(claudeLoginRecipe.parseStatus("not json", 0)).toBe("unknown");
  });
});

interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Scripted process: stdout chunks, exit, and recorded stdin writes. */
interface ScriptedProcess {
  readonly stdoutChunks: ReadonlyArray<string>;
  /**
   * Exit code, or "hang" to never exit. When `releaseExit` is set, the
   * process exits with `exit` once the test releases the gate — this keeps
   * phased flows deterministic: the test observes `waiting` first, then
   * lets the process finish instead of racing the monitor.
   */
  readonly exit: number | "hang";
  readonly releaseExit?: Deferred.Deferred<void> | undefined;
  readonly stdinWrites: Array<string>;
}

function script(
  stdoutChunks: ReadonlyArray<string>,
  exit: number | "hang" = 0,
  releaseExit?: Deferred.Deferred<void> | undefined,
): ScriptedProcess {
  return {
    stdoutChunks,
    exit,
    ...(releaseExit !== undefined ? { releaseExit } : {}),
    stdinWrites: [],
  };
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function makeFakeSpawner(options: {
  readonly scripts: Ref.Ref<Array<ScriptedProcess>>;
  readonly invocations: Ref.Ref<Array<SpawnedCommand>>;
}): Effect.Effect<ChildProcessSpawner.ChildProcessSpawner["Service"], never, never> {
  const spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] = (command) =>
    Effect.gen(function* () {
      const scripts = yield* Ref.get(options.scripts);
      const [scripted = script([], 0), ...rest] = scripts;
      yield* Ref.set(options.scripts, rest);
      yield* Ref.update(options.invocations, (invocations) => [
        ...invocations,
        command._tag === "StandardCommand"
          ? { command: command.command, args: [...command.args] }
          : { command: "piped", args: [] as Array<string> },
      ]);
      return ChildProcessSpawner.makeHandle({
        pid: 4242 as ChildProcessSpawner.ProcessId,
        exitCode:
          scripted.exit === "hang"
            ? Effect.never
            : scripted.releaseExit !== undefined
              ? Deferred.await(scripted.releaseExit).pipe(
                  Effect.as(scripted.exit as ChildProcessSpawner.ExitCode),
                )
              : Effect.succeed(scripted.exit as ChildProcessSpawner.ExitCode),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            scripted.stdinWrites.push(decode(chunk));
          }),
        ),
        stdout: Stream.fromIterable(scripted.stdoutChunks.map(encode)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });
  return Effect.succeed(ChildProcessSpawner.make(spawn));
}

interface AuthHarness {
  readonly controller: ProviderAuthController;
  readonly invocations: Ref.Ref<Array<SpawnedCommand>>;
}

const makeHarness = Effect.fn("cliLoginAuthTest.harness")(function* (options: {
  readonly recipe?: CliLoginRecipe;
  readonly scripts?: ReadonlyArray<ScriptedProcess>;
}) {
  const recipe = options.recipe ?? codexLoginRecipe;
  const invocations = yield* Ref.make<Array<SpawnedCommand>>([]);
  const scripts = yield* Ref.make<Array<ScriptedProcess>>([...(options.scripts ?? [])]);
  const spawner = yield* makeFakeSpawner({ scripts, invocations });
  const controller = yield* makeCliLoginAuthController({
    instanceId,
    recipe,
    command: recipe.defaultCommand,
    env: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  return { controller, invocations } satisfies AuthHarness;
});

const awaitPhase = (
  controller: ProviderAuthController,
  phase: ProviderAuthState["phase"],
  sessionId = owner,
) =>
  controller.subscribe(sessionId).pipe(
    Stream.filter((state) => state.phase === phase),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

function flowIdOf(state: ProviderAuthState): string {
  if (state.flowId === null) assert.fail(`expected a flow id in phase ${state.phase}`);
  return state.flowId;
}

const stopSessions = () => Effect.void;

it.layer(NodeServices.layer)("cliLoginAuth", (it) => {
  it.effect("completes the Codex device flow and verifies via login status", () =>
    Effect.gen(function* () {
      const releaseLogin = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        scripts: [
          script([CODEX_DEVICE_OUTPUT], 0, releaseLogin),
          script(["Logged in as user@example.com"], 0),
        ],
      });
      const starting = yield* harness.controller.start(owner, stopSessions());
      assert.strictEqual(starting.phase, "starting");

      const waiting = yield* awaitPhase(harness.controller, "waiting");
      assert.strictEqual(waiting.authorizationUrl, "https://auth.openai.com/codex/device");
      assert.strictEqual(waiting.userCode, "ESK2-2VIU7");
      assert.isNotNull(waiting.flowId);
      assert.isNotNull(waiting.expiresAt);

      yield* Deferred.succeed(releaseLogin, undefined);
      const succeeded = yield* awaitPhase(harness.controller, "succeeded");
      assert.strictEqual(succeeded.flowId, null);

      const invocations = yield* Ref.get(harness.invocations);
      expect(invocations.map((entry) => entry.args)).toEqual([
        ["login", "--device-auth"],
        ["login", "status"],
      ]);
    }),
  );

  it.effect("delivers the pasted code to the Claude process stdin", () =>
    Effect.gen(function* () {
      const releaseLogin = yield* Deferred.make<void>();
      const login = script([CLAUDE_LOGIN_OUTPUT], 0, releaseLogin);
      const harness = yield* makeHarness({
        recipe: claudeLoginRecipe,
        scripts: [login, script(['{"loggedIn":true}'], 0)],
      });
      yield* harness.controller.start(owner, stopSessions());
      const waiting = yield* awaitPhase(harness.controller, "waiting");

      const verifying = yield* harness.controller.complete(owner, {
        flowId: flowIdOf(waiting),
        callbackUrl: "pasted-oauth-code",
      });
      assert.strictEqual(verifying.phase, "verifying");
      expect(login.stdinWrites.join("")).toContain("pasted-oauth-code");

      yield* Deferred.succeed(releaseLogin, undefined);
      const succeeded = yield* awaitPhase(harness.controller, "succeeded");
      assert.strictEqual(succeeded.phase, "succeeded");
    }),
  );

  it.effect("fails a Claude flow whose status stays logged out", () =>
    Effect.gen(function* () {
      const releaseLogin = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        recipe: claudeLoginRecipe,
        scripts: [
          script([CLAUDE_LOGIN_OUTPUT], 0, releaseLogin),
          script(['{"loggedIn":false}'], 0),
        ],
      });
      yield* harness.controller.start(owner, stopSessions());
      const waiting = yield* awaitPhase(harness.controller, "waiting");
      yield* harness.controller.complete(owner, {
        flowId: flowIdOf(waiting),
        callbackUrl: "stale-code",
      });
      yield* Deferred.succeed(releaseLogin, undefined);
      const failed = yield* awaitPhase(harness.controller, "failed");
      assert.match(failed.message ?? "", /did not complete/);
    }),
  );

  it.effect("cancels an active flow", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ scripts: [script([CODEX_DEVICE_OUTPUT], "hang")] });
      yield* harness.controller.start(owner, stopSessions());
      const waiting = yield* awaitPhase(harness.controller, "waiting");
      const cancelled = yield* harness.controller.cancel(owner, flowIdOf(waiting));
      assert.strictEqual(cancelled.phase, "cancelled");
    }),
  );

  it.effect("rejects operations for a stale flow id", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ scripts: [script([CODEX_DEVICE_OUTPUT], "hang")] });
      yield* harness.controller.start(owner, stopSessions());
      yield* awaitPhase(harness.controller, "waiting");
      const failure = yield* harness.controller.cancel(owner, "no-such-flow").pipe(Effect.flip);
      assert.instanceOf(failure, ProviderSetupError);
      assert.match(failure.detail, /no longer active/);
    }),
  );

  it.effect("returns the active flow on a second start", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ scripts: [script([CODEX_DEVICE_OUTPUT], "hang")] });
      yield* harness.controller.start(owner, stopSessions());
      const waiting = yield* awaitPhase(harness.controller, "waiting");
      const second = yield* harness.controller.start(owner, stopSessions());
      assert.strictEqual(second.phase, "waiting");
      assert.strictEqual(second.flowId, waiting.flowId);
      const invocations = yield* Ref.get(harness.invocations);
      assert.strictEqual(invocations.length, 1);
    }),
  );

  it.effect("hides the authorize URL from other sessions while busy", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ scripts: [script([CODEX_DEVICE_OUTPUT], "hang")] });
      yield* harness.controller.start(owner, stopSessions());
      const gated = yield* harness.controller.subscribe(otherOwner).pipe(
        Stream.filter((state) => state.phase === "waiting"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.strictEqual(gated.authorizationUrl, null);
      assert.strictEqual(gated.flowId, null);
    }),
  );

  it.effect("runs the logout command and returns to idle", () =>
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        scripts: [script([""], 0), script(["Not logged in"], 0)],
      });
      const idle = yield* harness.controller.logout(
        Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
      );
      assert.strictEqual(idle.phase, "idle");
      assert.isTrue(yield* Deferred.poll(stopped).pipe(Effect.map(Option.isSome)));
      const invocations = yield* Ref.get(harness.invocations);
      expect(invocations.map((entry) => entry.args)).toEqual([["logout"], ["login", "status"]]);
    }),
  );

  it.effect("fails logout when the CLI still reports signed in", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        scripts: [script([""], 0), script(["Logged in as user@example.com"], 0)],
      });
      const failure = yield* harness.controller.logout(stopSessions()).pipe(Effect.flip);
      assert.instanceOf(failure, ProviderSetupError);
      assert.match(failure.detail, /still reports signed in/);
      const failed = yield* awaitPhase(harness.controller, "failed");
      assert.match(failed.message ?? "", /still reports signed in/);
    }),
  );

  it.effect("fails Claude logout when auth status stays logged in", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        recipe: claudeLoginRecipe,
        scripts: [script([""], 0), script(['{"loggedIn":true}'], 0)],
      });
      const failure = yield* harness.controller.logout(stopSessions()).pipe(Effect.flip);
      assert.instanceOf(failure, ProviderSetupError);
      assert.match(failure.detail, /still reports signed in/);
    }),
  );

  it.effect("notifies on auth change after logout", () =>
    Effect.gen(function* () {
      const notified = yield* Deferred.make<void>();
      const invocations = yield* Ref.make<Array<SpawnedCommand>>([]);
      const scripts = yield* Ref.make<Array<ScriptedProcess>>([
        script([""], 0),
        script(["Not logged in"], 0),
      ]);
      const spawner = yield* makeFakeSpawner({ scripts, invocations });
      const controller = yield* makeCliLoginAuthController({
        instanceId,
        recipe: codexLoginRecipe,
        command: codexLoginRecipe.defaultCommand,
        env: {},
        onAuthChanged: Deferred.succeed(notified, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const idle = yield* controller.logout(stopSessions());
      assert.strictEqual(idle.phase, "idle");
      assert.isTrue(yield* Deferred.poll(notified).pipe(Effect.map(Option.isSome)));
    }),
  );

  it.effect("expires a flow past its device-code lifetime", () =>
    Effect.gen(function* () {
      const shortRecipe: CliLoginRecipe = { ...codexLoginRecipe, expiresInMs: 60_000 };
      const harness = yield* makeHarness({
        recipe: shortRecipe,
        scripts: [script(["sign in…"], "hang")],
      });
      yield* harness.controller.start(owner, stopSessions());
      yield* TestClock.adjust(61_000);
      const failed = yield* awaitPhase(harness.controller, "failed");
      assert.match(failed.message ?? "", /expired/);
    }),
  );

  it.effect("reports a missing CLI as a failed flow", () =>
    Effect.gen(function* () {
      const failing = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "spawn codex ENOENT",
          }),
        ),
      );
      const controller = yield* makeCliLoginAuthController({
        instanceId,
        recipe: codexLoginRecipe,
        command: codexLoginRecipe.defaultCommand,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failing));
      const failed = yield* controller.start(owner, stopSessions());
      assert.strictEqual(failed.phase, "failed");
      assert.match(failed.message ?? "", /not installed/);
    }),
  );
});
