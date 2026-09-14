/**
 * Re-export of the thread fallback-combo contract.
 *
 * The `FallbackCombo` struct lives in `orchestration.ts` (next to
 * `ModelSelection`, which it is built from) to avoid an ESM import cycle:
 * this module needs `ModelSelection` from `orchestration.ts`, so
 * `orchestration.ts` cannot import the struct back from here. Import from
 * either path; both resolve to the same schema.
 */
export {
  DEFAULT_FALLBACK_STRATEGY,
  DEFAULT_FALLBACK_TRIGGERS,
  FallbackCombo,
  FallbackComboTarget,
  FallbackStrategy,
  FallbackTrigger,
} from "./orchestration.ts";
