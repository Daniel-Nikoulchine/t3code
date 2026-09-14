/**
 * Optional integration check against a real `openclaw acp` bridge and a
 * running OpenClaw Gateway.
 *
 * Enable with:
 *   T3_OPENCLAW_ACP_PROBE=1 \
 *   T3_OPENCLAW_BINARY=/path/to/openclaw \
 *   T3_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789 \
 *   vp test run apps/server/src/provider/acp/OpenClawAcpCliProbe.test.ts
 *
 * Start a gateway first: `openclaw gateway run --allow-unconfigured`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { buildOpenClawAcpSpawnInput } from "./OpenClawAcpSupport.ts";

const probeSettings = () => ({
  binaryPath: process.env.T3_OPENCLAW_BINARY?.trim() || "openclaw",
  gatewayUrl: process.env.T3_OPENCLAW_GATEWAY_URL?.trim() || "",
  gatewayToken: process.env.T3_OPENCLAW_GATEWAY_TOKEN?.trim() || "",
  sessionKey: process.env.T3_OPENCLAW_SESSION_KEY?.trim() || "",
});

describe.runIf(process.env.T3_OPENCLAW_ACP_PROBE === "1")("OpenClaw ACP CLI probe", () => {
  it.effect("initialize and open a session against the real gateway", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(typeof started.sessionId).toBe("string");
      const snapshot =
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({ models: started.sessionSetupResult.models ?? null }, null, 2);
      yield* Console.log("session model state:", snapshot);
      const dumpPath = process.env.T3_OPENCLAW_ACP_PROBE_DUMP?.trim();
      if (dumpPath) {
        yield* Effect.promise(() =>
          import("node:fs/promises").then((fs) => fs.writeFile(dumpPath, snapshot)),
        );
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: buildOpenClawAcpSpawnInput(probeSettings(), process.cwd(), process.env),
          cwd: process.cwd(),
          clientInfo: { name: "t3-probe", version: "0.0.0" },
          authMethodId: "openclaw-setup",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
