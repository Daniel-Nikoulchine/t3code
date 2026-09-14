/**
 * OpenClawAdapter — shape type for the OpenClaw provider adapter.
 *
 * Mirrors the other single-adapter drivers (e.g. `HermesAdapter`): the
 * driver model ({@link ../Drivers/OpenClawDriver}) bundles one adapter per
 * instance as a captured closure, so only the shape interface is retained
 * here as a naming anchor for the driver bundle.
 *
 * @module OpenClawAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpenClawAdapterShape — per-instance OpenClaw adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface OpenClawAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
