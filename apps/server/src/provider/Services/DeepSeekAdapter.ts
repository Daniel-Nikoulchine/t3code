/**
 * DeepSeekAdapter — shape type for the DeepSeek provider adapter.
 *
 * The driver model ({@link ../Drivers/DeepSeekDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module DeepSeekAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * DeepSeekAdapterShape — per-instance DeepSeek adapter contract.
 */
export interface DeepSeekAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
