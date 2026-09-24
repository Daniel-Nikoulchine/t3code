import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * CLI login command per harness driver, mirroring `docs/user/install.md`.
 * Most harnesses authenticate through their own CLI, which opens the vendor
 * OAuth flow in the browser on the environment — T3 Code reads the resulting
 * login state back via its status probe, it never sees the OAuth token
 * itself (see `docs/internals/model-routing.md` for the credential
 * boundary). Antigravity is the exception: it signs in from inside T3 Code
 * via its Setup section, so it has no terminal command here.
 */
const PROVIDER_LOGIN_COMMANDS: Readonly<Record<string, string>> = {
  codex: "codex login",
  claudeAgent: "claude auth login",
  cline: "cline auth",
  cursor: "agent login",
  deepseek: "deepseek login",
  devin: "devin auth login",
  droid: "droid",
  freebuff: "freebuff login",
  grok: "grok login",
  copilot: "gh auth login",
  kilo: "kilo auth login",
  minimax: "mcode login",
  opencode: "opencode auth login",
  openclaw: "openclaw login",
  pi: "pi",
  omp: "omp",
  zcode: "zcode login",
  hermes: "hermes login",
};

const LOGIN_COMMAND_HINTS: Readonly<Record<string, string>> = {
  droid: "First interactive launch walks through sign-in.",
  pi: "Then run /login inside Pi and pick a provider.",
  omp: "Then run /login inside Oh My Pi and pick a provider.",
  cursor: "Executable is cursor-agent, login command is agent login.",
};

/** Terminal login command for a harness, or `null` when it signs in inside T3 Code. */
export function getProviderLoginCommand(driver: ProviderDriverKind | undefined): string | null {
  if (driver === undefined) return null;
  if (driver === "antigravity") return null;
  return PROVIDER_LOGIN_COMMANDS[String(driver)] ?? null;
}

/** Extra one-line hint for drivers whose login is not a plain command. */
export function getProviderLoginHint(driver: ProviderDriverKind | undefined): string | null {
  if (driver === undefined) return null;
  return LOGIN_COMMAND_HINTS[String(driver)] ?? null;
}
