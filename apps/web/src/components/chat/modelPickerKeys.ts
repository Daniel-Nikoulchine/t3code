import type { ProviderInstanceId } from "@t3tools/contracts";

const MODEL_KEY_PREFIX = "model:";
const LEGACY_SECTION_KEY_PREFIX = "legacy-models:";
const LOGICAL_MODEL_KEY_PREFIX = "logical-model:";

/**
 * Key of a logical (pooled) model row in the model-first picker. Committing
 * resolves it to one concrete source pairing, so logical keys never become
 * selection values — the combobox value stays a {@link modelPickerModelKey}.
 */
export function modelPickerLogicalModelKey(modelId: string): string {
  return `${LOGICAL_MODEL_KEY_PREFIX}${modelId}`;
}

export function parseModelPickerLogicalModelKey(key: string): string | null {
  return key.startsWith(LOGICAL_MODEL_KEY_PREFIX)
    ? key.slice(LOGICAL_MODEL_KEY_PREFIX.length)
    : null;
}

export function modelPickerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${MODEL_KEY_PREFIX}${instanceId.length}:${instanceId}${slug}`;
}

export function parseModelPickerModelKey(
  key: string,
): { instanceId: ProviderInstanceId; slug: string } | null {
  if (!key.startsWith(MODEL_KEY_PREFIX)) {
    return null;
  }
  const encoded = key.slice(MODEL_KEY_PREFIX.length);
  const separatorIndex = encoded.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const instanceIdLengthText = encoded.slice(0, separatorIndex);
  if (!/^\d+$/.test(instanceIdLengthText)) {
    return null;
  }

  const instanceIdLength = Number(instanceIdLengthText);
  const value = encoded.slice(separatorIndex + 1);
  if (!Number.isSafeInteger(instanceIdLength) || instanceIdLength > value.length) {
    return null;
  }

  return {
    instanceId: value.slice(0, instanceIdLength) as ProviderInstanceId,
    slug: value.slice(instanceIdLength),
  };
}

export function modelPickerLegacySectionKey(instanceId: ProviderInstanceId): string {
  return `${LEGACY_SECTION_KEY_PREFIX}${instanceId}`;
}

export function parseModelPickerLegacySectionKey(key: string): ProviderInstanceId | null {
  return key.startsWith(LEGACY_SECTION_KEY_PREFIX)
    ? (key.slice(LEGACY_SECTION_KEY_PREFIX.length) as ProviderInstanceId)
    : null;
}

/**
 * The model-first picker pools legacy models across instances, so its
 * collapsed section has no instance id. Handle this key before
 * {@link parseModelPickerLegacySectionKey} — the raw suffix is not an
 * instance id.
 */
export const LOGICAL_LEGACY_SECTION_KEY = `${LEGACY_SECTION_KEY_PREFIX}logical`;
