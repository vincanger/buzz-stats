import { randomBytes } from "node:crypto";
import { nip19 } from "nostr-tools";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { createSession } from "wasp/auth/session";
import { HttpError } from "wasp/server";
import type { GetNostrChallenge, VerifyNostrLogin } from "wasp/server/api";
import {
  createProviderId,
  createUser,
  findAuthIdentity,
  sanitizeAndSerializeProviderData,
} from "wasp/server/auth";

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
/** NIP-42-style client auth event. */
const AUTH_EVENT_KIND = 22242;
/** Max clock skew between the signed event and the server. */
const MAX_EVENT_AGE_SECONDS = 60;

export const getNostrChallenge: GetNostrChallenge = async (
  _req,
  res,
  context,
) => {
  const nonce = randomBytes(32).toString("hex");
  await context.entities.NostrChallenge.create({
    data: { nonce, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
  });
  res.json({ challenge: nonce });
};

export const verifyNostrLogin: VerifyNostrLogin = async (req, res, context) => {
  const event = (req.body as { signedEvent?: Event } | undefined)?.signedEvent;
  if (!event || typeof event !== "object") {
    throw new HttpError(400, "missing signedEvent in request body");
  }
  if (event.kind !== AUTH_EVENT_KIND) {
    throw new HttpError(400, `expected a kind ${AUTH_EVENT_KIND} event`);
  }
  if (!verifyEvent(event)) {
    throw new HttpError(401, "invalid event signature");
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - event.created_at);
  if (ageSeconds > MAX_EVENT_AGE_SECONDS) {
    throw new HttpError(401, "signed event timestamp is too old");
  }

  const nonce = event.tags.find((tag) => tag[0] === "challenge")?.[1];
  if (!nonce) {
    throw new HttpError(400, "signed event is missing a challenge tag");
  }
  // updateMany + count check burns the nonce atomically, so a replayed event
  // loses the race instead of minting a second session.
  const { count } = await context.entities.NostrChallenge.updateMany({
    where: { nonce, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (count !== 1) {
    throw new HttpError(401, "unknown, expired, or already-used challenge");
  }

  const pubkey = event.pubkey.toLowerCase();
  const authId = await findOrCreateAuthId(pubkey);
  const session = await createSession(authId);
  res.json({ sessionId: session.id });
};

/**
 * Nostr identities are stored under Wasp's `username` provider with the hex
 * pubkey as the username. The password is random and discarded — signing the
 * challenge is the only login path.
 */
async function findOrCreateAuthId(pubkey: string): Promise<string> {
  const providerId = createProviderId("username", pubkey);
  const existing = await findAuthIdentity(providerId);
  if (existing) {
    return existing.authId;
  }
  const providerData = await sanitizeAndSerializeProviderData<"username">({
    hashedPassword: randomBytes(32).toString("hex"),
  });
  const user = await createUser(providerId, providerData, {
    pubkey,
    npub: nip19.npubEncode(pubkey),
  });
  if (!user.auth) {
    throw new HttpError(500, "user was created without an auth record");
  }
  return user.auth.id;
}
