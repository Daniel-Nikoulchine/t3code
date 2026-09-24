import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  isProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { CopyIcon } from "lucide-react";
import { ProviderInstanceTitleIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ProviderAuthCopy {
  /** Account label, e.g. "ChatGPT account". */
  readonly account: string;
  /** Primary button label, e.g. "Sign in with ChatGPT". */
  readonly signIn: string;
  /** Retry label after a failed or cancelled attempt. */
  readonly retry: string;
  /** Whether the flow shows a user code to type (Codex device auth). */
  readonly showsUserCode: boolean;
  /** Whether the flow expects a pasted code back (Claude). */
  readonly acceptsPastedCode: boolean;
}

const CODEX_COPY: ProviderAuthCopy = {
  account: "ChatGPT account",
  signIn: "Sign in with ChatGPT",
  retry: "Retry ChatGPT sign-in",
  showsUserCode: true,
  acceptsPastedCode: false,
};

const CLAUDE_COPY: ProviderAuthCopy = {
  account: "Claude account",
  signIn: "Sign in",
  retry: "Retry sign-in",
  showsUserCode: false,
  acceptsPastedCode: true,
};

const FALLBACK_COPY: ProviderAuthCopy = {
  account: "account",
  signIn: "Sign in",
  retry: "Retry sign-in",
  showsUserCode: false,
  acceptsPastedCode: false,
};

function authCopyFor(driver: string | undefined): ProviderAuthCopy {
  if (driver === "codex") return CODEX_COPY;
  if (driver === "claudeAgent") return CLAUDE_COPY;
  return FALLBACK_COPY;
}

interface ProviderAuthSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: string | undefined;
  readonly displayName: string;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
  readonly onRefreshStatus?: (() => void) | undefined;
}

/**
 * In-app sign-in for harness CLIs with a `ProviderAuthController` on the
 * server (Codex device auth, Claude code-paste login, …) — the "connect"
 * button. The browser flow always runs against the vendor's own
 * login, so this works with the browser on any machine; T3 only reads the
 * resulting login state back and never holds the token. Antigravity keeps
 * its bespoke `ProviderSetupSection`; every other driver with
 * `setup.canAuthenticate` renders here.
 */
export function ProviderAuthSection(props: ProviderAuthSectionProps) {
  if (props.readOnly) {
    return (
      <div className="flex min-h-18 items-center gap-3 px-3 py-3 sm:px-4">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            Setup unavailable
          </span>
          <span className="mt-0.5 block truncate text-[13px] leading-[1.45] text-muted-foreground/80">
            Provider setup is read-only.
          </span>
        </span>
      </div>
    );
  }
  if (props.provider?.setup === undefined) {
    return (
      <div className="flex min-h-18 items-center gap-3 px-3 py-3 sm:px-4">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            Update required
          </span>
          <span className="mt-0.5 block truncate text-[13px] leading-[1.45] text-muted-foreground/80">
            Update this environment to sign in from T3 Code.
          </span>
        </span>
      </div>
    );
  }
  return (
    <ProviderAuthActions
      key={`${props.environmentId}:${props.instanceId}`}
      environmentId={props.environmentId}
      environmentLabel={props.environmentLabel}
      instanceId={props.instanceId}
      driver={props.driver}
      displayName={props.displayName}
      provider={props.provider}
      onRefreshStatus={props.onRefreshStatus}
    />
  );
}

function ProviderAuthActions({
  environmentId,
  environmentLabel,
  instanceId,
  driver,
  displayName,
  provider,
  onRefreshStatus,
}: Omit<ProviderAuthSectionProps, "readOnly" | "provider"> & {
  readonly provider: ServerProvider;
}) {
  const copy = authCopyFor(driver);
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const auth = authQuery.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, commandOptions);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState({ flowId: null as string | null, value: "" });
  const [copied, setCopied] = useState<string | null>(null);
  const refreshedForFlowRef = useRef<string | null>(null);
  const codeValue = codeDraft.flowId === auth?.flowId ? codeDraft.value : "";
  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const authenticated = provider.auth.status === "authenticated";
  const authorizationUrl = auth?.phase === "waiting" ? auth.authorizationUrl : null;
  const userCode = auth?.phase === "waiting" ? auth.userCode : null;
  const queryError = authQuery.error;
  const actionsDisabled = pendingLabel !== null || queryError !== null;

  const statusMessage =
    auth === null
      ? "Reading sign-in status."
      : authActive || auth.phase === "failed" || auth.phase === "cancelled"
        ? (auth.message ?? "Sign-in is in progress.")
        : authenticated
          ? "Signed in."
          : "Not signed in.";

  // The snapshot probe picks the new login up on its own cycle, but nudging
  // a refresh the moment sign-in succeeds keeps the card (models, account)
  // from lagging a full health interval behind.
  useEffect(() => {
    if (auth?.phase === "succeeded" && onRefreshStatus) {
      const key = auth.flowId ?? "succeeded";
      if (refreshedForFlowRef.current !== key) {
        refreshedForFlowRef.current = key;
        onRefreshStatus();
      }
    }
    if (auth?.phase !== "succeeded") {
      refreshedForFlowRef.current = null;
    }
  }, [auth?.flowId, auth?.phase, onRefreshStatus]);

  async function runCommand<A, E>(
    label: string,
    request: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPendingLabel(label);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Sign-in failed. Try again.");
        }
        return false;
      }
      return true;
    } catch {
      setError("Sign-in failed. Try again.");
      return false;
    } finally {
      pendingRef.current = false;
      setPendingLabel(null);
    }
  }

  async function openSignInPage() {
    if (!authorizationUrl) return;
    try {
      await ensureLocalApi().shell.openExternal(authorizationUrl);
      setError(null);
    } catch {
      setError("Could not open the sign-in page. Copy the link and open it in your browser.");
    }
  }

  async function copyText(value: string, flag: string, providerName: string) {
    try {
      await writeTextToClipboard(value, `${providerName} sign-in`);
      setCopied(flag);
      setError(null);
    } catch {
      setError("Could not copy. Select the text manually.");
    }
  }

  async function submitCode() {
    const flowId = auth?.flowId;
    if (!flowId || !codeValue.trim() || auth.phase !== "waiting") return;
    const accepted = await runCommand("Checking code", () =>
      completeAuth({ environmentId, input: { instanceId, flowId, callbackUrl: codeValue } }),
    );
    if (accepted) {
      setCodeDraft({ flowId: null, value: "" });
    }
  }

  async function signOut() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Sign out ${displayName} on ${environmentLabel}? This stops its running threads. Thread history is kept.`,
    );
    if (confirmed) {
      const signedOut = await runCommand("Signing out", () => logoutAuth(target));
      if (signedOut) {
        onRefreshStatus?.();
      }
    }
  }

  const driverKind = driver !== undefined && isProviderDriverKind(driver) ? driver : null;
  return (
    <div>
      <div className="flex min-h-18 items-center gap-3 px-3 py-3 sm:px-4">
        <ProviderInstanceTitleIcon
          displayName={displayName}
          driverKind={driverKind}
          accentColor={undefined}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{copy.account}</span>
          <span className="mt-0.5 block truncate text-[13px] leading-[1.45] text-muted-foreground/80">
            {pendingLabel ?? statusMessage}
          </span>
          {pendingLabel ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-[13px] leading-[1.45] text-muted-foreground">
              <Spinner className="size-3" />
              <span className="truncate">{pendingLabel}</span>
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {authorizationUrl ? (
            <>
              <Button size="xs" variant="outline" onClick={() => void openSignInPage()}>
                Open sign-in page
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void copyText(authorizationUrl, "link", displayName)}
              >
                {copied === "link" && auth?.flowId ? "Link copied" : "Copy sign-in link"}
              </Button>
            </>
          ) : null}
          {authActive && auth?.flowId ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={actionsDisabled}
              onClick={() => {
                const flowId = auth.flowId;
                if (!flowId) return;
                void runCommand("Cancelling sign-in", () =>
                  cancelAuth({ environmentId, input: { instanceId, flowId } }),
                );
              }}
            >
              Cancel sign-in
            </Button>
          ) : !authActive && !authenticated && provider.setup?.canAuthenticate ? (
            <Button
              size="xs"
              variant="outline"
              disabled={actionsDisabled || auth === null}
              onClick={() => void runCommand("Starting sign-in", () => startAuth(target))}
            >
              {auth?.phase === "failed" || auth?.phase === "cancelled" ? copy.retry : copy.signIn}
            </Button>
          ) : null}
          {!authActive && provider.setup?.canAuthenticate && authenticated ? (
            <Button
              size="xs"
              variant="outline"
              disabled={actionsDisabled || auth === null}
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          ) : null}
        </span>
      </div>
      {auth?.phase === "waiting" ? (
        <div className="space-y-3 border-t border-border/50 px-3 py-3 pl-11 sm:px-4 sm:pl-12">
          {auth.expiresAt ? (
            <p className="text-xs text-muted-foreground">
              Link expires at{" "}
              <time dateTime={auth.expiresAt}>
                {new Date(auth.expiresAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
              .
            </p>
          ) : null}
          {copy.showsUserCode && userCode ? (
            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">
                Open the sign-in page, then enter this code:
              </p>
              <div className="flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border/70 bg-muted/40 px-2 py-1.5 text-center font-mono text-sm tracking-[0.2em] text-foreground sm:max-w-64 sm:flex-none">
                  {userCode}
                </code>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => void copyText(userCode, "code", displayName)}
                        aria-label="Copy sign-in code"
                      >
                        <CopyIcon className="size-3" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">
                    {copied === "code" ? "Copied" : "Copy code"}
                  </TooltipPopup>
                </Tooltip>
              </div>
            </div>
          ) : null}
          {copy.acceptsPastedCode ? (
            <form
              className="grid max-w-md gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCode();
              }}
            >
              <label
                htmlFor={`provider-auth-code-${instanceId}`}
                className="text-xs text-muted-foreground"
              >
                Complete sign-in in the browser, then paste the code here.
              </label>
              <Input
                id={`provider-auth-code-${instanceId}`}
                size="sm"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the code"
                value={codeValue}
                maxLength={512}
                disabled={actionsDisabled}
                onChange={(event) =>
                  setCodeDraft({ flowId: auth?.flowId ?? null, value: event.target.value })
                }
              />
              <Button
                size="xs"
                variant="outline"
                type="submit"
                className="w-fit"
                disabled={actionsDisabled || !codeValue.trim()}
              >
                Continue
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      <p className="sr-only" role="status">
        {pendingLabel ? `${pendingLabel}.` : null}
      </p>
      {error || queryError ? (
        <div
          className={cn(
            "grid gap-2 px-3 py-3 pl-11 sm:px-4 sm:pl-12",
            auth?.phase === "waiting" ? undefined : "border-t border-border/50",
          )}
        >
          <p role="alert" className="text-[13px] text-destructive [overflow-wrap:anywhere]">
            {error ?? queryError}
          </p>
          {queryError ? (
            <Button
              size="xs"
              variant="outline"
              className="w-fit"
              onClick={() => {
                authQuery.refresh();
              }}
            >
              Retry setup status
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
