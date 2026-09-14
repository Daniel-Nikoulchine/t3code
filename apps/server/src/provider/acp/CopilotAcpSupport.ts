import { type CopilotSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const COPILOT_AUTH_METHOD_ID = "copilot-login";
export const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");

/** Default model slug — lets Copilot pick automatically. */
export const COPILOT_DEFAULT_MODEL_SLUG = "auto";

/**
 * Static model catalog from `copilot help config` (`model` setting).
 * The ACP `session/new` response carries no `models` field, so the provider
 * snapshot is built from this list plus user custom models. Availability of
 * individual models depends on the GitHub plan — restricted plans only allow
 * `auto` and the CLI reports "only Auto mode is available on your plan" when
 * selecting others via `/model <slug>`.
 */
export const COPILOT_KNOWN_MODELS: ReadonlyArray<{ slug: string; name: string }> = [
  { slug: "auto", name: "Auto" },
  { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { slug: "claude-fable-5.1", name: "Claude Fable 5.1" },
  { slug: "claude-fable-5", name: "Claude Fable 5" },
  { slug: "claude-opus-5", name: "Claude Opus 5" },
  { slug: "claude-opus-4.8", name: "Claude Opus 4.8" },
  { slug: "claude-opus-4.8-fast", name: "Claude Opus 4.8 Fast" },
  { slug: "claude-opus-4.7", name: "Claude Opus 4.7" },
  { slug: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
  { slug: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  { slug: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
  { slug: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
  { slug: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
  { slug: "gpt-5.5", name: "GPT 5.5" },
  { slug: "gpt-5.4", name: "GPT 5.4" },
  { slug: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
  { slug: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
  { slug: "gpt-5-mini", name: "GPT 5 Mini" },
  { slug: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash" },
  { slug: "mai-code-1-flash-picker", name: "MAI Code 1 Flash Picker" },
  { slug: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { slug: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
  { slug: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { slug: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { slug: "grok-4.5", name: "Grok 4.5" },
  { slug: "kimi-k3", name: "Kimi K3" },
  { slug: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
];

const COPILOT_EFFORT_TOKEN = /^(none|minimal|low|medium|high|xhigh|max)$/i;

export function isValidCopilotEffortToken(value: string): boolean {
  return COPILOT_EFFORT_TOKEN.test(value.trim());
}

export function normalizeCopilotEffort(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && isValidCopilotEffortToken(trimmed) ? trimmed : undefined;
}

export function resolveCopilotAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : COPILOT_DEFAULT_MODEL_SLUG;
  // Strip any `[variant]` suffix the picker may append, mirroring Cursor.
  const withoutVariant = base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
  return normalizeModelSlug(withoutVariant, COPILOT_DRIVER_KIND) ?? COPILOT_DEFAULT_MODEL_SLUG;
}

type CopilotAcpRuntimeCopilotSettings = Pick<CopilotSettings, "binaryPath">;

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /** Initial model for every session on this server (`--model`). */
  readonly model?: string | undefined;
  /** Initial reasoning effort (`--effort`). */
  readonly effort?: string | undefined;
}

export function copilotAcpSpawnArgs(input: {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}): ReadonlyArray<string> {
  const args: Array<string> = ["--acp"];
  const model = input.model?.trim();
  if (model) {
    args.push("--model", model);
  }
  const effort = normalizeCopilotEffort(input.effort);
  if (effort) {
    args.push("--effort", effort);
  }
  return args;
}

export function buildCopilotAcpSpawnInput(
  copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options?: { readonly model?: string | undefined; readonly effort?: string | undefined },
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: [...copilotAcpSpawnArgs(options ?? {})],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeCopilotAcpRuntime = (
  input: CopilotAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCopilotAcpSpawnInput(input.copilotSettings, input.cwd, input.environment, {
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        }),
        authMethodId: COPILOT_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Select a Copilot model inside a live session by sending `/model <slug>` as
 * a prompt. Bare `/model` only opens the interactive picker (unavailable over
 * ACP), but `/model <slug>` attempts the switch and reports
 * "Model changed to: …" or a plan-restriction error as agent text.
 *
 * Returns the slug that was requested so callers can record session state.
 * Failures to deliver the command itself become `E`; a plan-restriction reply
 * ("only Auto mode is available") is *not* an error here — the turn still
 * completes and the agent's message surfaces the restriction to the user.
 */
export function applyCopilotAcpModelSelection<E>(input: {
  readonly prompt: (
    prompt: ReadonlyArray<{ readonly type: "text"; readonly text: string }>,
  ) => Effect.Effect<unknown, E>;
  readonly model: string | null | undefined;
  readonly currentModel: string | undefined;
}): Effect.Effect<string | undefined, E> {
  const requested = resolveCopilotAcpBaseModelId(input.model);
  if (requested === (input.currentModel ?? COPILOT_DEFAULT_MODEL_SLUG)) {
    return Effect.succeed(undefined);
  }
  return input.prompt([{ type: "text", text: `/model ${requested}` }]).pipe(Effect.as(requested));
}
