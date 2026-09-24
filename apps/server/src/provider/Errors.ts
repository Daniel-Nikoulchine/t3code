import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";

import type { FallbackTrigger } from "@t3tools/contracts";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

/**
 * ProviderAdapterValidationError - Invalid adapter API input.
 */
export class ProviderAdapterValidationError extends Schema.TaggedError<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderAdapterSessionNotFoundError - Adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends Schema.TaggedError<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterSessionClosedError - Adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends Schema.TaggedError<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedError<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedError<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

/**
 * ProviderWorkspaceMissingError - The session's working directory no longer
 * exists on disk, so no provider process can start in it.
 */
export class ProviderWorkspaceMissingError extends Schema.TaggedError<ProviderWorkspaceMissingError>()(
  "ProviderWorkspaceMissingError",
  {
    threadId: Schema.String,
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return `This thread's workspace folder no longer exists or is not a directory: ${this.cwd}. Restore the folder at this path before retrying.`;
  }
}

/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedError<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderUnsupportedError - Requested provider is not implemented.
 */
export class ProviderUnsupportedError extends Schema.TaggedError<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider '${this.provider}' is not implemented`;
  }
}

/**
 * ProviderInstanceNotFoundError - Lookup against the instance registry failed.
 *
 * Distinct from `ProviderUnsupportedError`: the driver is registered, but no
 * instance with the requested id has been bootstrapped — typically because
 * the persisted instance id refers to an instance the user removed from
 * settings, or because routing is asked for an instance before the registry
 * has finished its first reload.
 */
export class ProviderInstanceNotFoundError extends Schema.TaggedError<ProviderInstanceNotFoundError>()(
  "ProviderInstanceNotFoundError",
  {
    instanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

/**
 * ProviderDriverError - A driver `create` call failed before producing an
 * instance. Surfaced to the registry, which marks the offending entry as
 * an "unavailable" shadow snapshot rather than crashing the server.
 */
export class ProviderDriverError extends Schema.TaggedError<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: Schema.String,
    instanceId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed to create instance '${this.instanceId}': ${this.detail}`;
  }
}

/**
 * ProviderSessionNotFoundError - Provider-facing session not found.
 */
export class ProviderSessionNotFoundError extends Schema.TaggedError<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown provider thread: ${this.threadId}`;
  }
}

/**
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedError<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderWorkspaceMissingError
  | ProviderInstanceNotFoundError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterError
  | CheckpointServiceError;

/**
 * xAI ACP rate-limit error code precedent (`XAiAcpExtension` maps a
 * `stopReason === "rate_limit"` completion to an `AcpRequestError` with this
 * code; `mapAcpToAdapterError` then carries it as `cause` of a
 * `ProviderAdapterRequestError`).
 */
const xAiRateLimitedErrorCode = -32003;

const statusCodePattern = (code: string): RegExp => new RegExp(`(^|[^0-9])${code}([^0-9]|$)`, "i");

const AUTH_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  statusCodePattern("401"),
  statusCodePattern("403"),
  /unauthorized/i,
  /unauthenticated/i,
  /permission[_\s-]?denied/i,
  /access[_\s-]?denied/i,
  /forbidden/i,
  /invalid[_\s-]?api[_\s-]?key/i,
  /authentication[_\s-]?(failed|required)/i,
];

const RATE_LIMIT_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  statusCodePattern("429"),
  statusCodePattern(String(xAiRateLimitedErrorCode).replace("-", "\\-")),
  /rate[_\s-]?limit/i,
  /ratelimit/i,
  /too many requests/i,
  /usage[_\s-]?limit/i,
  /limit[_\s-]?reached/i,
  /quota[\s\S]{0,40}(exceeded|depleted|exhausted)/i,
  /\bcapacity\b/i,
  /overloaded/i,
];

const PROVIDER_ERROR_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|[^0-9])5\d\d([^0-9]|$)/,
  /internal[_\s-]?error/i,
  /overloaded/i,
  /bad[_\s-]?gateway/i,
  /service[_\s-]?unavailable/i,
  /gateway[_\s-]?time[_\s-]?out/i,
];

const TRANSPORT_ERROR_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  /timed?[_\s-]?out/i,
  /\beconn\w*/i,
  /\benotfound\b/i,
  /\benet\w*/i,
  /\behost\w*/i,
  /\bepipe\b/i,
  /\beai_again\b/i,
  /socket/i,
  /\beof\b/i,
  /connection[_\s-]?(reset|refused|closed|aborted|lost|terminated)/i,
  /broken[_\s-]?pipe/i,
  /network[_\s-]?error/i,
  /fetch[_\s-]?failed/i,
  /failed[_\s-]?to[_\s-]?fetch/i,
  /socket[_\s-]?hang[_\s-]?up/i,
  /process[_\s-]?exited/i,
  /\bspawn\b/i,
];

const MAX_SIGNAL_TEXT_LENGTH = 8192;

function appendSignalText(parts: Array<string>, value: string): void {
  if (value.length === 0) {
    return;
  }
  parts.push(
    value.length > MAX_SIGNAL_TEXT_LENGTH ? value.slice(0, MAX_SIGNAL_TEXT_LENGTH) : value,
  );
}

/**
 * Recursively collect human- and machine-readable signal text (messages,
 * details, codes, nested causes) from an arbitrary error-shaped value.
 * Never throws: circular structures are visited once, getters are guarded.
 */
function collectSignalText(value: unknown, seen: Set<object>): Array<string> {
  const parts: Array<string> = [];
  collectInto(value, seen, parts, 0);
  return parts;
}

function collectInto(value: unknown, seen: Set<object>, parts: Array<string>, depth: number): void {
  if (value === null || value === undefined || depth > 6) {
    return;
  }
  try {
    if (typeof value === "string") {
      appendSignalText(parts, value);
      return;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        appendSignalText(parts, String(value));
      }
      return;
    }
    if (typeof value === "boolean" || typeof value === "bigint") {
      appendSignalText(parts, String(value));
      return;
    }
    if (typeof value !== "object" && typeof value !== "function") {
      return;
    }
    const record = value as Record<string, unknown>;
    if (seen.has(record)) {
      return;
    }
    seen.add(record);
    if (value instanceof Error) {
      if (typeof value.name === "string" && value.name !== "Error") {
        appendSignalText(parts, value.name);
      }
      if (typeof value.message === "string") {
        appendSignalText(parts, value.message);
      }
    }
    for (const key of ["detail", "issue", "message", "errorMessage", "reason", "code"]) {
      try {
        const field = record[key];
        if (typeof field === "string" || typeof field === "number") {
          collectInto(field, seen, parts, depth + 1);
        }
      } catch {
        continue;
      }
    }
    try {
      collectInto(record["cause"], seen, parts, depth + 1);
    } catch {
      // Ignore unreadable cause chains.
    }
  } catch {
    // Signal collection must never throw; unknown shapes simply yield no signal.
  }
}

function matchesAny(patterns: ReadonlyArray<RegExp>, text: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function readTag(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  try {
    const tag = (error as { _tag?: unknown })._tag;
    return typeof tag === "string" ? tag : undefined;
  } catch {
    return undefined;
  }
}

/**
 * User-facing one-line summary of a failure cause for turn/session error
 * details (`provider.turn.start.failed` activities, `session.lastError`).
 *
 * Unlike `Cause.pretty`, this never includes server-internal JS stack traces:
 * defects carry their construction stack (adapter internals, schema decode
 * frames), which is unactionable noise in the timeline. The first failure or
 * defect message is returned verbatim so upstream signals (429 rate limits,
 * auth hints, retry advice) stay intact.
 */
export function toUserFacingFailureDetail(cause: Cause.Cause<unknown>): string {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      const message = readFailureMessage(reason.error);
      if (message !== undefined) {
        return message;
      }
    } else if (Cause.isDieReason(reason)) {
      const message = readFailureMessage(reason.defect);
      if (message !== undefined) {
        return message;
      }
    }
  }
  return "The provider request failed before it could start. Try again or pick a different model.";
}

function readFailureMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value instanceof Error && typeof value.message === "string") {
    const message = value.message.trim();
    return message.length > 0 ? message : undefined;
  }
  return undefined;
}

/**
 * Pure predicate: does this error justify a turn-level fallback attempt under
 * the given trigger? Fallback is only ever justified for rate-limit / 5xx /
 * transport signals — never for user decisions, validation, routing, or
 * auth problems, and never for unknown shapes (safe default `false`).
 * Never throws; always returns a boolean.
 */
export function isRetryableProviderError(error: unknown, trigger: FallbackTrigger): boolean {
  try {
    const tag = readTag(error);
    if (
      tag !== undefined &&
      (tag.includes("ValidationError") ||
        tag.includes("SessionNotFound") ||
        tag.includes("SessionClosed"))
    ) {
      return false;
    }
    const signalText = collectSignalText(error, new Set()).join("\n");
    if (signalText.length === 0 || matchesAny(AUTH_SIGNAL_PATTERNS, signalText)) {
      return false;
    }
    switch (trigger) {
      case "rate-limit":
        return matchesAny(RATE_LIMIT_SIGNAL_PATTERNS, signalText);
      case "provider-error":
        return matchesAny(PROVIDER_ERROR_SIGNAL_PATTERNS, signalText);
      case "transport-error":
        return (
          tag === "ProviderAdapterProcessError" ||
          matchesAny(TRANSPORT_ERROR_SIGNAL_PATTERNS, signalText)
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}
