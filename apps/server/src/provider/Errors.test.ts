import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";

import {
  isRetryableProviderError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
  toUserFacingFailureDetail,
} from "./Errors.ts";

const TRIGGERS = ["rate-limit", "provider-error", "transport-error"] as const;

describe("isRetryableProviderError", () => {
  it("treats a 429 request error as rate-limit only (429 is not 5xx)", () => {
    const error = new ProviderAdapterRequestError({
      provider: "opencode",
      method: "session/prompt",
      detail: "HTTP 429 Too Many Requests: rate limit exceeded, retry later",
    });

    expect(isRetryableProviderError(error, "rate-limit")).toBe(true);
    // 429 ist KEIN 5xx und kein Transport-Signal → kein Fallback unter diesen Triggern.
    expect(isRetryableProviderError(error, "provider-error")).toBe(false);
    expect(isRetryableProviderError(error, "transport-error")).toBe(false);
  });

  it("treats a 503 request error as provider-error only", () => {
    const error = new ProviderAdapterRequestError({
      provider: "cursor",
      method: "session/prompt",
      detail: "HTTP 503 Service Unavailable: upstream temporarily down",
    });

    expect(isRetryableProviderError(error, "provider-error")).toBe(true);
    expect(isRetryableProviderError(error, "rate-limit")).toBe(false);
    expect(isRetryableProviderError(error, "transport-error")).toBe(false);
  });

  it("treats a spawned-process death as transport-error only", () => {
    const error = new ProviderAdapterProcessError({
      provider: "cursor",
      threadId: "thread-1",
      detail: "ACP server process exited unexpectedly with code 1",
    });

    expect(isRetryableProviderError(error, "transport-error")).toBe(true);
    expect(isRetryableProviderError(error, "rate-limit")).toBe(false);
    expect(isRetryableProviderError(error, "provider-error")).toBe(false);
  });

  it("maps timeout/socket signals on request errors to transport-error", () => {
    const timeout = new ProviderAdapterRequestError({
      provider: "opencode",
      method: "session/prompt",
      detail: "timed out waiting for server",
    });
    const socket = new ProviderAdapterRequestError({
      provider: "opencode",
      method: "session/prompt",
      detail: "socket hang up: ECONNRESET",
    });

    expect(isRetryableProviderError(timeout, "transport-error")).toBe(true);
    expect(isRetryableProviderError(timeout, "rate-limit")).toBe(false);
    expect(isRetryableProviderError(socket, "transport-error")).toBe(true);
    expect(isRetryableProviderError(socket, "provider-error")).toBe(false);
  });

  it("maps the xAI -32003 rate-limit code passed through as cause", () => {
    const error = new ProviderAdapterRequestError({
      provider: "grok",
      method: "session/prompt",
      detail: "Grok prompt failed.",
      cause: { code: -32003, errorMessage: "Grok usage limit reached. Try again later." },
    });

    expect(isRetryableProviderError(error, "rate-limit")).toBe(true);
    expect(isRetryableProviderError(error, "provider-error")).toBe(false);
    expect(isRetryableProviderError(error, "transport-error")).toBe(false);
  });

  it("maps quota/capacity/overloaded texts to rate-limit", () => {
    const quota = new ProviderAdapterRequestError({
      provider: "opencode",
      method: "session/prompt",
      detail: "quota exceeded for model, try again later",
    });
    const capacity = new ProviderAdapterRequestError({
      provider: "opencode",
      method: "session/prompt",
      detail: "No capacity available for this model right now",
    });

    expect(isRetryableProviderError(quota, "rate-limit")).toBe(true);
    expect(isRetryableProviderError(quota, "provider-error")).toBe(false);
    expect(isRetryableProviderError(capacity, "rate-limit")).toBe(true);
  });

  it("maps overloaded to both rate-limit and provider-error triggers", () => {
    const error = new ProviderAdapterRequestError({
      provider: "opencode",
      method: "session/prompt",
      detail: "upstream overloaded, please retry",
    });

    expect(isRetryableProviderError(error, "rate-limit")).toBe(true);
    expect(isRetryableProviderError(error, "provider-error")).toBe(true);
    expect(isRetryableProviderError(error, "transport-error")).toBe(false);
  });

  it("maps 5xx/internal-error/gateway texts to provider-error", () => {
    for (const detail of ["HTTP 500 Internal Server Error", "HTTP 502 Bad Gateway"]) {
      const error = new ProviderAdapterRequestError({
        provider: "opencode",
        method: "session/prompt",
        detail,
      });
      expect(isRetryableProviderError(error, "provider-error")).toBe(true);
      expect(isRetryableProviderError(error, "rate-limit")).toBe(false);
      expect(isRetryableProviderError(error, "transport-error")).toBe(false);
    }
  });

  it("maps gateway timeout to both provider-error and transport-error", () => {
    // "gateway timeout" steht in beiden Signal-Listen der Spec (5xx-Signal und
    // Timeout-Signal) — beide Trigger lösen Fallback aus, rate-limit nicht.
    const error = new ProviderAdapterRequestError({
      provider: "opencode",
      method: "session/prompt",
      detail: "HTTP 504 Gateway Timeout",
    });
    expect(isRetryableProviderError(error, "provider-error")).toBe(true);
    expect(isRetryableProviderError(error, "transport-error")).toBe(true);
    expect(isRetryableProviderError(error, "rate-limit")).toBe(false);
  });

  it("never retries validation errors, on any trigger", () => {
    const errors = [
      new ProviderAdapterValidationError({
        provider: "opencode",
        operation: "sendTurn",
        issue: "missing model",
      }),
      new ProviderValidationError({ operation: "sendTurn", issue: "missing model" }),
    ];
    for (const error of errors) {
      for (const trigger of TRIGGERS) {
        expect(isRetryableProviderError(error, trigger)).toBe(false);
      }
    }
  });

  it("never retries session-not-found/closed routing errors, on any trigger", () => {
    const errors = [
      new ProviderAdapterSessionNotFoundError({ provider: "cursor", threadId: "thread-1" }),
      new ProviderAdapterSessionClosedError({ provider: "cursor", threadId: "thread-1" }),
      new ProviderSessionNotFoundError({ threadId: "thread-1" }),
    ];
    for (const error of errors) {
      for (const trigger of TRIGGERS) {
        expect(isRetryableProviderError(error, trigger)).toBe(false);
      }
    }
  });

  it("never retries auth/permission signals, on any trigger", () => {
    const errors = [
      new ProviderAdapterRequestError({
        provider: "opencode",
        method: "session/prompt",
        detail: "HTTP 401 Unauthorized: invalid api key",
      }),
      new ProviderAdapterRequestError({
        provider: "cursor",
        method: "session/prompt",
        detail: "HTTP 403 permission denied for model",
      }),
    ];
    for (const error of errors) {
      for (const trigger of TRIGGERS) {
        expect(isRetryableProviderError(error, trigger)).toBe(false);
      }
    }
  });

  it("lets auth signals win over retryable signals in the same error", () => {
    const error = new ProviderAdapterRequestError({
      provider: "opencode",
      method: "session/prompt",
      detail: "rate limited (429) — unauthorized (401), check credentials",
    });
    for (const trigger of TRIGGERS) {
      expect(isRetryableProviderError(error, trigger)).toBe(false);
    }
  });

  it("returns false without throwing for unknown shapes", () => {
    for (const trigger of TRIGGERS) {
      for (const input of [null, undefined, "random string", 42, true, {}, { _tag: "Nope" }]) {
        expect(() => isRetryableProviderError(input, trigger)).not.toThrow();
        expect(isRetryableProviderError(input, trigger)).toBe(false);
      }
    }
  });
});

describe("toUserFacingFailureDetail", () => {
  const upstreamMessage =
    "Internal error: MiniMax Code Runtime failed: BYOK provider custom_provider:t3-backend " +
    "upstream error: 429 Upstream request failed: [rate_limit_exceeded] Rate limit exceeded. " +
    "Please retry after a brief wait.";

  it("returns a defect message without its server-internal stack trace", () => {
    const detail = toUserFacingFailureDetail(Cause.die(new Error(upstreamMessage)));

    expect(detail).toBe(upstreamMessage);
    expect(detail).not.toMatch(/^\s*at\s/m);
    expect(detail).not.toContain("file://");
  });

  it("keeps the upstream rate-limit signal intact for the user", () => {
    const detail = toUserFacingFailureDetail(Cause.die(new Error(upstreamMessage)));

    expect(isRetryableProviderError(new Error(detail), "rate-limit")).toBe(true);
  });

  it("returns failure messages verbatim", () => {
    expect(toUserFacingFailureDetail(Cause.fail(new Error("boom")))).toBe("boom");
    expect(toUserFacingFailureDetail(Cause.fail("plain string failure"))).toBe(
      "plain string failure",
    );
  });

  it("falls back to a generic message when there is nothing readable", () => {
    const detail = toUserFacingFailureDetail(Cause.empty);

    expect(detail.length).toBeGreaterThan(0);
    expect(detail).not.toMatch(/^\s*at\s/m);
  });
});
