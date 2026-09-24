import * as Schema from "effect/Schema";
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  isBackendBucketProviderId,
  isBackendBucketSlug,
  stripBackendBucketPrefix,
} from "../ModelBackendEnvironment.ts";

/**
 * PiRpcProtocol — pure types, builders, and parsers for the Pi / Oh-My-Pi
 * `--mode rpc` JSONL protocol.
 *
 * Pi (upstream `@mariozechner/pi-coding-agent`, forked as Oh-My-Pi `omp`)
 * speaks newline-delimited JSON over stdio: commands written to stdin,
 * `{"type":"response",...}` replies plus async agent `events` on stdout.
 * Framing follows strict JSONL semantics with LF as the only delimiter.
 *
 * This module is intentionally dependency-free (no Effect) so the parsing
 * rules stay unit-testable in isolation. The Effect-based transport lives in
 * `PiRpcClient.ts`.
 *
 * Protocol reference: pi `docs/rpc.md` (`--mode rpc`).
 *
 * @module provider/pi/PiRpcProtocol
 */

/** Reasoning effort levels accepted by `--thinking` / `set_thinking_level`. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && (PI_THINKING_LEVELS as ReadonlyArray<string>).includes(value);
}

/** How a `prompt` issued while the agent streams is queued. */
export type PiStreamingBehavior = "steer" | "followUp";

// ── Outbound commands ────────────────────────────────────────────────

export interface PiRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type PiRpcPromptCommand = {
  readonly type: "prompt";
  readonly message: string;
  readonly images?: ReadonlyArray<PiRpcImage>;
  readonly streamingBehavior?: PiStreamingBehavior;
  readonly id?: string;
};

export type PiRpcCommand =
  | (PiRpcPromptCommand & { readonly type: "prompt" })
  | {
      readonly type: "steer";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
      readonly id?: string;
    }
  | {
      readonly type: "follow_up";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
      readonly id?: string;
    }
  | { readonly type: "abort"; readonly id?: string }
  | { readonly type: "new_session"; readonly parentSession?: string; readonly id?: string }
  | { readonly type: "get_state"; readonly id?: string }
  | { readonly type: "get_messages"; readonly id?: string }
  | {
      readonly type: "set_model";
      readonly provider: string;
      readonly modelId: string;
      readonly id?: string;
    }
  | { readonly type: "cycle_model"; readonly id?: string }
  | { readonly type: "get_available_models"; readonly id?: string }
  | { readonly type: "set_thinking_level"; readonly level: PiThinkingLevel; readonly id?: string }
  | { readonly type: "cycle_thinking_level"; readonly id?: string }
  | {
      readonly type: "set_steering_mode";
      readonly mode: "all" | "one-at-a-time";
      readonly id?: string;
    }
  | {
      readonly type: "set_follow_up_mode";
      readonly mode: "all" | "one-at-a-time";
      readonly id?: string;
    }
  | { readonly type: "compact"; readonly customInstructions?: string; readonly id?: string }
  | { readonly type: "set_auto_compaction"; readonly enabled: boolean; readonly id?: string }
  | { readonly type: "set_auto_retry"; readonly enabled: boolean; readonly id?: string }
  | { readonly type: "abort_retry"; readonly id?: string }
  | { readonly type: "bash"; readonly command: string; readonly id?: string }
  | { readonly type: "abort_bash"; readonly id?: string }
  | { readonly type: "get_session_stats"; readonly id?: string }
  | { readonly type: "export_html"; readonly outputPath?: string; readonly id?: string }
  | { readonly type: "switch_session"; readonly sessionPath: string; readonly id?: string }
  | { readonly type: "fork"; readonly entryId: string; readonly id?: string }
  | { readonly type: "clone"; readonly id?: string }
  | { readonly type: "get_fork_messages"; readonly id?: string }
  | { readonly type: "get_last_assistant_text"; readonly id?: string }
  | { readonly type: "set_session_name"; readonly name: string; readonly id?: string }
  | { readonly type: "get_commands"; readonly id?: string };

export function buildPromptCommand(input: {
  readonly message: string;
  readonly images?: ReadonlyArray<PiRpcImage>;
  readonly streamingBehavior?: PiStreamingBehavior;
  readonly id?: string;
}): PiRpcCommand {
  return {
    type: "prompt",
    message: input.message,
    ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}),
    ...(input.id ? { id: input.id } : {}),
  };
}

// ── Responses ────────────────────────────────────────────────────────

export interface PiRpcResponse {
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly id?: string;
  readonly data?: unknown;
  readonly error?: string;
}

// ── Events ───────────────────────────────────────────────────────────

export type PiRpcEventType =
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "queue_update"
  | "compaction_start"
  | "compaction_end"
  | "auto_retry_start"
  | "auto_retry_end"
  | "extension_error"
  | "extension_ui_request";

export interface PiRpcEvent {
  readonly type: PiRpcEventType;
  readonly [key: string]: unknown;
}

const PI_RPC_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "extension_error",
  "extension_ui_request",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPiRpcResponse(value: unknown): value is PiRpcResponse {
  return isRecord(value) && value.type === "response" && typeof value.command === "string";
}

export function isPiRpcEvent(value: unknown): value is PiRpcEvent {
  return isRecord(value) && typeof value.type === "string" && PI_RPC_EVENT_TYPES.has(value.type);
}

/**
 * Parse one stdout line. Returns the response, the event, or `undefined`
 * for blank lines. Throws `PiRpcLineParseError` (a plain Error with
 * `line` attached) for malformed JSON or unknown record types so the
 * transport can log-and-skip without killing the reader.
 */
export function parseRpcLine(line: string): PiRpcResponse | PiRpcEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(trimmed);
  } catch (cause) {
    throw new PiRpcLineParseError(`Pi RPC line is not valid JSON: ${trimmed.slice(0, 200)}`, {
      line: trimmed.slice(0, 2000),
      cause,
    });
  }
  if (isPiRpcResponse(parsed) || isPiRpcEvent(parsed)) return parsed;
  throw new PiRpcLineParseError(
    `Pi RPC line is neither a response nor a known event: ${trimmed.slice(0, 200)}`,
    { line: trimmed.slice(0, 2000) },
  );
}

export class PiRpcLineParseError extends Error {
  readonly line: string | undefined;
  override readonly cause: unknown;
  constructor(message: string, options?: { readonly line?: string; readonly cause?: unknown }) {
    super(message);
    this.name = "PiRpcLineParseError";
    this.line = options?.line;
    this.cause = options?.cause;
  }
}

// ── Session state / models / commands ────────────────────────────────

export interface PiRpcModelCost {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface PiRpcModel {
  readonly id: string;
  readonly name?: string;
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: PiRpcModelCost;
  readonly [key: string]: unknown;
}

export interface PiRpcSessionState {
  readonly model: PiRpcModel | null;
  readonly thinkingLevel?: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly messageCount?: number;
}

export function parseSessionState(data: unknown): PiRpcSessionState | undefined {
  if (!isRecord(data)) return undefined;
  const model =
    isRecord(data.model) && typeof data.model.id === "string" ? (data.model as PiRpcModel) : null;
  return {
    model,
    ...(typeof data.thinkingLevel === "string" ? { thinkingLevel: data.thinkingLevel } : {}),
    isStreaming: data.isStreaming === true,
    isCompacting: data.isCompacting === true,
    ...(typeof data.sessionFile === "string" ? { sessionFile: data.sessionFile } : {}),
    ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}),
    ...(typeof data.sessionName === "string" ? { sessionName: data.sessionName } : {}),
    ...(typeof data.messageCount === "number" ? { messageCount: data.messageCount } : {}),
  };
}

export function parseAvailableModels(data: unknown): ReadonlyArray<PiRpcModel> {
  if (!isRecord(data) || !Array.isArray(data.models)) return [];
  const models: PiRpcModel[] = [];
  for (const entry of data.models) {
    if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
      models.push({ ...entry, id: entry.id.trim() } as PiRpcModel);
    }
  }
  return models;
}

export interface PiRpcCommandDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly location?: string;
  readonly path?: string;
}

export function parseCommandDescriptors(data: unknown): ReadonlyArray<PiRpcCommandDescriptor> {
  if (!isRecord(data) || !Array.isArray(data.commands)) return [];
  const descriptors: PiRpcCommandDescriptor[] = [];
  for (const entry of data.commands) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) continue;
    // Newer harnesses nest file metadata in `sourceInfo` ({path, scope}).
    const sourceInfo = isRecord(entry.sourceInfo) ? entry.sourceInfo : undefined;
    const path =
      typeof entry.path === "string"
        ? entry.path
        : typeof sourceInfo?.path === "string"
          ? (sourceInfo.path as string)
          : undefined;
    const location =
      typeof entry.location === "string"
        ? entry.location
        : typeof sourceInfo?.scope === "string"
          ? (sourceInfo.scope as string)
          : undefined;
    descriptors.push({
      name: entry.name.trim(),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.source === "string" ? { source: entry.source } : {}),
      ...(location ? { location } : {}),
      ...(path ? { path } : {}),
    });
  }
  return descriptors;
}

/** Skill commands surface as `/skill:<name>` entries in `get_commands`. */
export function extractSkillNames(commands: ReadonlyArray<PiRpcCommandDescriptor>): ReadonlyArray<{
  readonly name: string;
  readonly description?: string;
  readonly path?: string;
  readonly location?: string;
}> {
  const skills: Array<{
    readonly name: string;
    readonly description?: string;
    readonly path?: string;
    readonly location?: string;
  }> = [];
  for (const command of commands) {
    if (command.source !== "skill") continue;
    const name = command.name.startsWith("skill:")
      ? command.name.slice("skill:".length)
      : command.name;
    if (!name.trim() || skills.some((skill) => skill.name === name)) continue;
    skills.push({
      name: name.trim(),
      ...(command.description ? { description: command.description } : {}),
      ...(command.path ? { path: command.path } : {}),
      ...(command.location ? { location: command.location } : {}),
    });
  }
  return skills;
}

/** Prompt-template commands (slash commands) from `get_commands`. */
export function extractSlashCommands(
  commands: ReadonlyArray<PiRpcCommandDescriptor>,
): ReadonlyArray<{ readonly name: string; readonly description?: string }> {
  const slash: Array<{ readonly name: string; readonly description?: string }> = [];
  for (const command of commands) {
    if (command.source !== "prompt") continue;
    const name = command.name.replace(/^\/+/, "").trim();
    if (!name || slash.some((entry) => entry.name === name)) continue;
    slash.push({
      name,
      ...(command.description ? { description: command.description } : {}),
    });
  }
  return slash;
}

// ── Message text extraction ──────────────────────────────────────────

function textFromContentBlock(block: unknown): string | undefined {
  if (!isRecord(block)) return undefined;
  if (typeof block.text === "string") return block.text;
  // Image / tool blocks carry no assistant text.
  return undefined;
}

export function textFromAgentMessage(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const text = textFromContentBlock(block);
    if (text) parts.push(text);
  }
  return parts.join("");
}

export function lastAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isRecord(message) && message.role === "assistant") {
      const text = textFromAgentMessage(message).trim();
      if (text) return text;
    }
  }
  return undefined;
}

/** Delta text from a `message_update` event's `assistantMessageEvent`. */
export function deltaFromMessageUpdate(event: PiRpcEvent): string | undefined {
  const assistantEvent = event.assistantMessageEvent;
  if (!isRecord(assistantEvent)) return undefined;
  switch (assistantEvent.type) {
    case "text_delta":
    case "thinking_delta":
      return typeof assistantEvent.delta === "string" ? assistantEvent.delta : undefined;
    default:
      return undefined;
  }
}

export function isThinkingDelta(event: PiRpcEvent): boolean {
  return (
    isRecord(event.assistantMessageEvent) && event.assistantMessageEvent.type === "thinking_delta"
  );
}

export function toolCallFromToolEvent(event: PiRpcEvent):
  | {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | undefined {
  const toolCallId = event.toolCallId;
  const toolName = event.toolName;
  if (typeof toolCallId !== "string" || !toolCallId || typeof toolName !== "string" || !toolName) {
    return undefined;
  }
  return { toolCallId, toolName, args: event.args };
}

// ── Auth diagnostics ─────────────────────────────────────────────────

/** Matches pi's "No API key found for <provider>" prompt rejection. */
export function parseMissingApiKeyProvider(text: string): string | undefined {
  const match = /no api key found for\s+([a-z0-9][a-z0-9._-]*)/i.exec(text);
  return match?.[1]?.replace(/[.]+$/, "").trim() || undefined;
}

export function isNotLoggedInText(text: string): boolean {
  return /not logged in|not authenticated|use \/login/i.test(text);
}

/**
 * Split a `provider/id` model reference. Returns the bare id as `modelId`
 * when no provider prefix is present.
 */
export function splitProviderModel(value: string): {
  readonly provider?: string;
  readonly modelId: string;
} {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return { modelId: trimmed };
  const provider = trimmed.slice(0, slash).trim();
  return {
    ...(provider ? { provider } : {}),
    modelId: trimmed.slice(slash + 1).trim() || trimmed,
  };
}

// ── T3 model slugs / resume cursors / catalog mapping ─────────────────
// Ported from the `t3code/pi-provider` thread: the Pi session/turn runtime
// (`Layers/PiAdapter.ts`), the snapshot probe (`Layers/PiProvider.ts`), and
// Pi text generation address models through these helpers.

export const PI_RESUME_VERSION = 1 as const;
export const PI_DEFAULT_MODEL_SLUG = "default" as const;

/**
 * Normalize a T3 `reasoningEffort` option value onto pi's thinking levels.
 * Hermes uses `none` where pi uses `off`; accept both.
 */
export function normalizePiThinkingLevel(
  value: string | null | undefined,
): PiThinkingLevel | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === "none") return "off";
  return isPiThinkingLevel(trimmed) ? trimmed : undefined;
}

export interface PiModelRef {
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
}

/**
 * Split a T3 pi model slug into its pi provider + model id.
 * `"default"` (and empty) means "pi default" — no explicit selection.
 *
 * Model slug convention (T3 side):
 *   - `"default"` — use pi's configured default.
 *   - `"<piProvider>/<modelId>"` — explicit (split on the FIRST `/`, since
 *     the model id itself may contain `/`).
 *   - bare ids without `/` are a pi model id on the default provider.
 */
export function parsePiModelSlug(slug: string | null | undefined): PiModelRef {
  const trimmed = slug?.trim() ?? "";
  if (!trimmed || trimmed === PI_DEFAULT_MODEL_SLUG) return {};
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return { modelId: trimmed };
  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  return {
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

/** Inverse of `parsePiModelSlug` for discovered catalog entries. */
export function buildPiModelSlug(provider: string, modelId: string): string {
  const cleanProvider = provider.trim();
  const cleanId = modelId.trim();
  if (!cleanProvider) return cleanId;
  if (!cleanId || cleanId === PI_DEFAULT_MODEL_SLUG) return PI_DEFAULT_MODEL_SLUG;
  return `${cleanProvider}/${cleanId}`;
}

/** `null`/`"default"` stay unset so pi keeps its configured model. */
export function resolvePiModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim() ?? "";
  if (!trimmed || trimmed === PI_DEFAULT_MODEL_SLUG) return undefined;
  return trimmed;
}

export interface PiResumeCursor {
  readonly sessionFile?: string | undefined;
  readonly sessionId?: string | undefined;
}

export function parsePiResume(raw: unknown): PiResumeCursor | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== PI_RESUME_VERSION) return undefined;
  const sessionFile =
    typeof record.sessionFile === "string" && record.sessionFile.trim()
      ? record.sessionFile.trim()
      : undefined;
  const sessionId =
    typeof record.sessionId === "string" && record.sessionId.trim()
      ? record.sessionId.trim()
      : undefined;
  if (!sessionFile && !sessionId) return undefined;
  return {
    ...(sessionFile ? { sessionFile } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export function buildPiResumeCursor(input: {
  readonly sessionFile?: string | undefined;
  readonly sessionId?: string | undefined;
}): Record<string, unknown> {
  return {
    schemaVersion: PI_RESUME_VERSION,
    ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

/** `pi --version` prints a bare semver (`0.73.1`). */
export function parsePiVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export interface PiDiscoveredModel {
  readonly id: string;
  readonly name?: string | undefined;
  readonly provider: string;
  readonly reasoning?: boolean | undefined;
  readonly contextWindow?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export const PI_EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

// Reasoning picker, backed by pi's own verdict: the `t3-backend` extension
// declares `thinkingLevelMap` for off/minimal/low/medium/high (xhigh/max
// hidden as unverified), `supportsReasoningEffort` sends the mapped value
// as `reasoning_effort`, and the router translates it for Responses
// upstreams. Levels pi does not offer never reach the picker.
const PI_THINKING_EFFORTS: ReadonlyArray<string> = ["off", "minimal", "low", "medium", "high"];

function piReasoningLabel(effort: string): string {
  switch (effort) {
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    default:
      return effort;
  }
}

export function buildPiModelCapabilities(reasoning: boolean): ModelCapabilities {
  if (!reasoning) {
    return createModelCapabilities({ optionDescriptors: [] });
  }
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: PI_THINKING_EFFORTS.map((effort) =>
          effort === "low"
            ? { id: effort, label: piReasoningLabel(effort), isDefault: true }
            : { id: effort, label: piReasoningLabel(effort) },
        ),
        currentValue: "low",
      },
    ],
  });
}
export const PI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: PI_DEFAULT_MODEL_SLUG,
    name: "Pi Default",
    isCustom: false,
    isDefault: true,
    capabilities: buildPiModelCapabilities(true),
  },
];

/**
 * Map pi `get_available_models` entries onto T3 server models. Slugs are
 * `<provider>/<id>` so the same model id on two pi providers stays
 * distinguishable. The session's current model (when known) is marked
 * default; otherwise the first discovered model wins.
 */
export function buildPiModelsFromDiscovery(input: {
  readonly models: ReadonlyArray<PiDiscoveredModel>;
  readonly currentProvider?: string | undefined;
  readonly currentModelId?: string | undefined;
}): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const currentSlug =
    input.currentProvider && input.currentModelId
      ? buildPiModelSlug(input.currentProvider, input.currentModelId)
      : input.currentModelId
        ? input.currentModelId.trim() || undefined
        : undefined;
  return input.models.flatMap((model): ServerProviderModel[] => {
    const id = model.id.trim();
    const provider = model.provider.trim();
    if (!id || !provider) return [];
    const slug = buildPiModelSlug(provider, id);
    if (seen.has(slug)) return [];
    seen.add(slug);
    // Note: `slug` above keeps the full `provider/id` path for routing.
    const cleanId = isBackendBucketProviderId(provider) ? stripBackendBucketPrefix(id) : id;
    const name = model.name?.trim() || cleanId;
    const upstreamSlash = isBackendBucketProviderId(provider) ? cleanId.indexOf("/") : -1;
    const subProvider = isBackendBucketProviderId(provider)
      ? upstreamSlash > 0
        ? cleanId.slice(0, upstreamSlash)
        : undefined
      : provider;
    const displayName = upstreamSlash > 0 ? cleanId.slice(upstreamSlash + 1) : name;
    return [
      {
        slug,
        name: displayName,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        ...(currentSlug === slug ? { isDefault: true } : {}),
        capabilities: buildPiModelCapabilities(model.reasoning === true),
      },
    ];
  });
}

/** Display name + sub-provider for a custom slug; strips the harness bucket prefix. */
function resolveBackendBucketDisplay(trimmed: string): { name: string; subProvider?: string } {
  const displaySlug = stripBackendBucketPrefix(trimmed);
  const upstreamSlash = displaySlug.indexOf("/");
  if (!isBackendBucketSlug(trimmed) || upstreamSlash <= 0) return { name: displaySlug };
  return {
    name: displaySlug.slice(upstreamSlash + 1),
    subProvider: displaySlug.slice(0, upstreamSlash),
  };
}

/** Fold `customModels` (bare slugs) onto the discovered catalog. */
export function piModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = PI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set(builtInModels.map((model) => model.slug));
  const custom: ServerProviderModel[] = [];
  for (const candidate of customModels ?? []) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    // Backend-wired instances append `t3-backend/<slug>` custom models. The
    // bucket is T3's harness side — strip it from display and surface any
    // nested upstream as the subtitle. Slug keeps the full path for routing.
    const { name, subProvider } = resolveBackendBucketDisplay(trimmed);
    custom.push({
      slug: trimmed,
      name,
      isCustom: true,
      ...(subProvider ? { subProvider } : {}),
      capabilities: PI_EMPTY_CAPABILITIES,
    });
  }
  return [...builtInModels, ...custom];
}

/** Merge discovered models with settings (discovery wins, customs append). */
export function piModelsWithDiscovery(
  customModels: ReadonlyArray<string> | undefined,
  discovered: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  if (discovered.length === 0) return piModelsFromSettings(customModels);
  const seen = new Set(discovered.map((model) => model.slug));
  // Keep the "Pi Default" routing entry so users can stay on pi's configured
  // default instead of being forced onto the first concrete model.
  const base: ServerProviderModel[] =
    seen.has(PI_DEFAULT_MODEL_SLUG) || discovered.some((model) => model.isDefault)
      ? [...discovered]
      : [...PI_BUILT_IN_MODELS, ...discovered];
  for (const candidate of customModels ?? []) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const { name, subProvider } = resolveBackendBucketDisplay(trimmed);
    base.push({
      slug: trimmed,
      name,
      isCustom: true,
      ...(subProvider ? { subProvider } : {}),
      capabilities: PI_EMPTY_CAPABILITIES,
    });
  }
  // If discovery did not mark a default, keep the built-in default flag.
  if (!base.some((model) => model.isDefault) && base.length > 0) {
    return base.map((model, index) => (index === 0 ? { ...model, isDefault: true } : model));
  }
  return base;
}

/** Slash commands advertised by pi (`get_commands` RPC). */
export function piSlashCommandsFromNames(
  names: ReadonlyArray<string>,
): ReadonlyArray<{ readonly name: string }> {
  const seen = new Set<string>();
  const out: Array<{ readonly name: string }> = [];
  for (const raw of names) {
    const name = raw.trim().replace(/^\/+/, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name });
  }
  return out;
}
