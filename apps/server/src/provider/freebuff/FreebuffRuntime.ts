/**
 * FreebuffRuntime — network-direct client against codebuff.com.
 *
 * Auth resolution order: settings `authToken` override → Freebuff CLI
 * credentials (`$FREEBUFF_CONFIG_DIR|~/.config/manicode/credentials.json`
 * → `default.authToken`) → `$CODEBUFF_API_KEY`. No local binary.
 *
 * Session admission (`POST /api/v1/freebuff/session/admission`) takes a
 * single free slot per account; chat is OpenAI-compatible SSE on
 * `POST /api/v1/chat/completions` with Freebuff identity headers.
 *
 * @module provider/freebuff/FreebuffRuntime
 */
// @effect-diagnostics nodeBuiltinImport:off - pure sync config-dir helpers cannot use the Path service.
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  FREEBUFF_DEFAULT_MODEL,
  type FreebuffSettings,
  type ModelSelection,
} from "@t3tools/contracts";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { createSseParser } from "../router/modelRouterTranslation.ts";

const FREEBUFF_BASE_URL = "https://www.codebuff.com";
const SESSION_ADMISSION_TIMEOUT_MS = 20_000;
const CHAT_COMPLETION_TIMEOUT_MS = 180_000;
const ME_PROBE_TIMEOUT_MS = 8_000;
const CREDENTIALS_FILE = "credentials.json";

export class FreebuffError extends Schema.TaggedError<FreebuffError>()("FreebuffError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Freebuff ${this.operation} failed: ${this.detail}`;
  }
}

const isFreebuffError = Schema.is(FreebuffError);

const CredentialsFile = Schema.Struct({
  default: Schema.optional(
    Schema.Struct({
      authToken: Schema.optional(Schema.String),
    }),
  ),
});

const decodeCredentials = Schema.decodeUnknownEffect(CredentialsFile);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function parseJsonSafe(text: string): unknown | undefined {
  try {
    return decodeUnknownJson(text);
  } catch {
    return undefined;
  }
}

export type FreebuffSessionState =
  | "none"
  | "active"
  | "ended"
  | "superseded"
  | "country_blocked"
  | "banned"
  | "model_locked"
  | "model_unavailable"
  | "consent_required"
  | "first_tab_discount_changed";

export interface FreebuffSessionAdmission {
  readonly state: FreebuffSessionState;
  readonly sessionId?: string | undefined;
  readonly instanceId?: string | undefined;
  readonly accessTier?: string | undefined;
  readonly walletConsent?: unknown;
  readonly rateLimitsByModel?: unknown;
}

export interface FreebuffChatDelta {
  readonly text: string;
  readonly done: boolean;
}

export interface FreebuffUser {
  readonly id?: string | undefined;
  readonly email?: string | undefined;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Resolve the Freebuff config directory, mirroring `cli/src/utils/config-dir.ts`. */
export function resolveFreebuffConfigDir(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.FREEBUFF_CONFIG_DIR?.trim();
  if (override && NodePath.isAbsolute(override)) {
    return override;
  }
  const base =
    environment.XDG_CONFIG_HOME?.trim() || NodePath.join(environment.HOME ?? "", ".config");
  const envName = environment.NEXT_PUBLIC_CB_ENVIRONMENT?.trim();
  const suffix = envName && envName !== "prod" ? `-${envName}` : "";
  return NodePath.join(base, `manicode${suffix}`);
}

/**
 * Read the Freebuff CLI bearer token. Best-effort: a missing or malformed
 * file yields `undefined` so the caller can fall through to env.
 */
export function readFreebuffCredentialsToken(
  fileSystem: FileSystem.FileSystem,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string | undefined> {
  const credentialsPath = NodePath.join(resolveFreebuffConfigDir(environment), CREDENTIALS_FILE);
  return Effect.gen(function* () {
    const text = yield* fileSystem
      .readFileString(credentialsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!text) return undefined;
    const parsed = parseJsonSafe(text);
    if (parsed === undefined) return undefined;
    const decoded = yield* decodeCredentials(parsed).pipe(Effect.orElseSucceed(() => undefined));
    const token = decoded?.default?.authToken?.trim();
    return token && token.length > 0 ? token : undefined;
  });
}

/** Settings override → credentials.json → `$CODEBUFF_API_KEY`. */
export function resolveFreebuffAuthToken(
  settings: FreebuffSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const override = settings.authToken?.trim();
    if (override && override.length > 0) return override;
    const fromFile = yield* readFreebuffCredentialsToken(yield* FileSystem.FileSystem, environment);
    if (fromFile) return fromFile;
    const fromEnv = environment.CODEBUFF_API_KEY?.trim();
    return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
  });
}

export function resolveFreebuffModel(
  modelSelection: ModelSelection | undefined,
  fallback: string = FREEBUFF_DEFAULT_MODEL,
): string {
  const model = modelSelection?.model?.trim();
  return model && model.length > 0 ? model : fallback;
}

interface FreebuffHttpOptions {
  readonly settings: FreebuffSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
}

type FreebuffHttpServices = FileSystem.FileSystem | HttpClient.HttpClient;

const makeFreebuffRequest = (
  options: FreebuffHttpOptions,
  input: {
    readonly method: "GET" | "POST" | "DELETE";
    readonly path: string;
    readonly body?: unknown;
    readonly model?: string | undefined;
    readonly instanceId?: string | undefined;
    readonly reuseInstanceId?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const token = yield* resolveFreebuffAuthToken(options.settings, options.environment);
    if (!token) {
      return yield* new FreebuffError({
        operation: "auth",
        detail:
          "Freebuff is not authenticated. Set an auth token in Settings or run `freebuff login`.",
      });
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "x-freebuff-instance-id": input.instanceId ?? "t3-code",
      ...(input.reuseInstanceId ? { "x-freebuff-reuse-instance-id": input.reuseInstanceId } : {}),
      ...(input.model ? { "x-freebuff-model": input.model } : {}),
    };
    const url = `${trimTrailingSlashes(FREEBUFF_BASE_URL)}${input.path}`;
    let request =
      input.method === "GET"
        ? HttpClientRequest.get(url)
        : input.method === "DELETE"
          ? HttpClientRequest.delete(url)
          : HttpClientRequest.post(url);
    request = HttpClientRequest.setHeaders(headers)(request);
    if (input.body !== undefined && input.method !== "GET" && input.method !== "DELETE") {
      request = HttpClientRequest.bodyJsonUnsafe(input.body)(request);
    }
    return yield* httpClient.execute(request);
  });

/** Admission against the free session endpoint; never mutates local state. */
export const requestFreebuffSessionAdmission = (
  options: FreebuffHttpOptions & { readonly model: string; readonly instanceId?: string },
): Effect.Effect<FreebuffSessionAdmission, FreebuffError, FreebuffHttpServices> =>
  Effect.gen(function* () {
    const response = yield* makeFreebuffRequest(options, {
      method: "POST",
      path: "/api/v1/freebuff/session/admission",
      body: { freebuff_instance_id: options.instanceId ?? "t3-code" },
      model: options.model,
      instanceId: options.instanceId,
    }).pipe(
      Effect.timeout(SESSION_ADMISSION_TIMEOUT_MS),
      Effect.mapError(
        (cause) =>
          new FreebuffError({
            operation: "session/admission",
            detail: isFreebuffError(cause) ? cause.detail : String(cause),
            cause,
          }),
      ),
    );
    const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.mapError(
        () =>
          new FreebuffError({
            operation: "session/admission",
            detail: `rejected with HTTP ${response.status}.`,
          }),
      ),
    );
    const payload = yield* ok.json.pipe(
      Effect.mapError(
        (cause) =>
          new FreebuffError({
            operation: "session/admission",
            detail: "unreadable JSON response.",
            cause,
          }),
      ),
    );
    return parseFreebuffAdmission(payload);
  });

/** Best-effort parse of admission payload; unknown fields degrade gracefully. */
export function parseFreebuffAdmission(payload: unknown): FreebuffSessionAdmission {
  if (typeof payload !== "object" || payload === null) {
    return { state: "none" };
  }
  const record = payload as Record<string, unknown>;
  const rawState = typeof record.state === "string" ? record.state : "none";
  const state = (
    [
      "none",
      "active",
      "ended",
      "superseded",
      "country_blocked",
      "banned",
      "model_locked",
      "model_unavailable",
      "consent_required",
      "first_tab_discount_changed",
    ] as const
  ).includes(rawState as FreebuffSessionState)
    ? (rawState as FreebuffSessionState)
    : "none";
  const sessionId =
    typeof record.sessionId === "string" && record.sessionId.trim()
      ? record.sessionId.trim()
      : undefined;
  const instanceId =
    typeof record.instanceId === "string" && record.instanceId.trim()
      ? record.instanceId.trim()
      : undefined;
  const accessTier =
    typeof record.accessTier === "string" && record.accessTier.trim()
      ? record.accessTier.trim()
      : undefined;
  return {
    state,
    ...(sessionId ? { sessionId } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(accessTier ? { accessTier } : {}),
    ...(record.walletConsent !== undefined ? { walletConsent: record.walletConsent } : {}),
    ...(record.rateLimitsByModel !== undefined
      ? { rateLimitsByModel: record.rateLimitsByModel }
      : {}),
  };
}

/** `GET /api/v1/me` — auth probe for the provider snapshot. */
export const fetchFreebuffMe = (
  options: FreebuffHttpOptions,
): Effect.Effect<FreebuffUser | undefined, FreebuffError, FreebuffHttpServices> =>
  Effect.gen(function* () {
    const response = yield* makeFreebuffRequest(options, {
      method: "GET",
      path: "/api/v1/me",
    }).pipe(
      Effect.timeout(ME_PROBE_TIMEOUT_MS),
      Effect.mapError(
        (cause) =>
          new FreebuffError({
            operation: "me",
            detail: isFreebuffError(cause) ? cause.detail : String(cause),
            cause,
          }),
      ),
    );
    const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.mapError(
        () =>
          new FreebuffError({ operation: "me", detail: `rejected with HTTP ${response.status}.` }),
      ),
    );
    const payload = yield* ok.json.pipe(
      Effect.mapError(
        (cause) =>
          new FreebuffError({
            operation: "me",
            detail: "unreadable JSON response.",
            cause,
          }),
      ),
    );
    if (typeof payload !== "object" || payload === null) return undefined;
    const record = payload as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const email = typeof record.email === "string" ? record.email : undefined;
    const user: FreebuffUser = {
      ...(id ? { id } : {}),
      ...(email ? { email } : {}),
    };
    return user;
  });

/** Best-effort end of a free session; failures never fail the caller. */
export const endFreebuffSession = (
  options: FreebuffHttpOptions,
): Effect.Effect<void, never, FreebuffHttpServices> =>
  Effect.gen(function* () {
    const response = yield* makeFreebuffRequest(options, {
      method: "DELETE",
      path: "/api/v1/freebuff/session",
    }).pipe(
      Effect.timeout(SESSION_ADMISSION_TIMEOUT_MS),
      Effect.orElseSucceed(() => undefined),
    );
    if (!response) return;
    yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.ignore);
  }).pipe(Effect.ignore);

export interface FreebuffChatStreamInput {
  readonly settings: FreebuffSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly model: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly instanceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly stream?: boolean;
}

/**
 * OpenAI-compatible chat completion. When `stream` is true the response is
 * an SSE stream of `FreebuffChatDelta`; otherwise the full assistant text
 * is returned in one shot.
 */
export const freebuffChatCompletion = (
  input: FreebuffChatStreamInput,
): Effect.Effect<
  { readonly text: string; readonly done: boolean },
  FreebuffError,
  FreebuffHttpServices
> =>
  Effect.gen(function* () {
    const stream = input.stream ?? false;
    const body = {
      model: input.model,
      messages: input.messages,
      stream,
      ...(input.instanceId ? { freebuff_instance_id: input.instanceId } : {}),
    };
    const response = yield* makeFreebuffRequest(
      {
        settings: input.settings,
        environment: input.environment,
        fileSystem: input.fileSystem,
      },
      {
        method: "POST",
        path: "/api/v1/chat/completions",
        body,
        model: input.model,
        instanceId: input.instanceId,
        reuseInstanceId: input.sessionId,
      },
    ).pipe(
      Effect.timeout(CHAT_COMPLETION_TIMEOUT_MS),
      Effect.mapError(
        (cause) =>
          new FreebuffError({
            operation: "chat/completions",
            detail: isFreebuffError(cause) ? cause.detail : String(cause),
            cause,
          }),
      ),
    );
    const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.mapError(
        () =>
          new FreebuffError({
            operation: "chat/completions",
            detail: `rejected with HTTP ${response.status}.`,
          }),
      ),
    );

    if (!stream) {
      const payload = yield* ok.json.pipe(
        Effect.mapError(
          (cause) =>
            new FreebuffError({
              operation: "chat/completions",
              detail: "unreadable JSON response.",
              cause,
            }),
        ),
      );
      const text = extractOpenAiAssistantText(payload);
      if (!text) {
        return yield* new FreebuffError({
          operation: "chat/completions",
          detail: "returned an empty completion.",
        });
      }
      return { text, done: true };
    }

    const parser = createSseParser();
    const collected = yield* collectUint8StreamText({ stream: ok.stream }).pipe(
      Effect.mapError(
        (cause) =>
          new FreebuffError({
            operation: "chat/completions",
            detail: "stream read failed.",
            cause,
          }),
      ),
    );
    const frames = [...parser.push(collected.text), ...parser.end()];
    let text = "";
    let done = false;
    for (const frame of frames) {
      if (frame.data === "[DONE]") {
        done = true;
        continue;
      }
      const parsed = parseJsonSafe(frame.data);
      if (parsed === undefined) continue;
      const delta = extractOpenAiStreamDelta(parsed);
      if (delta) text += delta;
      if (isStreamDone(parsed)) done = true;
    }
    if (!text && !done) {
      return yield* new FreebuffError({
        operation: "chat/completions",
        detail: "stream produced no content.",
      });
    }
    return { text, done };
  });

/** Parse non-stream OpenAI `choices[0].message.content`. */
export function extractOpenAiAssistantText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim()) return content;
  return undefined;
}

/** Parse stream-chunk `choices[0].delta.content`. */
export function extractOpenAiStreamDelta(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return undefined;
  const content = (delta as { content?: unknown }).content;
  if (typeof content === "string" && content.length > 0) return content;
  return undefined;
}

/** True when a stream chunk carries `finish_reason`. */
export function isStreamDone(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return false;
  const finishReason = (first as { finish_reason?: unknown }).finish_reason;
  return typeof finishReason === "string" && finishReason.length > 0;
}

/** Build a one-shot (non-stream) assistant completion from plain text. */
export function freebuffChatOnce(
  input: FreebuffChatStreamInput,
): Effect.Effect<string, FreebuffError, FreebuffHttpServices> {
  return freebuffChatCompletion({ ...input, stream: false }).pipe(
    Effect.map((result) => result.text),
  );
}

export type FreebuffRuntimeOptions = FreebuffHttpOptions;

/** Convenience factory for callers that hold settings + env + FileSystem. */
export function makeFreebuffRuntime(options: FreebuffRuntimeOptions) {
  return {
    resolveAuthToken: () => resolveFreebuffAuthToken(options.settings, options.environment),
    me: () => fetchFreebuffMe(options),
    admit: (model: string, instanceId?: string) =>
      requestFreebuffSessionAdmission({ ...options, model, ...(instanceId ? { instanceId } : {}) }),
    endSession: () => endFreebuffSession(options),
    chatOnce: (input: Omit<FreebuffChatStreamInput, "settings" | "environment" | "fileSystem">) =>
      freebuffChatOnce({
        ...input,
        settings: options.settings,
        environment: options.environment,
        fileSystem: options.fileSystem,
      }),
    chatStream: (input: Omit<FreebuffChatStreamInput, "settings" | "environment" | "fileSystem">) =>
      freebuffChatCompletion({
        ...input,
        stream: true,
        settings: options.settings,
        environment: options.environment,
        fileSystem: options.fileSystem,
      }),
  };
}
