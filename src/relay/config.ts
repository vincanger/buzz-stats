import { hexToBytes } from "nostr-tools/utils";

/**
 * The app reads the Buzz relay with its own enrolled bot identity — users log
 * in with nostr to view, but never hand us relay credentials. Run
 * `node --env-file=.env.server scripts/buzz-enroll.mjs` to mint the bot key
 * and claim a community invite, then set the env vars below.
 */

export const BUZZ_RELAY_URL =
  process.env.BUZZ_RELAY_URL ?? "wss://wasp.communities.buzz.xyz";

/**
 * Buzz event kinds we sync. See github.com/block/buzz ARCHITECTURE.md:
 * 0 profile, 7 reaction, 9 + 40002 stream messages, 13534 membership roster,
 * 43001 agent job request, 45001/45003 forum, 46001–46012 workflow runs.
 */
export const SYNCED_KINDS = [
  0, 7, 9, 13534, 40002, 43001, 45001, 45003,
  ...Array.from({ length: 12 }, (_, i) => 46001 + i),
];

/** Agents active within this window count as "currently involved". */
export const ACTIVE_WINDOW_MINUTES = 15;

/** Default period for dashboard aggregates. */
export const STATS_PERIOD_DAYS = 7;

export type RelayBotConfig = {
  relayUrl: string;
  secretKey: Uint8Array;
};

/**
 * Null (with a warning) when the bot isn't enrolled yet, so the sync job can
 * no-op instead of failing deploys that haven't set up relay access.
 */
export function readRelayBotConfig(): RelayBotConfig | null {
  const secretKeyHex = process.env.BUZZ_NOSTR_SECRET_KEY;
  if (!secretKeyHex) {
    console.warn(
      "[buzz-sync] BUZZ_NOSTR_SECRET_KEY unset — skipping relay sync. " +
        "Run `node --env-file=.env.server scripts/buzz-enroll.mjs` to enroll.",
    );
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(secretKeyHex)) {
    console.error(
      "[buzz-sync] BUZZ_NOSTR_SECRET_KEY must be 64 hex characters (a 32-byte nostr secret key)",
    );
    return null;
  }
  return { relayUrl: BUZZ_RELAY_URL, secretKey: hexToBytes(secretKeyHex) };
}

/**
 * Extra pubkeys to treat as agents, beyond what the relay roster marks as
 * bots — comma-separated hex pubkeys in AGENT_PUBKEYS.
 */
export function readAgentPubkeyOverrides(): Set<string> {
  return new Set(
    (process.env.AGENT_PUBKEYS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{64}$/.test(s)),
  );
}
