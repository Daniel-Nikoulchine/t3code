import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as BackendLastVerified from "./backendLastVerified.ts";

const instanceId = ProviderInstanceId.make("codex");
const baseSnapshot: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("BackendLastVerified", () => {
  it.effect("leaves snapshots untouched without a recorded verification", () =>
    Effect.gen(function* () {
      const tracker = yield* BackendLastVerified.BackendLastVerified;

      assert.notProperty(yield* tracker.stamp(baseSnapshot), "backendLastVerifiedAt");
    }).pipe(Effect.provide(BackendLastVerified.layer)),
  );

  it.effect("stamps recorded verifications with the Effect clock", () =>
    Effect.gen(function* () {
      const tracker = yield* BackendLastVerified.BackendLastVerified;

      // A moved test clock must move the stamp: timestamps come from the
      // Effect clock (testable), never from `Date.now` directly.
      yield* TestClock.adjust("365 days");
      yield* tracker.record(instanceId);
      const expected = DateTime.formatIso(yield* DateTime.now);

      assert.strictEqual((yield* tracker.stamp(baseSnapshot)).backendLastVerifiedAt, expected);
    }).pipe(Effect.provide(BackendLastVerified.layer)),
  );

  it.effect("skips synthetic unavailable snapshots", () =>
    Effect.gen(function* () {
      const tracker = yield* BackendLastVerified.BackendLastVerified;
      yield* tracker.record(instanceId);

      assert.notProperty(
        yield* tracker.stamp({ ...baseSnapshot, availability: "unavailable" }),
        "backendLastVerifiedAt",
      );
    }).pipe(Effect.provide(BackendLastVerified.layer)),
  );
});
