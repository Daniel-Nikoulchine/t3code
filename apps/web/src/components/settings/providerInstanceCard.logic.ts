/**
 * Pure settings logic behind `ProviderInstanceCard`: reading and writing
 * the opaque per-driver config blob plus deriving the model rows the card
 * displays. No React — covered directly by `ProviderInstanceCard.test.ts`.
 *
 * @module settings/providerInstanceCard.logic
 */
import type { ServerProviderModel } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";

import { type CustomModelDefinition, readCustomModelEntries } from "@t3tools/shared/model";

/**
 * Read `customModels` from the opaque config blob. The concrete driver
 * schemas type it as `CustomModelSetting[]`, but it arrives here as
 * `Schema.Unknown`, so the shared reader does the shape checking.
 */
export function readConfigCustomModels(config: unknown): ReadonlyArray<CustomModelDefinition> {
  if (config === null || typeof config !== "object") return [];
  return readCustomModelEntries((config as Record<string, unknown>).customModels);
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
export function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

/**
 * Custom rows come from current settings so name/descriptor edits show
 * instantly; a bare entry falls back to the live row's driver-default
 * capabilities (the server fills those in on its next probe). Live custom
 * rows with no settings entry are server-managed connection models
 * (`viaConnection`) — they have no settings row to edit, so they ride along
 * verbatim instead of being dropped.
 */
export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<CustomModelDefinition>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    Arr.filterMap(input.liveModels ?? [], (model) =>
      model.isCustom ? Result.succeed([model.slug, model] as const) : Result.failVoid,
    ),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const configuredSlugs = new Set(input.customModels.map((entry) => entry.slug));
  const customModels = input.customModels.map((entry) => ({
    slug: entry.slug,
    name: entry.name,
    isCustom: true,
    capabilities:
      entry.capabilities ?? liveCustomModelsBySlug.get(entry.slug)?.capabilities ?? null,
  }));
  const connectionModels = (input.liveModels ?? []).filter(
    (model) => model.isCustom && model.viaConnection === true && !configuredSlugs.has(model.slug),
  );
  return [...serverModels, ...customModels, ...connectionModels];
}
