import {
  init as initNostrLogin,
  launch,
  logout as nostrLogout,
} from "nostr-login";
import { useEffect, useRef, useState } from "react";
import { api, handleApiError, setSessionId } from "wasp/client/api";
import "../Main.css";

/** NIP-42-style client auth event, verified server-side. */
const AUTH_EVENT_KIND = 22242;
/** How long we wait for the user's signer before giving up. */
const SIGN_TIMEOUT_MS = 60_000;

type Status =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "error"; message: string };

// nostr-login's init() is not idempotent — calling it twice (e.g. React
// StrictMode re-running effects) injects duplicate widgets and breaks
// launch(). Module-level guard keeps it to exactly one init per page load.
let nostrLoginReady: Promise<void> | null = null;
function ensureNostrLogin(): Promise<void> {
  if (nostrLoginReady === null) {
    // Must happen before init: once the widget restores a read-only account
    // it stays wedged for the whole page load (launch() won't open the
    // dialog) and its own logout() can't fully recover.
    purgeReadOnlyAccounts();
    installNostrJsonFetchTimeout();
  }
  nostrLoginReady ??= initNostrLogin({
    title: "Buzz Stats",
    description: "Sign in with your Nostr identity to view your Buzz stats.",
    // Read-only logins can't sign the challenge, so they can never complete
    // our auth flow — don't offer them.
    methods: ["connect", "extension", "local"],
  });
  return nostrLoginReady;
}

/**
 * The widget persists its account across visits (and its logout doesn't always
 * clear it). A lingering read-only account makes launch() think the user is
 * signed in and silently skip the modal — the "sometimes the dialog doesn't
 * open" failure mode.
 */
function getPersistedAuthMethod(): string | null {
  try {
    const raw = localStorage.getItem("__nostrlogin_nip46");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { authMethod?: string; pubkey?: string };
    return parsed.pubkey ? (parsed.authMethod ?? null) : null;
  } catch {
    return null;
  }
}

/** Read-only accounts can't sign and wedge the widget — drop them from its storage. */
function purgeReadOnlyAccounts(): void {
  try {
    if (getPersistedAuthMethod() === "readOnly") {
      localStorage.removeItem("__nostrlogin_nip46");
    }
    const rawAccounts = localStorage.getItem("__nostrlogin_accounts");
    if (rawAccounts) {
      const accounts = JSON.parse(rawAccounts) as { authMethod?: string }[];
      localStorage.setItem(
        "__nostrlogin_accounts",
        JSON.stringify(accounts.filter((a) => a.authMethod !== "readOnly")),
      );
    }
  } catch {
    // Corrupt storage — the widget will rebuild it.
  }
}

/**
 * Before showing its dialog, nostr-login awaits `.well-known/nostr.json`
 * fetches to nsec.app and highlighter.com with no timeout — a slow response
 * delays the dialog by seconds or hangs it entirely (the "sometimes nothing
 * happens" bug). It handles fetch failures fine (falls back to a default
 * relay), so aborting the slow ones after 2.5s makes launch reliable.
 */
function installNostrJsonFetchTimeout(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.includes("/.well-known/nostr.json")) {
      return originalFetch(input, init);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2_500);
    return originalFetch(input, { ...init, signal: controller.signal });
  };
}

function waitForElement(
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (document.querySelector(selector)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 100);
    };
    poll();
  });
}

function signWithTimeout(
  template: Parameters<NonNullable<typeof window.nostr>["signEvent"]>[0],
) {
  return Promise.race([
    window.nostr!.signEvent(template),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for your signer")),
        SIGN_TIMEOUT_MS,
      ),
    ),
  ]);
}

export function LoginPage() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // nlAuth fires once per widget login, but React StrictMode double-mounts —
  // the ref makes sure only one challenge exchange runs.
  const exchangeInFlight = useRef(false);

  useEffect(() => {
    void ensureNostrLogin();

    const onAuth = (event: globalThis.Event) => {
      const detail = (event as CustomEvent).detail as {
        type?: string;
        method?: string;
      };
      if (detail?.type !== "login" && detail?.type !== "signup") {
        return;
      }
      if (detail.method === "readOnly") {
        // Shouldn't happen with methods restricted above, but a stale
        // read-only account can still be restored from storage.
        void resetReadOnlyAccount();
        return;
      }
      void completeLogin();
    };

    document.addEventListener("nlAuth", onAuth);
    return () => document.removeEventListener("nlAuth", onAuth);
  }, []);

  async function resetReadOnlyAccount() {
    setStatus({
      kind: "error",
      message:
        "A read-only Nostr session can't sign in — it has no signing key. " +
        "Please log in with an extension, remote signer, or new identity.",
    });
    try {
      await nostrLogout();
    } catch {
      // Best effort — worst case the user picks a different method manually.
    }
  }

  async function onSignInClick() {
    try {
      // The widget can take a couple of seconds to open (it phones home for
      // signer/bunker metadata) — show progress so a click never looks dead.
      setStatus({ kind: "working", message: "Opening the sign-in dialog…" });
      await ensureNostrLogin();
      if (getPersistedAuthMethod() === "readOnly") {
        // Clear the stuck account first, otherwise launch() may not show
        // the modal at all.
        await nostrLogout().catch(() => {});
      } else if (getPersistedAuthMethod()) {
        // A signer is already connected from a previous visit — no modal
        // needed, go straight to the challenge exchange.
        await completeLogin();
        return;
      }
      // Don't await launch(): its promise doesn't settle until the dialog
      // closes. Instead watch for the dialog element to actually appear.
      launch("welcome").catch(() => {});
      const opened = await waitForElement("nl-auth", 8_000);
      setStatus(
        opened
          ? { kind: "idle" }
          : {
              kind: "error",
              message:
                "The sign-in dialog didn't open — try reloading the page.",
            },
      );
    } catch (error) {
      setStatus({
        kind: "error",
        message: `Could not open the sign-in dialog: ${String(error)}`,
      });
    }
  }

  async function completeLogin() {
    if (exchangeInFlight.current) {
      return;
    }
    exchangeInFlight.current = true;
    setStatus({ kind: "working", message: "Verifying your signature…" });
    try {
      const { challenge } = await api
        .get("auth/nostr/challenge")
        .json<{ challenge: string }>();

      const signedEvent = await signWithTimeout({
        kind: AUTH_EVENT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["challenge", challenge]],
        content: "",
      });

      const { sessionId } = await api
        .post("auth/nostr/verify", { json: { signedEvent } })
        .json<{ sessionId: string }>();

      setSessionId(sessionId);
      // Full reload so every Wasp query and useAuth picks up the new session.
      window.location.assign("/");
    } catch (error) {
      exchangeInFlight.current = false;
      const message =
        error instanceof Error ? error.message : "something went wrong";
      setStatus({ kind: "error", message: `Login failed: ${message}` });
      try {
        handleApiError(error);
      } catch {
        // handleApiError rethrows; we've already shown the message.
      }
    }
  }

  return (
    <main className="login">
      <h1 className="logo">
        Buzz <mark>Stats</mark>
      </h1>
      <p className="login-tagline">
        Stats for your Buzz relay: agent tasks, member activity, and who's
        working with whom.
      </p>
      <button
        className="btn"
        onClick={() => void onSignInClick()}
        disabled={status.kind === "working"}
      >
        Sign in with Nostr (Buzz)
      </button>
      <p className="login-status" aria-live="polite">
        {status.kind === "working" && status.message}
        {status.kind === "error" && <span role="alert">{status.message}</span>}
      </p>
      <p className="login-hint">
        New to Nostr? Choose “Sign up” in the dialog and an identity will be
        created for you — no extension needed.
      </p>
    </main>
  );
}
