import * as NodeOS from "node:os";

import type { PiSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Resolve the Pi agent directory (`PI_CODING_AGENT_DIR`, default
 * `~/.pi/agent`). Honors the instance `homePath` setting first, then the
 * inherited environment, then the platform default — mirroring
 * `HermesHome`/`ClaudeHome`.
 */
export const resolvePiHomePath = Effect.fn("resolvePiHomePath")(function* (
  config: Pick<PiSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configured = config.homePath.trim();
  const inherited = environment.PI_CODING_AGENT_DIR?.trim() || environment.PI_AGENT_DIR?.trim();
  const environmentHome = environment.HOME?.trim() || environment.USERPROFILE?.trim();
  const platform = yield* HostProcessPlatform;
  const platformDefault =
    platform === "win32" && environment.LOCALAPPDATA?.trim()
      ? path.join(environment.LOCALAPPDATA.trim(), "pi", "agent")
      : path.join(environmentHome || NodeOS.homedir(), ".pi", "agent");
  return path.resolve(expandHomePath(configured || inherited || platformDefault));
});

export const makePiEnvironment = Effect.fn("makePiEnvironment")(function* (
  config: Pick<PiSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  if (!config.homePath.trim()) return baseEnv;
  return {
    ...baseEnv,
    PI_CODING_AGENT_DIR: yield* resolvePiHomePath(config, baseEnv),
  };
});

export const makePiContinuationGroupKey = Effect.fn("makePiContinuationGroupKey")(function* (
  config: Pick<PiSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  return `pi:home:${yield* resolvePiHomePath(config, environment)}`;
});
