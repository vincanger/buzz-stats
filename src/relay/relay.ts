import type { Filter } from "nostr-tools/filter";
import { finalizeEvent, type Event } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";

const CONNECT_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 10_000;

/** nostr-tools throws this exact message until the relay's challenge lands. */
const NO_CHALLENGE_YET = "no challenge was received";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * NIP-42 handshake. Buzz challenges proactively on connect, but the CHALLENGE
 * frame can arrive a beat after `connect()` resolves — so retry only that one
 * condition, and let a real rejection (not a member, banned, expired) surface
 * immediately instead of stalling for the full timeout.
 */
async function authenticate(relay: Relay, secretKey: Uint8Array): Promise<void> {
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  for (;;) {
    try {
      await relay.auth((template) =>
        Promise.resolve(finalizeEvent(template, secretKey)),
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(NO_CHALLENGE_YET)) {
        throw new Error(`NIP-42 auth rejected: ${message}`);
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the relay's NIP-42 challenge");
      }
      await sleep(50);
    }
  }
}

/**
 * Connect, authenticate, run `fn`, always close. The socket is deliberately
 * short-lived: a daily job has no reason to hold one open between runs.
 */
export async function withBuzzRelay<T>(
  { relayUrl, secretKey }: { relayUrl: string; secretKey: Uint8Array },
  fn: (relay: Relay) => Promise<T>,
): Promise<T> {
  const relay = new Relay(relayUrl);
  await relay.connect({ timeout: CONNECT_TIMEOUT_MS });
  try {
    await authenticate(relay, secretKey);
    return await fn(relay);
  } finally {
    relay.close();
  }
}

/**
 * One-shot historical query: collect everything up to EOSE, then close.
 * A timeout resolves with whatever arrived rather than rejecting — callers use
 * this for best-effort checks where an empty result is a safe answer.
 */
export function queryOnce(
  relay: Relay,
  filter: Filter,
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const events: Event[] = [];
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        sub.close();
        resolve(events);
      });
    }, timeoutMs);

    const sub = relay.subscribe([filter], {
      onevent: (event) => events.push(event),
      oneose: () => {
        finish(() => {
          sub.close();
          resolve(events);
        });
      },
      onclose: (reason) => {
        finish(() => reject(new Error(`subscription closed: ${reason}`)));
      },
    });
  });
}
