import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  ModelBackendConnectionId,
  ModelCapabilities,
  ModelSelection,
  ServerConfig as T3ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { deriveModelCatalog } from "@t3tools/client-runtime/model-catalog";
import { resolveProviderBackendLabel } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly isUnavailable?: boolean;
  /**
   * Set when the owning instance routes through an external model backend
   * (proxy). Resolved from the snapshot via `resolveProviderBackendLabel` —
   * absent means a native/direct harness connection.
   */
  readonly viaProxy?: boolean;
  /** Display name (or kind label) of that backend, present exactly when `viaProxy`. */
  readonly backendLabel?: string;
  /** The proxy degrades model capabilities — surfaced as a hint, not a block. */
  readonly capabilitiesDegraded?: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

/**
 * One model-first group: a logical model pooled across provider instances.
 * `models` are the concrete pairings that can serve it here, in first-seen
 * order — the availability filter has already been applied to each of them.
 * Backend routing flags live on the pairings, not the group: instances in a
 * pooled group can disagree.
 */
export type ModelGroup = {
  readonly key: string;
  readonly label: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  if (provider.driver === "droid") return "Droid";
  if (provider.driver === "hermes") return "Hermes";
  if (provider.driver === "cline") return "Cline";
  if (provider.driver === "kilo") return "Kilo";
  if (provider.driver === "pi") return "Pi";
  if (provider.driver === "deepseek") return "DeepSeek";
  return provider.instanceId;
}

/**
 * Overlay the owning instance's backend routing flags onto a model option.
 * The snapshot is the source of truth (`resolveProviderBackendLabel` returns
 * `undefined` for native/direct connections), mirroring web's
 * `withInstanceBackendFlags` in `apps/web/src/modelSelection.ts`. Never
 * surfaces key material: snapshots carry only kind/displayName.
 */
function backendFlagsForSnapshot(snapshot: Pick<ServerProvider, "backend"> | undefined): {
  readonly viaProxy?: boolean;
  readonly backendLabel?: string;
  readonly capabilitiesDegraded?: boolean;
} {
  const backendLabel = resolveProviderBackendLabel(snapshot);
  if (!backendLabel) return {};
  if (snapshot?.backend?.capabilitiesDegraded === true) {
    return { viaProxy: true, backendLabel, capabilitiesDegraded: true };
  }
  return { viaProxy: true, backendLabel };
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
    selection.options,
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/** Whether a known Antigravity selection needs setup or a different model. */
export function isModelSelectionUnavailable(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): boolean {
  if (!config || !selection) {
    return false;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const driver =
    provider?.driver ?? config.settings?.providerInstances[selection.instanceId]?.driver;
  return (
    driver === "antigravity" &&
    (!provider ||
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable" ||
      !provider.models.some((model) => model.slug === selection.model))
  );
}

/**
 * Keep Antigravity selections when setup or catalog changes make them
 * unavailable. Other providers fall through to the server default when they
 * are disabled, missing, or signed out. Without config, keep stored selections.
 */
export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const driver =
    provider?.driver ?? config.settings?.providerInstances[selection.instanceId]?.driver;
  if (driver === "antigravity") {
    return selection;
  }
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

/**
 * Reject legacy models for implicit defaults, except Antigravity selections,
 * which must not silently change after a catalog update. Explicit picks in
 * the settings sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return provider?.driver !== "antigravity" && model?.isLegacy === true ? null : usable;
}

export function resolveNewTaskModelSelection(input: {
  readonly draftSelection: ModelSelection | null;
  readonly projectDefaultSelection: ModelSelection | null;
  readonly stickySelection: ModelSelection | null;
  readonly modelOptions: ReadonlyArray<ModelOption>;
}): ModelSelection | null {
  return (
    input.draftSelection ??
    input.projectDefaultSelection ??
    input.stickySelection ??
    input.modelOptions.find((option) => option.isDefault && !option.isUnavailable)?.selection ??
    input.modelOptions.find((option) => !option.isUnavailable)?.selection ??
    null
  );
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      (provider.driver === "antigravity" && provider.availability === "unavailable")
    ) {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    const backendFlags = backendFlagsForSnapshot(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: model.subProvider ?? "",
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        ...backendFlags,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection:
          existing.providerDriver === "antigravity"
            ? fallbackModelSelection
            : normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const provider = config?.providers.find(
        (candidate) => candidate.instanceId === fallbackModelSelection.instanceId,
      );
      const instanceConfig = config?.settings?.providerInstances[fallbackModelSelection.instanceId];
      const model = provider?.models.find(
        (candidate) => candidate.slug === fallbackModelSelection.model,
      );
      const providerDriver =
        provider?.driver ?? instanceConfig?.driver ?? fallbackModelSelection.instanceId;
      const providerLabel = providerDisplayLabel({
        driver: providerDriver,
        displayName: provider?.displayName ?? instanceConfig?.displayName,
        instanceId: fallbackModelSelection.instanceId,
      });
      options.set(key, {
        key,
        label: model?.name ?? fallbackModelSelection.model,
        subtitle: model?.subProvider ?? "",
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver,
        isDefault: false,
        isLegacy: model?.isLegacy === true,
        ...backendFlagsForSnapshot(provider),
        ...(isModelSelectionUnavailable(config, fallbackModelSelection)
          ? { isUnavailable: true }
          : {}),
        capabilities: model?.capabilities ?? null,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByLogicalModel(
  options: ReadonlyArray<ModelOption>,
): ReadonlyArray<ModelGroup> {
  const groups = new Map<string, { label: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.selection.model);
    if (existing) {
      if (!existing.models.some((candidate) => candidate.key === option.key)) {
        existing.models.push(option);
      }
    } else {
      groups.set(option.selection.model, { label: option.label, models: [option] });
    }
  }

  return [...groups.entries()].map(([key, group]) => ({
    key,
    label: group.label,
    models: group.models,
  }));
}

/** Per-instance link into the connections map, mirrored from `settings.providerInstances`. */
function instanceConnectionMap(
  config: T3ServerConfig | null | undefined,
): Partial<Record<ProviderInstanceId, ModelBackendConnectionId>> {
  const out: Partial<Record<ProviderInstanceId, ModelBackendConnectionId>> = {};
  for (const [instanceId, instance] of Object.entries(config?.settings?.providerInstances ?? {})) {
    if (instance.connectionId) {
      out[ProviderInstanceId.make(instanceId)] = instance.connectionId;
    }
  }
  return out;
}

/**
 * Concrete pairings a model backend connection serves through its linked
 * instance. Snapshots list only an instance's own models, so these pairings
 * exist nowhere else: no capabilities, and the slug stands in for the label
 * until a native source names the model. The same eligibility filter as the
 * snapshot pairings applies.
 */
export function buildConnectionModelOptions(
  config: T3ServerConfig | null | undefined,
): ReadonlyArray<ModelOption> {
  if (!config) {
    return [];
  }
  const catalog = deriveModelCatalog({
    providers: config.providers,
    connections: config.settings?.modelBackendConnections ?? {},
    instanceConnections: instanceConnectionMap(config),
  });
  const options: ModelOption[] = [];
  for (const logical of catalog) {
    for (const source of logical.sources) {
      if (source.via !== "connection") {
        continue;
      }
      const provider = config.providers.find(
        (candidate) => candidate.instanceId === source.instanceId,
      );
      if (
        !provider ||
        !provider.enabled ||
        !provider.installed ||
        provider.auth.status === "unauthenticated" ||
        (provider.driver === "antigravity" && provider.availability === "unavailable")
      ) {
        continue;
      }
      const instanceConfig =
        config.settings?.providerInstances[ProviderInstanceId.make(source.instanceId)];
      const providerDriver = provider.driver ?? instanceConfig?.driver ?? source.instanceId;
      options.push({
        key: `${source.instanceId}:${source.model}`,
        label: logical.displayName,
        subtitle: "",
        providerKey: source.instanceId,
        providerLabel: providerDisplayLabel({
          driver: providerDriver,
          displayName: provider.displayName ?? instanceConfig?.displayName,
          instanceId: source.instanceId,
        }),
        providerDriver,
        isDefault: false,
        isLegacy: false,
        capabilities: null,
        selection: {
          instanceId: ProviderInstanceId.make(source.instanceId),
          model: source.model,
        },
      });
    }
  }
  return options;
}

/**
 * Model-first grouping for the pickers: groups are logical models pooled
 * across instances, entries are the concrete pairings — snapshot models plus
 * the connection-provided ones. Snapshot options come first so a fallback
 * selection's richer option (capabilities, availability) wins the dedupe
 * against its connection-provided twin.
 */
export function buildModelGroups(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelGroup> {
  return groupByLogicalModel([
    ...buildModelOptions(config, fallbackModelSelection),
    ...buildConnectionModelOptions(config),
  ]);
}
