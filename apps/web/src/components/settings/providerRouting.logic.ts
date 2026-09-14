import type {
  ModelCredential,
  ModelProxyConfig,
  ModelRouterRoute,
  ModelRouterRouteTarget,
} from "@t3tools/contracts";
import { ModelBackendConnectionId, ModelCredentialId, ModelVendor } from "@t3tools/contracts";

import {
  credentialVendorLabel,
  isPresetVendor,
  validateVendorSlug,
} from "./providerCredentials.logic";

/**
 * Pure patches and render decisions for the model-router routes map
 * (`ServerSettings.modelRouterRoutes`), the routing half of the Providers
 * tab. The map is whole-map replacement (same as `modelBackendConnections`
 * and `modelCredentials`): add/edit/remove send the full map. Keys are the
 * logical model id slugs a harness puts in the `model` field; there is no
 * slug pattern — upstream model ids freely contain dots, slashes, and colons.
 * See `modelRouter.ts` in contracts.
 */

/** The form state the add/edit dialog edits before it becomes a route. */
export interface ModelRouterRouteDraft {
  readonly modelSlug: string;
  readonly targetKind: "connection" | "vendor";
  readonly connectionId: string;
  readonly vendor: string;
  readonly credentialId: string;
  /** Vendor base URL override; required for vendors without a preset root. */
  readonly baseUrl: string;
  /** Upstream model slug; blank passes the route key through. */
  readonly upstreamModel: string;
}

/**
 * Validate the route's model slug (the map key). Required, and unique across
 * the map — a route maps one model, so adding a second entry for the same
 * slug would silently replace the first. The slug being edited is exempt
 * from its own collision.
 */
export function validateRouteModelSlug(
  slug: string,
  routes: Readonly<Record<string, unknown>>,
  editingSlug?: string | undefined,
): string | null {
  const trimmed = slug.trim();
  if (trimmed.length === 0) return "Model ID is required.";
  if (editingSlug !== undefined && trimmed === editingSlug.trim()) return null;
  if (trimmed in routes) return `A route for "${trimmed}" already exists.`;
  return null;
}

/** Validate a connection target: a non-blank id naming an existing connection. */
export function validateRouteConnectionTarget(
  connectionId: string,
  connections: Readonly<Record<string, unknown>>,
): string | null {
  const trimmed = connectionId.trim();
  if (trimmed.length === 0) return "Pick a connection.";
  if (connections[trimmed] === undefined) return "Pick a connection that exists.";
  return null;
}

/**
 * Validate a vendor target: a vendor slug, a stored credential (the key that
 * authenticates against the vendor API), and — for vendors without a preset
 * API root — a base URL, since there is nothing to default to.
 */
export function validateRouteVendorTarget(
  target: { readonly vendor: string; readonly credentialId: string; readonly baseUrl: string },
  credentials: Readonly<Record<string, unknown>>,
): string | null {
  const vendorError = validateVendorSlug(target.vendor);
  if (vendorError !== null) return vendorError;
  const credentialId = target.credentialId.trim();
  if (credentialId.length === 0) return "Pick a stored API key.";
  if (credentials[credentialId] === undefined) return "Pick a stored API key that exists.";
  if (!isPresetVendor(target.vendor) && target.baseUrl.trim().length === 0) {
    return "Base URL is required for custom vendors.";
  }
  return null;
}

/** Validate whichever target kind the draft picked. */
export function validateRouteTarget(
  draft: ModelRouterRouteDraft,
  connections: Readonly<Record<string, unknown>>,
  credentials: Readonly<Record<string, unknown>>,
): string | null {
  return draft.targetKind === "connection"
    ? validateRouteConnectionTarget(draft.connectionId, connections)
    : validateRouteVendorTarget(draft, credentials);
}

/**
 * Clean draft fields into a saveable route entry. Trims; drops the blank
 * optional upstream slug (absent means pass the route key through — the
 * common case where the target serves the same slug it is routed as).
 * Returns `undefined` when a required field is blank — the dialog gates on
 * the validate functions and must not save an incomplete target.
 */
export function toModelRouterRoute(draft: ModelRouterRouteDraft): ModelRouterRoute | undefined {
  const modelSlug = draft.modelSlug.trim();
  if (modelSlug.length === 0) return undefined;
  const connectionId = draft.connectionId.trim();
  const vendor = draft.vendor.trim();
  const credentialId = draft.credentialId.trim();
  const baseUrl = draft.baseUrl.trim();
  const target: ModelRouterRouteTarget | undefined =
    draft.targetKind === "connection"
      ? connectionId.length > 0
        ? { kind: "connection", connectionId: ModelBackendConnectionId.make(connectionId) }
        : undefined
      : vendor.length > 0 &&
          credentialId.length > 0 &&
          (isPresetVendor(vendor) || baseUrl.length > 0)
        ? {
            kind: "vendor",
            vendor: ModelVendor.make(vendor),
            credentialId: ModelCredentialId.make(credentialId),
            ...(baseUrl.length > 0 ? { baseUrl } : {}),
          }
        : undefined;
  if (target === undefined) return undefined;
  const upstreamModel = draft.upstreamModel.trim();
  return { target, ...(upstreamModel.length > 0 ? { upstreamModel } : {}) };
}

/**
 * Whole-map patch with one route added under its model slug. The slug is
 * already unique — `validateRouteModelSlug` rejects duplicates — so this
 * never overwrites.
 */
export function addModelRouterRoute(
  routes: Readonly<Record<string, ModelRouterRoute>>,
  slug: string,
  route: ModelRouterRoute,
): Record<string, ModelRouterRoute> {
  return { ...routes, [slug]: route };
}

/**
 * Whole-map patch replacing one route. When the edit renamed the model slug,
 * the old key goes away in the same patch; unchanged keys keep their order.
 */
export function updateModelRouterRoute(
  routes: Readonly<Record<string, ModelRouterRoute>>,
  previousSlug: string,
  slug: string,
  route: ModelRouterRoute,
): Record<string, ModelRouterRoute> {
  const { [previousSlug]: _omit, ...rest } = routes;
  return { ...rest, [slug]: route };
}

/** Whole-map patch with one route removed (callers send the full map). */
export function removeModelRouterRoute(
  routes: Readonly<Record<string, ModelRouterRoute>>,
  slug: string,
): Record<string, ModelRouterRoute> {
  const { [slug]: _omit, ...rest } = routes;
  return rest;
}

/**
 * One-line target summary for a route row: the connection's display name or
 * the vendor plus the credential it bills to. Dangling references degrade to
 * the raw id — same rule as a deleted connection's key hint.
 */
export function describeRouteTarget(
  target: ModelRouterRouteTarget,
  connections: Readonly<Record<string, Pick<ModelProxyConfig, "displayName">>>,
  credentials: Readonly<Record<string, ModelCredential>>,
): string {
  if (target.kind === "connection") {
    const id = String(target.connectionId);
    return `Connection: ${connections[id]?.displayName?.trim() || id}`;
  }
  const id = String(target.credentialId);
  const credential = credentials[id];
  const label = credential?.displayName?.trim() || id;
  return [
    `${credentialVendorLabel(String(target.vendor))} key · ${label}`,
    ...(credential?.lastFour !== undefined ? [`ends in ${credential.lastFour}`] : []),
  ].join(" · ");
}
