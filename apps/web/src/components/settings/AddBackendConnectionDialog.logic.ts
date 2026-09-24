import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";

/**
 * In-app OAuth sign-in the Add-provider dialog can run: the harnesses whose
 * CLI login is driven from inside T3 Code through a `ProviderAuthController`
 * on the server. The grid order below is the dialog order.
 */
export interface ProviderOAuthTarget {
  readonly dialogId: string;
  readonly account: string;
  readonly driver: string;
  readonly instanceId: ReturnType<typeof defaultInstanceIdForDriver>;
}

export const PROVIDER_OAUTH_TARGETS: ReadonlyArray<ProviderOAuthTarget> = [
  {
    dialogId: "openai-oauth",
    account: "ChatGPT account",
    driver: "codex",
    instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
  },
  {
    dialogId: "claude-oauth",
    account: "Claude account",
    driver: "claudeAgent",
    instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")),
  },
];

/**
 * The one connection template whose account can also be a ChatGPT
 * subscription login: OpenAI offers OAuth (the Codex CLI's device-code
 * sign-in) alongside the usual API-key endpoint.
 */
export const OPENAI_PRESET_ID = "openai";

/**
 * Default Codex harness instance the OpenAI OAuth sign-in belongs to. The
 * ChatGPT subscription is the Codex CLI's own login, so the OAuth choice
 * runs that flow against this harness instance — inside the dialog, without
 * creating a connection.
 */
export const OPENAI_HARNESS_INSTANCE_ID = defaultInstanceIdForDriver(
  ProviderDriverKind.make("codex"),
);

/**
 * Whether picking this template should ask how to connect (OAuth vs API key)
 * before the connection form. Only the OpenAI template adds the extra step,
 * and only while adding — editing an existing connection goes straight to
 * the form.
 */
export function asksForAuthMethod(input: {
  readonly presetId: string | undefined;
  readonly editing: boolean;
}): boolean {
  return !input.editing && input.presetId === OPENAI_PRESET_ID;
}
