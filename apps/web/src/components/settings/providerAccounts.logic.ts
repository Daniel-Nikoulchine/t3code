import type { ServerProvider } from "@t3tools/contracts";

/**
 * Drivers whose account can be signed in through the vendor's own OAuth flow
 * (the CLI's ChatGPT or Claude subscription login) instead of an API key.
 * Antigravity signs in through its bespoke setup section and API-key-only
 * drivers never authenticate this way.
 */
const OAUTH_ACCOUNT_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

/**
 * Whether a provider snapshot is a signed-in OAuth account worth listing on
 * the Providers tab: enabled, authenticated, on an OAuth-capable driver, and
 * not authenticated via an API key — key logins already live in the
 * connection/credential rows, not in the account rows. Every other auth
 * (subscription plans, plain OAuth, Bedrock) qualifies.
 */
export function isSignedInProviderAccount(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.auth.status === "authenticated" &&
    provider.auth.type !== "apiKey" &&
    OAUTH_ACCOUNT_DRIVERS.has(provider.driver)
  );
}
