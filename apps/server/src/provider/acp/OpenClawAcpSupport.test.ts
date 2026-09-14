import { describe, expect, it } from "vite-plus/test";

import {
  buildOpenClawAcpSpawnArgs,
  buildOpenClawAcpSpawnInput,
  resolveOpenClawModelId,
} from "./OpenClawAcpSupport.ts";

describe("OpenClaw ACP support", () => {
  it("spawns the Gateway-backed ACP bridge with defaults", () => {
    expect(
      buildOpenClawAcpSpawnInput({ binaryPath: "openclaw" }, "/workspace", {
        OPENCLAW_GATEWAY_TOKEN: "secret",
      }),
    ).toEqual({
      command: "openclaw",
      args: ["acp"],
      cwd: "/workspace",
      env: { OPENCLAW_GATEWAY_TOKEN: "secret" },
    });
  });

  it("appends gateway connection flags only when configured", () => {
    expect(
      buildOpenClawAcpSpawnArgs({
        binaryPath: "openclaw",
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "secret",
        sessionKey: "agent:main:main",
      }),
    ).toEqual([
      "acp",
      "--url",
      "ws://127.0.0.1:18789",
      "--token",
      "secret",
      "--session",
      "agent:main:main",
    ]);
  });

  it("trims gateway flags and drops empties", () => {
    expect(
      buildOpenClawAcpSpawnArgs({
        binaryPath: "openclaw",
        gatewayUrl: "  ",
        gatewayToken: "",
        sessionKey: " agent:work:t3 ",
      }),
    ).toEqual(["acp", "--session", "agent:work:t3"]);
  });

  it("falls back to the openclaw binary on PATH", () => {
    const input = buildOpenClawAcpSpawnInput(
      { binaryPath: "", gatewayUrl: "", gatewayToken: "", sessionKey: "" },
      "/workspace",
    );
    expect(input.command).toBe("openclaw");
    expect(input.args).toEqual(["acp"]);
  });

  it("keeps the gateway default model for the default sentinel", () => {
    expect(resolveOpenClawModelId("default")).toBeUndefined();
    expect(resolveOpenClawModelId("  ")).toBeUndefined();
    expect(resolveOpenClawModelId(null)).toBeUndefined();
    expect(resolveOpenClawModelId(" openrouter:anthropic/claude-sonnet-4 ")).toBe(
      "openrouter:anthropic/claude-sonnet-4",
    );
  });
});
