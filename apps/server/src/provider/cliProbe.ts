/**
 * cliProbe — the four-stage CLI JSON probe every `<cli> <args> --json`
 * discovery repeats.
 *
 * Grok (`inspect --json`), Zcode and OpenClaw (`skills list --json`) each
 * carried this identical pipeline: resolve the spawn command, collect
 * stdout, apply a probe timeout, reject non-zero exits, and decode the
 * payload — with failures typed per stage so callers can decide between
 * best-effort recovery and typed errors. The only per-CLI inputs are the
 * command/args, the timeout, the error constructor, and the stdout decoder;
 * error classes stay in their modules (tests pin the tags).
 *
 * @module provider/cliProbe
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "./providerSnapshot.ts";

export type CliProbeStage = "spawn" | "timeout" | "exit" | "decode";

export interface CliProbeErrorInput {
  readonly stage: CliProbeStage;
  readonly cwd?: string;
  readonly exitCode?: number;
  readonly cause?: unknown;
}

export interface CliJsonProbeInput<A, E> {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly makeError: (input: CliProbeErrorInput) => E;
  readonly decode: (stdout: string) => A | undefined;
}

/**
 * Run `command args`, collect stdout, and decode it. Stage failures surface
 * through `makeError`: `spawn` (resolve/spawn threw), `timeout` (no result
 * in time), `exit` (non-zero code), `decode` (payload unparseable).
 */
export const runCliJsonProbe = Effect.fn("runCliJsonProbe")(function* <A, E>(
  input: CliJsonProbeInput<A, E>,
) {
  const environment = input.environment ?? process.env;
  const cwd = input.cwd;
  const probeResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(input.command, [...input.args], {
      env: environment,
    });
    return yield* spawnAndCollect(
      input.command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(
    Effect.mapError((cause) => input.makeError({ stage: "spawn", ...(cwd ? { cwd } : {}), cause })),
    Effect.timeoutOption(input.timeoutMs),
  );

  if (Option.isNone(probeResult)) {
    return yield* Effect.fail(input.makeError({ stage: "timeout", ...(cwd ? { cwd } : {}) }));
  }
  const output = probeResult.value;
  if (output.code !== 0) {
    return yield* Effect.fail(
      input.makeError({ stage: "exit", ...(cwd ? { cwd } : {}), exitCode: output.code }),
    );
  }
  const decoded = input.decode(output.stdout);
  if (decoded === undefined) {
    return yield* Effect.fail(input.makeError({ stage: "decode", ...(cwd ? { cwd } : {}) }));
  }
  return decoded;
});
