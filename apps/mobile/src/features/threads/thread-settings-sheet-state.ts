import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import type { ModelGroup, ModelOption } from "../../lib/modelOptions";

export type ModelFavorite = {
  readonly provider: ProviderInstanceId;
  readonly model: string;
};

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function toggleModelFavorite(
  favorites: ReadonlyArray<ModelFavorite>,
  option: ModelOption,
): ReadonlyArray<ModelFavorite> {
  const provider = option.selection.instanceId;
  const model = option.selection.model;
  return favorites.some((favorite) => favorite.provider === provider && favorite.model === model)
    ? favorites.filter((favorite) => favorite.provider !== provider || favorite.model !== model)
    : [...favorites, { provider, model }];
}

/** Keep catalog order within each group when favorites move to the front. */
export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

/**
 * Match the terms a user can actually see or recognize in the model-first
 * picker: the logical model's name, the pairing's own fields, and the
 * provider label behind each pairing.
 */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly groupLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.model.providerLabel,
    input.groupLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}

/** A model can disappear while the picker is open. */
export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ModelGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some((model) => model.key === pending.key && !model.isUnavailable),
  );
}

/**
 * Resolve a human-readable label for a combo target from the same catalog
 * the picker renders: the option's short label plus its provider label.
 * Falls back to raw slugs when the catalog does not (yet) list the target,
 * so shell/catalog races never render a blank row.
 */
export function resolveComboTargetDisplay(
  target: ModelSelection,
  groups: ReadonlyArray<ModelGroup>,
): { readonly title: string; readonly subtitle: string } {
  for (const group of groups) {
    const option = group.models.find(
      (candidate) =>
        candidate.selection.instanceId === target.instanceId &&
        candidate.selection.model === target.model,
    );
    if (option) {
      return { title: option.label, subtitle: option.providerLabel };
    }
  }
  return { title: target.model, subtitle: String(target.instanceId) };
}

export interface ProviderFilterChoice {
  readonly key: string;
  readonly label: string;
  readonly modelCount: number;
}

/**
 * Distinct providers behind the catalog's pairings, in first-seen order,
 * with pairing counts so the provider filter menu can render two-line rows
 * (label + "N models") like the web provider menu.
 */
export function providerFilterChoices(
  groups: ReadonlyArray<ModelGroup>,
): ReadonlyArray<ProviderFilterChoice> {
  const byKey = new Map<string, { label: string; modelCount: number }>();
  for (const group of groups) {
    for (const model of group.models) {
      const existing = byKey.get(model.providerKey);
      if (existing) {
        existing.modelCount += 1;
      } else {
        byKey.set(model.providerKey, { label: model.providerLabel, modelCount: 1 });
      }
    }
  }
  return [...byKey.entries()].map(([key, { label, modelCount }]) => ({
    key,
    label,
    modelCount,
  }));
}

/** Two-line menu subtitle for a provider filter row. */
export function providerChoiceSubtitle(modelCount: number): string {
  return modelCount === 1 ? "1 model" : `${modelCount} models`;
}

/**
 * Primary and selected providers start open; all other catalogs start closed.
 * A user's disclosure tap inverts that default until the picker is dismissed.
 */
export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
