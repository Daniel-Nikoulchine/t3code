import {
  buildTestModelBackendInput,
  describeBackendTestResult,
  type BackendTestDescription,
  type BackendTestSnapshot,
} from "@t3tools/client-runtime/state/model-backend-test";
import type {
  EnvironmentId,
  ModelBackendConfig,
  ServerTestModelBackendResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * One-shot probe of a connection's or credential's field values via the
 * existing `server.testModelBackend` RPC. The result lives in local state only
 * (a momentary snapshot, never persisted globally) — the server's
 * `backendLastVerifiedAt` marker is stamped only by executed turns, never by
 * probes. No polling, no auto-test: callers invoke `run` from button clicks
 * only, including for unpersisted add-dialog drafts. An
 * `apiKeyCredentialId` resolves server-side against the secret store, so a
 * stored key is probeable without the value reaching the client. `run`
 * resolves to the probe result (or `undefined` when the RPC itself failed) so
 * callers like the model-list fetcher can read `result.models`.
 */
export function useBackendConnectionProbe(environmentId: EnvironmentId) {
  const test = useAtomCommand(serverEnvironment.testModelBackend, { reportFailure: false });
  const [snapshot, setSnapshot] = useState<BackendTestSnapshot | null>(null);
  const pending = snapshot?.status === "pending";
  const run = async (
    backend: ModelBackendConfig,
    apiKeyCredentialId?: string | undefined,
  ): Promise<ServerTestModelBackendResult | undefined> => {
    if (pending) return undefined;
    setSnapshot({ status: "pending" });
    try {
      const outcome = await test({
        environmentId,
        input: buildTestModelBackendInput(backend, apiKeyCredentialId),
      });
      if (outcome._tag === "Failure") {
        setSnapshot({ status: "transportError", message: Cause.pretty(outcome.cause) });
        return undefined;
      }
      setSnapshot({ status: "result", result: outcome.value });
      return outcome.value;
    } catch (error) {
      setSnapshot({
        status: "transportError",
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
  const description: BackendTestDescription | null =
    snapshot === null ? null : describeBackendTestResult(snapshot);
  return { pending, description, run };
}
