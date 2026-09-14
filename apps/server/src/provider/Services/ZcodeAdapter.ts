/**
 * ZcodeAdapter — shape type for the ZCode provider adapter.
 *
 * The driver model ({@link ../Drivers/ZcodeDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module ZcodeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ZcodeAdapterShape — per-instance ZCode adapter contract.
 */
export interface ZcodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
