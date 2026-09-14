import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { makePiContinuationGroupKey, makePiEnvironment, resolvePiHomePath } from "./PiHome.ts";

it.layer(NodeServices.layer)("PiHome", (it) => {
  describe("Pi home resolution", () => {
    it.effect("honors inherited PI_CODING_AGENT_DIR", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = { ...process.env, PI_CODING_AGENT_DIR: "/tmp/pi-shared" };
        const resolved = path.resolve("/tmp/pi-shared");
        expect(yield* resolvePiHomePath({ homePath: "" }, environment)).toBe(resolved);
        expect(yield* makePiContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `pi:home:${resolved}`,
        );
      }),
    );

    it.effect("lets explicit settings override the inherited home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".pi-work");
        const environment = { ...process.env, PI_CODING_AGENT_DIR: "/tmp/pi-shared" };
        expect(
          (yield* makePiEnvironment({ homePath: "~/.pi-work" }, environment)).PI_CODING_AGENT_DIR,
        ).toBe(resolved);
      }),
    );

    it.effect("uses the instance HOME for Pi's default directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = {
          ...process.env,
          HOME: "/tmp/remote-home",
          PI_CODING_AGENT_DIR: "",
        };
        expect(yield* resolvePiHomePath({ homePath: "" }, environment)).toBe(
          path.resolve("/tmp/remote-home/.pi/agent"),
        );
      }),
    );
  });
});
