import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ProviderAuthState,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { collectStreamAsString } from "./providerSnapshot.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

/**
 * How one CLI login completes. `process-exit` flows (Codex device auth)
 * finish on their own once the user is done in the browser; `stdin-code`
 * flows (Claude) print an authorization URL and then block reading a pasted
 * code from stdin, which arrives through the `complete` RPC.
 */
export type CliLoginCompletion = "process-exit" | "stdin-code";

export interface CliLoginParse {
  readonly authorizationUrl?: string | undefined;
  readonly userCode?: string | undefined;
}

/**
 * Static per-driver knowledge for driving a harness CLI's own login from
 * inside T3 Code — the in-app "connect this provider" button. The
 * recipes deliberately use the CLIs' headless-friendly flows (Codex device
 * auth, Claude's printed URL + pasted code) so sign-in works when the
 * browser is on another machine; no loopback listener on the environment is
 * ever required. The token stays where the CLI keeps it — T3 only reads the
 * resulting login state back, so subscription models stay harness-bound.
 */
export interface CliLoginRecipe {
  readonly driver: ProviderDriverKind;
  /** Account label for status messages, e.g. "ChatGPT", "Claude". */
  readonly accountLabel: string;
  /** CLI name for messages, e.g. "codex", "claude". */
  readonly cliName: string;
  /** Binary used when the instance configures no explicit binaryPath. */
  readonly defaultCommand: string;
  readonly loginArgs: ReadonlyArray<string>;
  readonly logoutArgs: ReadonlyArray<string>;
  readonly statusArgs: ReadonlyArray<string>;
  readonly completion: CliLoginCompletion;
  /** Device/paste-code expiry; the flow is killed past this point. */
  readonly expiresInMs: number;
  readonly parseLoginOutput: (text: string) => CliLoginParse;
  readonly parseStatus: (
    stdout: string,
    exitCode: number,
  ) => "authenticated" | "unauthenticated" | "unknown";
}

// eslint-disable-next-line no-control-regex -- ANSI color codes in CLI output
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(/\r/g, "");
}

function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]]+$/u, "");
}

function firstUrl(text: string): string | undefined {
  const match = stripAnsi(text).match(URL_PATTERN);
  return match ? cleanUrl(match[0]!) : undefined;
}

function parseCodexLoginOutput(text: string): CliLoginParse {
  const clean = stripAnsi(text);
  const authorizationUrl = firstUrl(clean);
  // The one-time code prints on the line(s) after the "one-time code"
  // prompt, so only look downstream of it — the authorize URL above carries
  // base64url segments that must never match as a code.
  const promptIndex = clean.search(/one-time code/i);
  const downstream = promptIndex >= 0 ? clean.slice(promptIndex) : clean;
  const codeMatch = downstream.match(/([A-Z0-9]{4}-[A-Z0-9]{4,8})/);
  return {
    ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
    ...(codeMatch ? { userCode: codeMatch[1]! } : {}),
  };
}

function parseCodexStatus(stdout: string): "authenticated" | "unauthenticated" | "unknown" {
  const text = stripAnsi(stdout);
  if (/not logged in/i.test(text)) return "unauthenticated";
  if (/logged in/i.test(text)) return "authenticated";
  return "unknown";
}

function parseClaudeLoginOutput(text: string): CliLoginParse {
  const clean = stripAnsi(text);
  const visitMatch = clean.match(/visit:\s*(https?:\/\/\S+)/i);
  const authorizationUrl = visitMatch ? cleanUrl(visitMatch[1]!) : firstUrl(clean);
  return authorizationUrl !== undefined ? { authorizationUrl } : {};
}

function parseClaudeStatus(stdout: string): "authenticated" | "unauthenticated" | "unknown" {
  const clean = stripAnsi(stdout).trim();
  try {
    const parsed: unknown = JSON.parse(clean || "null");
    if (parsed !== null && typeof parsed === "object" && "loggedIn" in parsed) {
      return (parsed as { loggedIn: unknown }).loggedIn === true
        ? "authenticated"
        : "unauthenticated";
    }
  } catch {
    // Fall through to the regex below.
  }
  const match = clean.match(/"loggedIn"\s*:\s*(true|false)/);
  if (match) return match[1] === "true" ? "authenticated" : "unauthenticated";
  return "unknown";
}

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * `codex login --device-auth` prints an authorize URL plus a one-time user
 * code and blocks until the browser flow finishes — remote-safe by
 * construction (no localhost listener). The plain `codex login` is avoided:
 * its loopback server binds on the environment, unreachable when the
 * browser is elsewhere.
 */
export const codexLoginRecipe: CliLoginRecipe = {
  driver: CODEX_DRIVER,
  accountLabel: "ChatGPT",
  cliName: "codex",
  defaultCommand: "codex",
  loginArgs: ["login", "--device-auth"],
  logoutArgs: ["logout"],
  statusArgs: ["login", "status"],
  completion: "process-exit",
  expiresInMs: 15 * 60 * 1_000,
  parseLoginOutput: parseCodexLoginOutput,
  parseStatus: (stdout) => parseCodexStatus(stdout),
};

/**
 * `claude auth login` prints an authorize URL and blocks on stdin for the
 * pasted code — the default subscription flow. The code arrives through the
 * `complete` RPC, so this works with the browser on any machine.
 */
export const claudeLoginRecipe: CliLoginRecipe = {
  driver: CLAUDE_DRIVER,
  accountLabel: "Claude",
  cliName: "claude",
  defaultCommand: "claude",
  loginArgs: ["auth", "login"],
  logoutArgs: ["auth", "logout"],
  statusArgs: ["auth", "status"],
  completion: "stdin-code",
  expiresInMs: 10 * 60 * 1_000,
  parseLoginOutput: parseClaudeLoginOutput,
  parseStatus: (stdout) => parseClaudeStatus(stdout),
};

export interface CliLoginAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly recipe: CliLoginRecipe;
  /** Explicit binaryPath, or the recipe default for PATH lookup. */
  readonly command: string;
  /**
   * Login environment WITHOUT the model-backend overlay: sign-in always
   * talks to the real vendor, never to a configured proxy.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Runs after the auth state observably changes (login success, logout).
   * Claude wires its capabilities-probe cache here so the next snapshot
   * refresh sees the new login state instead of the 5-minute TTL entry.
   */
  readonly onAuthChanged?: Effect.Effect<void> | undefined;
}

interface ActiveFlow {
  readonly id: string;
  readonly ownerSessionId: string;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly expiresAtIso: string;
}

const MAX_LOGIN_OUTPUT_BYTES = 128 * 1_024;
const STATUS_TIMEOUT_MS = 30_000;

function setupError(
  instanceId: ProviderInstanceId,
  operation: string,
  detail: string,
): ProviderSetupError {
  return new ProviderSetupError({ instanceId, operation, detail });
}

function visibleSnapshot(
  snapshot: { readonly ownerSessionId: string | null; readonly state: ProviderAuthState },
  ownerSessionId: string,
): ProviderAuthState {
  if (snapshot.ownerSessionId === null || snapshot.ownerSessionId === ownerSessionId) {
    return snapshot.state;
  }
  const busy = ["starting", "waiting", "verifying"].includes(snapshot.state.phase);
  const { userCode: _dropped, ...rest } = snapshot.state;
  return {
    ...rest,
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    ...(busy ? { message: "Sign-in is in progress in another client." } : {}),
  };
}

/**
 * Drives one instance's harness-CLI login as a `ProviderAuthController`, so
 * the existing sign-in RPCs (`start`/`complete`/`cancel`/`logout`/
 * `subscribe`) and the setup UI work for CLI drivers exactly like they do
 * for Antigravity — only the flow mechanics differ (CLI process instead of
 * ACP session). At most one flow runs per instance; a second `start` returns
 * the active flow's state.
 */
export const makeCliLoginAuthController = Effect.fn("makeCliLoginAuthController")(function* (
  options: CliLoginAuthOptions,
): Effect.fn.Return<
  ProviderAuthController,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const { instanceId, recipe } = options;
  const lock = yield* Semaphore.make(1);
  const initial: ProviderAuthState = {
    instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
  };
  const snapshot = yield* SubscriptionRef.make<{
    readonly ownerSessionId: string | null;
    readonly state: ProviderAuthState;
  }>({ ownerSessionId: null, state: initial });
  const activeFlow = yield* Ref.make<ActiveFlow | null>(null);

  const publish = (ownerSessionId: string | null, state: ProviderAuthState) =>
    SubscriptionRef.set(snapshot, { ownerSessionId, state });

  const clearFlowIfCurrent = (id: string) =>
    Ref.update(activeFlow, (current) => (current?.id === id ? null : current));

  const killChild = (child: ChildProcessSpawner.ChildProcessHandle) => Effect.ignore(child.kill());

  // Final safety net: an instance rebuild kills a lingering login process.
  yield* Scope.addFinalizer(
    scope,
    Ref.get(activeFlow).pipe(
      Effect.flatMap((flow) => (flow ? killChild(flow.child) : Effect.void)),
    ),
  );

  const spawnLogin = Effect.fn("cliLoginAuth.spawn")(function* (
    args: ReadonlyArray<string>,
    stdin: "pipe" | "ignore",
  ) {
    const resolved = yield* resolveSpawnCommand(options.command, args);
    return yield* ChildProcess.make(resolved.command, resolved.args, {
      env: options.env,
      extendEnv: true,
      stdin,
      stdout: "pipe",
      stderr: "pipe",
      shell: resolved.shell,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Scope.Scope, scope),
    );
  });

  const collectText = <E>(stream: Stream.Stream<Uint8Array, E>) =>
    collectStreamAsString(stream).pipe(Effect.orElseSucceed(() => ""));

  const runStatusCheck = Effect.fn("cliLoginAuth.statusCheck")(function* () {
    const child = yield* spawnLogin(recipe.statusArgs, "ignore");
    const [stdout] = yield* Effect.all([collectText(child.stdout)], {
      concurrency: "unbounded",
    });
    const code = yield* child.exitCode.pipe(Effect.map(Number));
    yield* killChild(child);
    return recipe.parseStatus(stdout, code);
  });

  const failFlow = Effect.fn("cliLoginAuth.failFlow")(function* (
    flow: ActiveFlow,
    message: string,
  ) {
    yield* killChild(flow.child);
    yield* clearFlowIfCurrent(flow.id);
    const state: ProviderAuthState = {
      instanceId,
      phase: "failed",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message,
    };
    yield* publish(flow.ownerSessionId, state);
    return state;
  });

  const notifyAuthChanged = options.onAuthChanged
    ? options.onAuthChanged.pipe(Effect.ignore)
    : Effect.void;

  const succeedFlow = Effect.fn("cliLoginAuth.succeedFlow")(function* (flow: ActiveFlow) {
    yield* killChild(flow.child);
    yield* clearFlowIfCurrent(flow.id);
    const state: ProviderAuthState = {
      instanceId,
      phase: "succeeded",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: "Sign-in complete.",
    };
    yield* publish(flow.ownerSessionId, state);
    yield* notifyAuthChanged;
    return state;
  });

  const monitorFlow = Effect.fn("cliLoginAuth.monitor")(function* (flow: ActiveFlow) {
    const seenUrl = yield* Ref.make(false);
    // Drain stdout continuously (backpressure would stall the CLI) and
    // publish `waiting` as soon as the authorize URL is parseable.
    const watchStdout = flow.child.stdout.pipe(
      Stream.decodeText(),
      Stream.runFoldEffect(
        () => "",
        (acc, chunk) =>
          Effect.gen(function* () {
            if (yield* Ref.get(seenUrl)) return acc;
            const next = acc.length > MAX_LOGIN_OUTPUT_BYTES ? chunk : acc + chunk;
            const parsed = recipe.parseLoginOutput(next);
            if (parsed.authorizationUrl !== undefined) {
              yield* Ref.set(seenUrl, true);
              yield* publish(flow.ownerSessionId, {
                instanceId,
                phase: "waiting",
                flowId: flow.id,
                authorizationUrl: parsed.authorizationUrl,
                ...(parsed.userCode !== undefined ? { userCode: parsed.userCode } : {}),
                expiresAt: flow.expiresAtIso,
                message:
                  recipe.completion === "stdin-code"
                    ? `Sign in with ${recipe.accountLabel} in the browser, then paste the code here.`
                    : "Open the sign-in page, then enter the code below.",
              });
            }
            return next;
          }),
      ),
    );
    // Drain stderr so a chatty CLI can never block on a full pipe. The
    // content is deliberately never surfaced: it may carry OAuth URLs or
    // native token data (see the `ProviderSetupError` contract note).
    const drainStderr = Stream.runDrain(flow.child.stderr);
    const waitExit = Effect.gen(function* () {
      const exited = yield* flow.child.exitCode.pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!exited) {
        yield* failFlow(flow, `${recipe.cliName} sign-in failed. Start sign-in again.`);
        return;
      }
      // A superseding cancel/logout clears the ref first, so a late exit
      // result is dropped instead of overwriting the terminal state.
      const current = yield* Ref.get(activeFlow);
      if (current?.id !== flow.id) return;
      const status = yield* runStatusCheck().pipe(
        Effect.timeout(STATUS_TIMEOUT_MS),
        Effect.orElseSucceed(() => "unknown" as const),
      );
      if (status === "authenticated") {
        yield* succeedFlow(flow);
        return;
      }
      yield* failFlow(
        flow,
        status === "unauthenticated"
          ? "Sign-in did not complete. Start sign-in again."
          : "Could not confirm sign-in status. Check the provider status and try again.",
      );
    });
    yield* Effect.all(
      [watchStdout.pipe(Effect.ignore), drainStderr.pipe(Effect.ignore), waitExit],
      {
        concurrency: "unbounded",
        discard: true,
      },
    ).pipe(Effect.ensuring(killChild(flow.child)));
  });

  const start: ProviderAuthController["start"] = (ownerSessionId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(activeFlow);
        if (current) {
          const view = yield* SubscriptionRef.get(snapshot);
          return visibleSnapshot(view, ownerSessionId);
        }
        const expiresAtIso = DateTime.formatIso(
          DateTime.addDuration(Duration.millis(recipe.expiresInMs))(yield* DateTime.now),
        );
        const starting: ProviderAuthState = {
          instanceId,
          phase: "starting",
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          message: `Starting ${recipe.accountLabel} sign-in.`,
        };
        yield* publish(ownerSessionId, starting);
        const child = yield* spawnLogin(
          recipe.loginArgs,
          recipe.completion === "stdin-code" ? "pipe" : "ignore",
        ).pipe(Effect.orElseSucceed(() => null));
        if (child === null) {
          const failed: ProviderAuthState = {
            instanceId,
            phase: "failed",
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            message: `${recipe.cliName} is not installed on this environment. Install it, then try again.`,
          };
          yield* publish(null, failed);
          return failed;
        }
        const flowId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() =>
            setupError(instanceId, "start", "Could not start sign-in. Try again."),
          ),
        );
        const flow: ActiveFlow = { id: flowId, ownerSessionId, child, expiresAtIso };
        yield* Ref.set(activeFlow, flow);
        // The monitor owns the flow lifetime; the expiry arm interrupts it
        // and publishes the terminal state, while cancel/logout clear the
        // ref first so a late monitor result is dropped. An internal
        // defect must never strand the UI in `waiting`: surface it as a
        // failed flow instead (stderr content is never included — it may
        // carry OAuth material).
        const monitor = monitorFlow(flow).pipe(
          Effect.timeoutOrElse({
            duration: recipe.expiresInMs,
            orElse: () => failFlow(flow, "Sign-in expired. Start sign-in again."),
          }),
          Effect.catchDefect(() => failFlow(flow, "Sign-in failed unexpectedly. Try again.")),
        );
        yield* Effect.forkIn(scope)(monitor);
        const started: ProviderAuthState = {
          ...starting,
          flowId,
        };
        yield* publish(ownerSessionId, started);
        return started;
      }),
    );

  const requireFlow = Effect.fn("cliLoginAuth.requireFlow")(function* (
    ownerSessionId: string,
    flowId: string,
    operation: string,
  ) {
    const flow = yield* Ref.get(activeFlow);
    if (!flow || flow.id !== flowId) {
      return yield* setupError(
        instanceId,
        operation,
        "This sign-in attempt is no longer active. Start sign-in again.",
      );
    }
    if (flow.ownerSessionId !== ownerSessionId) {
      return yield* setupError(instanceId, operation, "Sign-in is in progress in another client.");
    }
    return flow;
  });

  const complete: ProviderAuthController["complete"] = (ownerSessionId, input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const flow = yield* requireFlow(ownerSessionId, input.flowId, "complete");
        if (recipe.completion === "process-exit") {
          const view = yield* SubscriptionRef.get(snapshot);
          return visibleSnapshot(view, ownerSessionId);
        }
        const code = input.callbackUrl.trim();
        const encoded = new TextEncoder().encode(`${code}\n`);
        const written = yield* Stream.run(Stream.make(encoded), flow.child.stdin).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!written) {
          return yield* failFlow(flow, "Could not deliver the code. Start sign-in again.");
        }
        const state: ProviderAuthState = {
          instanceId,
          phase: "verifying",
          flowId: flow.id,
          authorizationUrl: null,
          expiresAt: flow.expiresAtIso,
          message: "Checking sign-in status.",
        };
        yield* publish(ownerSessionId, state);
        return state;
      }),
    );

  const cancel: ProviderAuthController["cancel"] = (ownerSessionId, flowId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const flow = yield* requireFlow(ownerSessionId, flowId, "cancel");
        yield* killChild(flow.child);
        yield* clearFlowIfCurrent(flow.id);
        const state: ProviderAuthState = {
          instanceId,
          phase: "cancelled",
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          message: "Sign-in cancelled.",
        };
        yield* publish(ownerSessionId, state);
        return state;
      }),
    );

  const logout: ProviderAuthController["logout"] = (stopSessions) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* stopSessions.pipe(
          Effect.mapError(() =>
            setupError(
              instanceId,
              "logout",
              "Could not stop all sessions for this provider. Try again.",
            ),
          ),
        );
        const flow = yield* Ref.get(activeFlow);
        if (flow) {
          yield* killChild(flow.child);
          yield* clearFlowIfCurrent(flow.id);
        }
        const child = yield* spawnLogin(recipe.logoutArgs, "ignore").pipe(
          Effect.orElseSucceed(() => null),
        );
        if (child === null) {
          return yield* setupError(
            instanceId,
            "logout",
            `${recipe.cliName} is not installed on this environment.`,
          );
        }
        yield* Effect.all([collectText(child.stdout), collectText(child.stderr), child.exitCode], {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.ignore);
        yield* killChild(child);
        // The CLI reports success even when it fails to clear the stored
        // credentials (seen with `claude auth logout` leaving ghost tokens
        // behind). Verify via the status probe so a no-op logout surfaces
        // as an error instead of snapping back to "Signed in."
        const statusAfterLogout = yield* runStatusCheck().pipe(
          Effect.timeout(STATUS_TIMEOUT_MS),
          Effect.orElseSucceed(() => "unknown" as const),
        );
        if (statusAfterLogout === "authenticated") {
          const state: ProviderAuthState = {
            instanceId,
            phase: "failed",
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            message: `${recipe.accountLabel} still reports signed in after logout. Run \`${recipe.cliName} ${recipe.logoutArgs.join(" ")}\` on this environment, then try again.`,
          };
          yield* publish(null, state);
          return yield* setupError(instanceId, "logout", state.message ?? "Sign-out failed.");
        }
        const state: ProviderAuthState = {
          instanceId,
          phase: "idle",
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          message: null,
        };
        yield* publish(null, state);
        yield* notifyAuthChanged;
        return state;
      }),
    );

  const subscribe: ProviderAuthController["subscribe"] = (ownerSessionId) =>
    SubscriptionRef.changes(snapshot).pipe(
      Stream.map((view) => visibleSnapshot(view, ownerSessionId)),
    );

  return { start, complete, cancel, logout, subscribe } satisfies ProviderAuthController;
});
