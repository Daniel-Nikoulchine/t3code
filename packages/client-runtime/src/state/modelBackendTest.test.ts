import type { ModelBackendConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTestModelBackendInput,
  describeBackendTestResult,
  formatBackendCheckedTime,
} from "./modelBackendTest.ts";

const CHECKED_AT = "2026-09-13T14:05:00.000Z";

describe("buildTestModelBackendInput", () => {
  it("passes the backend through unchanged so unpersisted drafts probe as typed", () => {
    const backend = {
      kind: "openai-compatible",
      baseUrl: "https://proxy.example/v1",
      apiKeyEnv: "PROXY_API_KEY",
    } as ModelBackendConfig;
    const input = buildTestModelBackendInput(backend);
    expect(input.backend).toBe(backend);
    expect(Object.keys(input)).toEqual(["backend"]);
  });
});

describe("describeBackendTestResult", () => {
  it("renders the pending state", () => {
    expect(describeBackendTestResult({ status: "pending" })).toEqual({
      tone: "pending",
      text: "Testing connection…",
    });
  });

  it("renders ok with a model count and check time", () => {
    const described = describeBackendTestResult({
      status: "result",
      result: { ok: true, modelCount: 3, checkedAt: CHECKED_AT },
    });
    expect(described.tone).toBe("ok");
    expect(described.text).toMatch(/^Reachable · 3 models · checked \d{2}:\d{2}$/);
  });

  it("uses the singular for a single model", () => {
    const described = describeBackendTestResult({
      status: "result",
      result: { ok: true, modelCount: 1, checkedAt: CHECKED_AT },
    });
    expect(described.tone).toBe("ok");
    expect(described.text).toMatch(/^Reachable · 1 model · checked \d{2}:\d{2}$/);
  });

  it("renders ok without a count when the payload shape was unexpected", () => {
    const described = describeBackendTestResult({
      status: "result",
      result: { ok: true, checkedAt: CHECKED_AT },
    });
    expect(described.tone).toBe("ok");
    expect(described.text).toMatch(/^Reachable · checked \d{2}:\d{2}$/);
  });

  it("renders the server error text on probe failure", () => {
    expect(
      describeBackendTestResult({
        status: "result",
        result: { ok: false, error: "request failed with status 401", checkedAt: CHECKED_AT },
      }),
    ).toEqual({ tone: "fail", text: "request failed with status 401" });
  });

  it("falls back to a generic text when the probe fails without an error", () => {
    expect(
      describeBackendTestResult({
        status: "result",
        result: { ok: false, checkedAt: CHECKED_AT },
      }),
    ).toEqual({ tone: "fail", text: "Connection failed" });
  });

  it("renders RPC transport failures inline without crashing", () => {
    expect(
      describeBackendTestResult({ status: "transportError", message: "Network unreachable" }),
    ).toEqual({ tone: "fail", text: "Network unreachable" });
  });
});

describe("formatBackendCheckedTime", () => {
  it("formats a clock time", () => {
    expect(formatBackendCheckedTime(CHECKED_AT)).toMatch(/^\d{2}:\d{2}$/);
  });

  it("returns empty for unparseable input so callers omit the suffix", () => {
    expect(formatBackendCheckedTime("not-a-date")).toBe("");
  });
});
