import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildDroidModelsFromSessionModelState,
  buildInitialDroidProviderSnapshot,
  droidModelsFromSettings,
  parseDroidDoctorAuth,
} from "./DroidProvider.ts";
import { DroidSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);

describe("Droid provider metadata", () => {
  effectIt.effect("reports disabled state when Droid is off", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(decodeDroidSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.length).toBeGreaterThan(0);
    }),
  );

  effectIt.effect("reports the checking state when Droid is on", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(
        decodeDroidSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toMatch(/Checking Droid CLI/);
    }),
  );

  it("keeps the auto entry as the built-in default", () => {
    const models = droidModelsFromSettings([]);
    expect(models.map((model) => model.slug)).toContain("auto");
  });

  it("marks Droid's current model as the live default", () => {
    const models = buildDroidModelsFromSessionModelState({
      currentModelId: "claude-opus-4-7",
      availableModels: [
        { modelId: "claude-opus-4-7", name: "Claude Opus 4.7" },
        { modelId: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map(({ slug, isDefault }) => ({ slug, isDefault }))).toEqual([
      { slug: "claude-opus-4-7", isDefault: true },
      { slug: "gpt-5.3-codex", isDefault: undefined },
    ]);
  });

  it("dedupes repeated model ids and drops blanks", () => {
    const models = buildDroidModelsFromSessionModelState({
      currentModelId: "claude-opus-4-7",
      availableModels: [
        { modelId: "claude-opus-4-7", name: "Claude Opus 4.7" },
        { modelId: "claude-opus-4-7", name: "Claude Opus 4.7 (dup)" },
        { modelId: "   ", name: "Blank" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-7"]);
  });

  it("returns no models when Droid advertises an empty catalog", () => {
    expect(
      buildDroidModelsFromSessionModelState({ currentModelId: "", availableModels: [] }),
    ).toEqual([]);
    expect(buildDroidModelsFromSessionModelState(null)).toEqual([]);
  });

  it("reads the login state from droid doctor --auth --json", () => {
    // Shape captured from Droid CLI 0.218.1 (logged out).
    expect(
      parseDroidDoctorAuth(
        JSON.stringify({
          generatedAt: "2026-09-12T14:43:27.753Z",
          timeoutMs: 10000,
          ok: true,
          results: [
            { id: "env.info", category: "environment", label: "Droid environment", status: "pass" },
            {
              id: "auth.credentials",
              category: "auth",
              label: "Credential storage read",
              status: "pass",
              detail: "credential storage responded; no stored login found",
            },
            {
              id: "auth.verify",
              category: "auth",
              label: "Auth verification",
              status: "warn",
              detail: "no usable credentials found (not logged in)",
              remediation: "Run `droid` and complete the login flow.",
            },
          ],
        }),
      ),
    ).toBe("unauthenticated");
    expect(
      parseDroidDoctorAuth(
        JSON.stringify({
          ok: true,
          results: [{ id: "auth.verify", label: "Auth verification", status: "pass" }],
        }),
      ),
    ).toBe("authenticated");
  });

  it("degrades the doctor login state to unknown when unparseable", () => {
    expect(parseDroidDoctorAuth("not json")).toBe("unknown");
    expect(parseDroidDoctorAuth(JSON.stringify({ ok: true, results: [] }))).toBe("unknown");
    expect(
      parseDroidDoctorAuth(
        JSON.stringify({
          ok: true,
          results: [{ id: "auth.verify", status: "warn", detail: "token expires soon" }],
        }),
      ),
    ).toBe("unknown");
  });
});
