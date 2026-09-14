import { ProviderDriverKind } from "@t3tools/contracts";
import {
  AntigravityIcon,
  ClaudeAI,
  ClineIcon,
  CursorIcon,
  DeepSeekIcon,
  DevinIcon,
  DroidIcon,
  GithubCopilotIcon,
  GrokIcon,
  HermesIcon,
  Icon,
  KiloIcon,
  OpenAI,
  OpenClawIcon,
  OpenCodeIcon,
  PiAgentIcon,
  ZcodeIcon,
} from "../Icons";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("cline")]: ClineIcon,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("openclaw")]: OpenClawIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("deepseek")]: DeepSeekIcon,
  [ProviderDriverKind.make("devin")]: DevinIcon,
  [ProviderDriverKind.make("droid")]: DroidIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("copilot")]: GithubCopilotIcon,
  [ProviderDriverKind.make("hermes")]: HermesIcon,
  [ProviderDriverKind.make("kilo")]: KiloIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
  [ProviderDriverKind.make("pi")]: PiAgentIcon,
  [ProviderDriverKind.make("zcode")]: ZcodeIcon,
};

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
  /** True when the owning instance routes through an external model backend
   *  (proxy). Resolved per instance from the provider snapshot, not per
   *  model — every model of a proxied instance carries the flag. */
  viaProxy?: boolean | undefined;
  /** True when the proxy degrades model capabilities (thinking/tools/
   *  caching may behave differently). Only meaningful with `viaProxy`. */
  capabilitiesDegraded?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
