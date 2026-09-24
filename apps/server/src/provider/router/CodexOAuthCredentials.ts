import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

import { withCodexAppServerClient } from "../Layers/CodexProvider.ts";

/** One upstream auth entry from `codex app-server getAuthStatus`. */
export interface CodexOAuthCredentials {
  readonly authToken: string;
  readonly chatgptAccountId: string | undefined;
  readonly email: string | undefined;
}

const decodeBase64UrlJson = (segment: string): Record<string, unknown> | undefined => {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/**
 * Decode the ChatGPT account binding out of a Codex access token JWT. The
 * account header is required when the environment holds more than one Codex
 * account; requests without it cross-bind to the wrong account.
 */
export const decodeTokenClaims = (
  authToken: string,
):
  | { readonly chatgptAccountId: string | undefined; readonly email: string | undefined }
  | undefined => {
  const segments = authToken.split(".");
  if (segments.length !== 3) return undefined;
  const payload = decodeBase64UrlJson(segments[1]!);
  if (payload === undefined) return undefined;
  const auth = payload["https://api.openai.com/auth"] as
    | { chatgpt_account_id?: unknown; user_email?: unknown }
    | undefined;
  return {
    chatgptAccountId:
      typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
};

/**
 * Mint a bearer token for the ChatGPT backend through the harness's own
 * login: a short-lived `codex app-server` runs `getAuthStatus` with token
 * refresh enabled. Errors map to a tagged failure — the router relays them
 * as a 502-style upstream error in the harness's protocol.
 */
export const resolveCodexOAuthCredentials = Effect.fn("CodexOAuthCredentials.resolve")(
  function* (input: {
    readonly binaryPath: string;
    readonly homePath?: string | undefined;
    readonly launchArgs?: string | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  }) {
    const { client } = yield* withCodexAppServerClient({
      binaryPath: input.binaryPath,
      ...(input.homePath === undefined ? {} : { homePath: input.homePath }),
      ...(input.launchArgs === undefined ? {} : { launchArgs: input.launchArgs }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      // Account-level request; any directory serves, same as the status probe.
      cwd: process.cwd(),
    }).pipe(
      // A broken harness environment (spawn defect, handshake crash) must
      // surface as the tagged failure the router relays upstream, not escape
      // as an interrupting defect that takes down the request fiber.
      Effect.catchCause(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${input.binaryPath} app-server`,
            cause,
          }),
      ),
    );
    const status = yield* client
      .request("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: "codex app-server getAuthStatus",
              cause,
            }),
        ),
      );
    if (typeof status.authToken !== "string" || status.authToken.length === 0) {
      return yield* new CodexErrors.CodexAppServerSpawnError({
        command: "codex app-server getAuthStatus",
        cause: "No OAuth login for this Codex home — run codex login.",
      });
    }
    const claims = decodeTokenClaims(status.authToken);
    return {
      authToken: status.authToken,
      chatgptAccountId: claims?.chatgptAccountId,
      email: claims?.email,
    } satisfies CodexOAuthCredentials;
  },
);
