/**
 * FreebuffProvider — snapshot builder + auth probe for Freebuff free mode.
 *
 * No local binary: `installed` is always true for an enabled instance;
 * readiness hinges on bearer-token resolution and `/api/v1/me`.
 *
 * @module provider/Layers/FreebuffProvider
 */
import {
  type CustomModelSetting,
  type FreebuffSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { fetchFreebuffMe, resolveFreebuffAuthToken } from "../freebuff/FreebuffRuntime.ts";

const FREEBUFF_PRESENTATION = {
  displayName: "Freebuff",
  requiresNewThreadForModelChange: false,
} as const;

const FREEBUFF_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * Curated Freebuff free-mode models. IDs mirror `FREEBUFF_MODELS` in the
 * Freebuff monorepo (`common/src/constants/freebuff-models.ts`); the default
 * is `z-ai/glm-5.3-flash`.
 */
const FREEBUFF_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    isCustom: false,
    isDefault: true,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4.1 Flash",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "upstage/solar-pro4",
    name: "Solar Pro 4",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "minimax/minimax-m3",
    name: "MiniMax M3",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "anthropic/claude-fable-5.1",
    name: "Claude Fable 5.1",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "meta/muse-spark-1.3-contributor",
    name: "Muse Spark 1.3",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "mimo/mimo-v2.5",
    name: "MiMo 2.6 Flash",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
  {
    slug: "mimo/mimo-v2.6-pro",
    name: "MiMo 2.6 Pro",
    isCustom: false,
    capabilities: FREEBUFF_MODEL_CAPABILITIES,
  },
];

export function freebuffModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = FREEBUFF_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], FREEBUFF_MODEL_CAPABILITIES);
}

export function buildInitialFreebuffProviderSnapshot(
  freebuffSettings: FreebuffSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = freebuffModelsFromSettings(freebuffSettings.customModels);

    if (!freebuffSettings.enabled) {
      return buildServerProvider({
        presentation: FREEBUFF_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Freebuff is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: FREEBUFF_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Freebuff authentication...",
      },
    });
  });
}

const AUTH_PROBE_TIMEOUT_MS = 8_000;

export const checkFreebuffProviderStatus = Effect.fn("checkFreebuffProviderStatus")(function* (
  freebuffSettings: FreebuffSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  Crypto.Crypto | FileSystem.FileSystem | HttpClient.HttpClient
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = freebuffModelsFromSettings(freebuffSettings.customModels);

  if (!freebuffSettings.enabled) {
    return buildServerProvider({
      presentation: FREEBUFF_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Freebuff is disabled in T3 Code settings.",
      },
    });
  }

  const token = yield* resolveFreebuffAuthToken(freebuffSettings, environment);
  if (!token) {
    return buildServerProvider({
      presentation: FREEBUFF_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Freebuff has no auth token. Set one in Settings or run `freebuff login`.",
      },
    });
  }

  const meResult = yield* fetchFreebuffMe({
    settings: freebuffSettings,
    environment,
    fileSystem: yield* FileSystem.FileSystem,
  }).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(meResult)) {
    yield* Effect.logWarning("Freebuff /me probe failed.", {
      errorTag: String(meResult.failure),
    });
    return buildServerProvider({
      presentation: FREEBUFF_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Freebuff authentication probe failed. Refresh provider status.",
      },
    });
  }

  if (Option.isNone(meResult.success)) {
    return buildServerProvider({
      presentation: FREEBUFF_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Freebuff /me probe timed out after ${AUTH_PROBE_TIMEOUT_MS}ms.`,
      },
    });
  }

  return buildServerProvider({
    presentation: FREEBUFF_PRESENTATION,
    enabled: true,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version: null,
      status: "ready",
      auth: {
        status: "authenticated",
        type: "api_key",
        label: "Freebuff free mode",
      },
    },
  });
});
