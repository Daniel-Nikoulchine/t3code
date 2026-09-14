import { createFileRoute, redirect } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

/**
 * The Providers tab merged the harness instance editor with the model
 * backend settings, so this route no longer renders anything of its own. It
 * stays registered to keep old deep links (and the paths still referenced by
 * cached clients) working, forwarding the provider deep-link target and any
 * explicit scope selection to `/settings/providers`.
 */
export const Route = createFileRoute("/settings/harness")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  beforeLoad: ({ search }) => {
    const carried: Record<string, string> = {};
    for (const key of ["environmentId", "instanceId", "machine", "project", "checkout"] as const) {
      const value = (search as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) carried[key] = value;
    }
    throw redirect({ to: "/settings/providers", search: carried, replace: true });
  },
});
