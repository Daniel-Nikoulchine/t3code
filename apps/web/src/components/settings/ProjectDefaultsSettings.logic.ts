import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ModelEsque } from "../chat/providerIconUtils";

/** Choose a model for a harness without carrying another harness's model options. */
export function resolveDefaultHarnessSelection(
  instanceId: ProviderInstanceId,
  current: ModelSelection | null,
  models: ReadonlyArray<ModelEsque>,
): ModelSelection | null {
  const available = models.filter((model) => !model.isUnavailable);
  const model =
    available.find((option) => option.slug === current?.model) ??
    available.find((option) => option.isDefault) ??
    available[0];
  if (!model) return null;
  if (current?.instanceId === instanceId && current.model === model.slug) return current;
  return createModelSelection(instanceId, model.slug);
}
