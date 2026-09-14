// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DeepSeekSettings } from "@t3tools/contracts";

import {
  buildDeepSeekModelCapabilities,
  buildDeepSeekModelsFromSessionModelState,
  buildInitialDeepSeekProviderSnapshot,
  checkDeepSeekProviderStatus,
  parseDeepSeekModelsCliOutput,
} from "./DeepSeekProvider.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_MODELS_OUTPUT = [
  "You are logged in with deepseek.com.",
  "",
  "Default model: deepseek-4.6",
  "",
  "Available models:",
  "  * deepseek-4.6 (default)",
  "  - deepseek-4.5",
  "",
].join("\n");

const LOGGED_OUT_MODELS_OUTPUT = LOGGED_IN_MODELS_OUTPUT.replace(
  "You are logged in with deepseek.com.",
  "You are not authenticated.",
);

describe("parseDeepSeekModelsCliOutput", () => {
  it("reads login state and model slugs, marking the default", () => {
    const parsed = parseDeepSeekModelsCliOutput(LOGGED_IN_MODELS_OUTPUT);
    expect(parsed.authenticated).toBe(true);
    expect(parsed.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["deepseek-4.6", true],
      ["deepseek-4.5", false],
    ]);
  });

  it("detects a logged-out CLI even though it exits 0", () => {
    expect(parseDeepSeekModelsCliOutput(LOGGED_OUT_MODELS_OUTPUT).authenticated).toBe(false);
  });

  it("returns unknown auth for unrecognized output", () => {
    expect(parseDeepSeekModelsCliOutput("deepseek 9.9.9\n").authenticated).toBeNull();
  });
});

describe("buildDeepSeekModelsFromSessionModelState", () => {
  it("marks the agent's current model as default and keeps reasoning options", () => {
    const models = buildDeepSeekModelsFromSessionModelState({
      currentModelId: "deepseek-4.6",
      availableModels: [
        {
          modelId: "deepseek-4.6",
          name: "DeepSeek 4.6",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "high",
            reasoningEfforts: [{ value: "high", label: "High", default: true }],
          },
        },
        { modelId: "deepseek-4.5", name: "DeepSeek 4.5" },
      ],
    });
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["deepseek-4.6", true],
      ["deepseek-4.5", false],
    ]);
    expect(models[0]?.capabilities?.optionDescriptors).toHaveLength(1);
  });
});

describe("buildDeepSeekModelCapabilities", () => {
  it("preserves ACP-provided reasoning labels and the active default", () => {
    const capabilities = buildDeepSeekModelCapabilities({
      modelId: "deepseek-4.6",
      name: "DeepSeek 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "xhigh",
        reasoningEfforts: [
          { value: "xhigh", label: "Extra High Effort", default: true },
          { value: "high", label: "High Effort", default: true },
          { value: "medium", label: "Medium Effort" },
          { value: "low", label: "Low Effort" },
        ],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "xhigh",
        options: [
          { id: "xhigh", label: "Extra High Effort", isDefault: true },
          { id: "high", label: "High Effort" },
          { id: "medium", label: "Medium Effort" },
          { id: "low", label: "Low Effort" },
        ],
      },
    ]);
  });

  it("uses raw ACP values when option labels are omitted", () => {
    const capabilities = buildDeepSeekModelCapabilities({
      modelId: "deepseek-4.6",
      name: "DeepSeek 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "xhigh",
        reasoningEfforts: [{ value: "xhigh" }, { value: "medium" }],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "xhigh",
        options: [
          { id: "xhigh", label: "xhigh" },
          { id: "medium", label: "medium" },
        ],
      },
    ]);
  });

  it("keeps ACP current effort separate from its collapsed advertised default", () => {
    const capabilities = buildDeepSeekModelCapabilities({
      modelId: "deepseek-4.6",
      name: "DeepSeek 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "medium",
        reasoningEfforts: [
          { value: "xhigh", label: "Extra High Effort", default: true },
          { value: "high", label: "High Effort", default: true },
          { value: "medium", label: "Medium Effort" },
        ],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "medium",
        options: [
          { id: "xhigh", label: "Extra High Effort", isDefault: true },
          { id: "high", label: "High Effort" },
          { id: "medium", label: "Medium Effort" },
        ],
      },
    ]);
  });

  it("preserves ACP descriptions and falls back from invalid values to valid ids", () => {
    const capabilities = buildDeepSeekModelCapabilities({
      modelId: "deepseek-4.6",
      name: "DeepSeek 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          {
            id: "high",
            value: "not a token",
            label: "High Effort",
            description: "Higher implementation quality",
            default: true,
          },
          { id: "bad id", value: "also invalid", label: "Invalid" },
        ],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          {
            id: "high",
            label: "High Effort",
            description: "Higher implementation quality",
            isDefault: true,
          },
        ],
      },
    ]);
  });

  it("accepts an advertised ACP menu when the support flag is omitted", () => {
    const capabilities = buildDeepSeekModelCapabilities({
      modelId: "deepseek-4.6",
      name: "DeepSeek 4.6",
      _meta: {
        reasoningEffort: "high",
        reasoningEfforts: [{ value: "high", label: "High Effort", default: true }],
      },
    });

    expect(capabilities.optionDescriptors).toHaveLength(1);
  });

  it("honors an explicit ACP opt-out even when a menu is present", () => {
    const capabilities = buildDeepSeekModelCapabilities({
      modelId: "deepseek-4.6",
      name: "DeepSeek 4.6",
      _meta: {
        supportsReasoningEffort: false,
        reasoningEfforts: [{ value: "high", label: "High Effort", default: true }],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([]);
  });

  it("does not synthesize a reasoning menu when ACP omits it", () => {
    expect(
      buildDeepSeekModelCapabilities({
        modelId: "deepseek-4.6",
        name: "DeepSeek 4.6",
        _meta: { supportsReasoningEffort: true, reasoningEffort: "xhigh" },
      }).optionDescriptors,
    ).toEqual([]);
  });

  it("keeps non-reasoning DeepSeek models free of reasoning controls", () => {
    expect(
      buildDeepSeekModelCapabilities({ modelId: "deepseek-build", name: "DeepSeek Build" })
        .optionDescriptors,
    ).toEqual([]);
  });
});

describe("buildInitialDeepSeekProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDeepSeekProviderSnapshot(
        decodeDeepSeekSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — DeepSeek is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDeepSeekProviderSnapshot(decodeDeepSeekSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDeepSeekProviderSnapshot(
        decodeDeepSeekSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking DeepSeek");
      expect(snapshot.requiresNewThreadForModelChange).toBeUndefined();
    }),
  );
});

it.layer(NodeServices.layer)("checkDeepSeekProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDeepSeekProviderStatus(
        decodeDeepSeekSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/deepseek-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken deepseek install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-deepseek-version-" });
          const deepseekPath = path.join(dir, "deepseek");
          yield* fs.writeFileString(
            deepseekPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(deepseekPath, 0o755);

          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: deepseekPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("DeepSeek harness CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  // Single-quotes a path for /bin/sh. Temp dirs and execPath never contain quotes.
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

  // A shell stand-in for the dsh CLI: `--version` and `models` print canned text,
  // and `--profile acp` execs the mock ACP agent so `initialize` returns model metadata.
  const writeFakeDeepSeekCli = (input: { readonly modelsOutput: string; readonly acp: boolean }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-deepseek-probe-" });
      const modelsPath = path.join(dir, "models.txt");
      yield* fs.writeFileString(modelsPath, input.modelsOutput);
      const deepseekPath = path.join(dir, "dsh");
      const mockAgentPath = path.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");
      yield* fs.writeFileString(
        deepseekPath,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  --version) printf "dsh 0.1.5\\n"; exit 0;;',
          `  models) cat ${shellQuote(modelsPath)}; exit 0;;`,
          input.acp
            ? `  --profile) export T3_ACP_DEEPSEEK=1; exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)};;`
            : "  --profile) exit 3;;",
          "esac",
          "exit 1",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(deepseekPath, 0o755);
      return deepseekPath;
    });

  it.effect("reports ready with built-in models when logged in", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const deepseekPath = yield* writeFakeDeepSeekCli({
            // No login markers and no model bullets: the harness version
            // behind this output has no `models` subcommand.
            modelsOutput: "dsh 0.1.5\n",
            acp: true,
          });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: deepseekPath }),
            { ...process.env, DEEPSEEK_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.1.5");
      expect(snapshot.auth).toEqual({ status: "unknown" });
      // dsh advertises no model state on initialize; the shipped catalog is
      // authoritative until a session resolves live config options.
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "deepseek-flash",
        "deepseek-v4-flash-vision-exp",
      ]);
      expect(snapshot.models[0]?.isDefault).toBe(true);
      expect(
        snapshot.models[0]?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [],
      ).toEqual(["reasoningEffort"]);
    }),
  );

  it.effect("reports unauthenticated from `dsh models` without starting a session", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const deepseekPath = yield* writeFakeDeepSeekCli({
            modelsOutput: LOGGED_OUT_MODELS_OUTPUT,
            acp: true,
          });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: deepseekPath }),
            { ...process.env, DEEPSEEK_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("DEEPSEEK_API_KEY");
      // Without initialize model state the built-in catalog applies.
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "deepseek-flash",
        "deepseek-v4-flash-vision-exp",
      ]);
    }),
  );

  it.effect("falls back to CLI-listed models with a warning when ACP initialize fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const deepseekPath = yield* writeFakeDeepSeekCli({
            modelsOutput: LOGGED_IN_MODELS_OUTPUT,
            acp: false,
          });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: deepseekPath }),
            { ...process.env, DEEPSEEK_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
        ["deepseek-4.6", true],
        ["deepseek-4.5", false],
      ]);
      expect(snapshot.message).toContain("ACP initialize failed");
    }),
  );

  it.effect("treats DEEPSEEK_API_KEY as authenticated regardless of CLI login state", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const deepseekPath = yield* writeFakeDeepSeekCli({
            modelsOutput: LOGGED_OUT_MODELS_OUTPUT,
            acp: false,
          });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: deepseekPath }),
            { ...process.env, DEEPSEEK_API_KEY: "deepseek-test-key" },
          );
        }),
      );

      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "DeepSeek API key",
      });
      expect(snapshot.status).toBe("warning");
    }),
  );
});
