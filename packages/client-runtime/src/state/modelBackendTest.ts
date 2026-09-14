// @effect-diagnostics globalDate:off -- The "checked HH:MM" suffix is a viewer-zone wall-clock label for a server instant, not domain time.
/**
 * On-demand model-backend connection test (`server.testModelBackend`).
 *
 * The probe takes the candidate backend config in the request, so drafts that
 * were never persisted stay testable — the client passes its current field
 * values straight through. Probe results are momentary snapshots: callers keep
 * them in local component state and never persist them globally (the server's
 * `backendLastVerifiedAt` marker is stamped only by executed turns, never by
 * probes or background checks, and there is no polling anywhere).
 *
 * Results never carry secrets (server guarantee: failures report only a short
 * status/timeout text), but clients must still never render `apiKeyEnv`
 * *values* — the config only ever names the server-environment variable.
 *
 * @module modelBackendTest
 */
import type {
  ModelBackendConfig,
  ServerTestModelBackendRequest,
  ServerTestModelBackendResult,
} from "@t3tools/contracts";
import { ModelCredentialId } from "@t3tools/contracts";

/**
 * Build the `server.testModelBackend` payload. The backend is passed through
 * by reference, unchanged — no field is added, dropped, or normalized, so an
 * unpersisted draft probes exactly what the user typed. An
 * `apiKeyCredentialId` rides at the request level (it is not part of
 * `ModelBackendConfig`): the server resolves it against the secret store, so
 * the key value never reaches the client.
 */
export function buildTestModelBackendInput(
  backend: ModelBackendConfig,
  apiKeyCredentialId?: string | undefined,
): ServerTestModelBackendRequest {
  return {
    backend,
    ...(apiKeyCredentialId !== undefined && apiKeyCredentialId.length > 0
      ? { apiKeyCredentialId: ModelCredentialId.make(apiKeyCredentialId) }
      : {}),
  };
}

export type BackendTestTone = "pending" | "ok" | "fail";

export interface BackendTestDescription {
  readonly tone: BackendTestTone;
  readonly text: string;
}

export type BackendTestSnapshot =
  | { readonly status: "pending" }
  | { readonly status: "result"; readonly result: ServerTestModelBackendResult }
  | { readonly status: "transportError"; readonly message: string };

/**
 * Render a probe `checkedAt` as local `HH:MM` for "checked …" suffixes.
 * Returns `""` when the timestamp is unparseable so callers can omit the
 * suffix instead of rendering garbage. No time library — a clock suffix does
 * not need one.
 */
export function formatBackendCheckedTime(checkedAt: string): string {
  const date = new Date(checkedAt);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Pure render decision for one probe snapshot: pending spinner text,
 * "Reachable" with or without model count, the server's error text on probe
 * failure, or the transport message when the RPC itself failed (network,
 * auth scope). Never touches secrets — only `ok`/`modelCount`/`error`/
 * `checkedAt` and the caller-supplied transport message feed the text.
 */
export function describeBackendTestResult(snapshot: BackendTestSnapshot): BackendTestDescription {
  if (snapshot.status === "pending") {
    return { tone: "pending", text: "Testing connection…" };
  }
  if (snapshot.status === "transportError") {
    return { tone: "fail", text: snapshot.message };
  }
  const { result } = snapshot;
  if (!result.ok) {
    return { tone: "fail", text: result.error ?? "Connection failed" };
  }
  const checked = formatBackendCheckedTime(result.checkedAt);
  const checkedSuffix = checked === "" ? "" : ` · checked ${checked}`;
  if (result.modelCount === undefined) {
    return { tone: "ok", text: `Reachable${checkedSuffix}` };
  }
  const models = result.modelCount === 1 ? "1 model" : `${result.modelCount} models`;
  return { tone: "ok", text: `Reachable · ${models}${checkedSuffix}` };
}
