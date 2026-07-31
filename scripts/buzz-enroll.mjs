/**
 * One-off enrollment for the Buzz stats bot.
 *
 *   node --env-file=.env.server scripts/buzz-enroll.mjs
 *
 * Mints the bot's nostr keypair (or reuses BUZZ_NOSTR_SECRET_KEY), claims a
 * community invite, publishes a profile so the channel shows a name rather than
 * a bare pubkey, creates the stats channel, and prints the env vars to save.
 *
 * Safe to re-run: claiming an invite twice returns `already_member`, and an
 * existing channel is reused rather than duplicated.
 *
 * Required: BUZZ_INVITE_CODE (the code from an invite link, i.e. everything
 * after `/invite/`). Optional: BUZZ_RELAY_URL, BUZZ_NOSTR_SECRET_KEY.
 */

import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

const RELAY_URL = process.env.BUZZ_RELAY_URL ?? "wss://wasp.communities.buzz.xyz";
const CHANNEL_NAME = "tweet-stats-from-app";
const CHANNEL_VISIBILITY = process.env.BUZZ_CHANNEL_VISIBILITY ?? "open";
const INVITE_CODE = process.env.BUZZ_INVITE_CODE;

const KIND_PROFILE = 0;
const KIND_NIP98 = 27235;
const KIND_CREATE_GROUP = 9007;
const KIND_GROUP_METADATA = 39000;

const httpBase = RELAY_URL.replace(/^ws/, "http").replace(/\/+$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

if (!INVITE_CODE) {
  fail(
    "BUZZ_INVITE_CODE is required.\n" +
      "  Grab it from an invite link — everything after /invite/ — and pass it:\n" +
      "  BUZZ_INVITE_CODE=<code> node --env-file=.env.server scripts/buzz-enroll.mjs",
  );
}

// ---------------------------------------------------------------- identity ---

const existingKey = process.env.BUZZ_NOSTR_SECRET_KEY;
if (existingKey && !/^[0-9a-f]{64}$/i.test(existingKey)) {
  fail("BUZZ_NOSTR_SECRET_KEY is set but is not 64 hex characters.");
}
const secretKey = existingKey ? hexToBytes(existingKey) : generateSecretKey();
const pubkey = getPublicKey(secretKey);

console.log(existingKey ? "Reusing the configured keypair." : "Generated a new keypair.");
console.log(`  pubkey: ${pubkey}`);
if (!existingKey) {
  // Printed here, not just on success: a freshly minted key is unrecoverable,
  // so it must reach the operator even if a later step fails.
  console.log(`  secret: ${bytesToHex(secretKey)}   <- save this now`);
}

// ------------------------------------------------------------------ NIP-98 ---

/**
 * Buzz verifies the `u` tag against the exact request URL and requires a
 * `payload` tag holding sha256 of the exact body bytes, so both are fixed
 * before signing (api/invites.rs passes `require_payload: true`).
 */
async function nip98Post(path, payload) {
  const url = `${httpBase}${path}`;
  const body = JSON.stringify(payload);
  const authEvent = finalizeEvent(
    {
      kind: KIND_NIP98,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
        ["nonce", randomUUID()],
      ],
    },
    secretKey,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(authEvent)).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.error ?? `HTTP ${response.status}`);
    error.code = json.error;
    throw error;
  }
  return json;
}

// ------------------------------------------------------------------- claim ---

/**
 * `POST /api/invites/claim` is the one endpoint exempt from the relay
 * membership gate — NIP-98 proves the joining key, the invite's HMAC proves the
 * invite. This is what lets the bot enroll without an admin.
 */
async function claimInvite() {
  try {
    return await nip98Post("/api/invites/claim", { code: INVITE_CODE });
  } catch (error) {
    if (error.code !== "join_policy_required") {
      throw error;
    }
  }

  // The community requires accepting terms before joining. That's an
  // attestation on the operator's behalf, so it needs an explicit opt-in
  // rather than being auto-checked here.
  //
  // The response nests everything under `policy`, in snake_case — reading
  // `version` off the top level silently sends nothing and the relay rejects
  // the acceptance body.
  const { policy } = await fetch(`${httpBase}/api/join-policy`).then((r) => r.json());
  if (!policy?.version) {
    fail(
      "the relay asked for policy acceptance but GET /api/join-policy returned no policy version.",
    );
  }
  if (process.env.BUZZ_ACCEPT_JOIN_POLICY !== "true") {
    fail(
      `This community requires accepting its join policy (version ${policy.version}).\n` +
        `  Terms:   ${httpBase}/api/join-policy/terms\n` +
        `  Privacy: ${httpBase}/api/join-policy/privacy\n` +
        (policy.age_attestation_required
          ? "  Accepting also attests the account meets the minimum age.\n"
          : "") +
        "  Review them, then re-run with BUZZ_ACCEPT_JOIN_POLICY=true to accept on the bot's behalf.",
    );
  }

  console.log(`  accepting join policy ${policy.version.slice(0, 12)}… …`);
  const { receipt } = await nip98Post("/api/invites/accept-policy", {
    code: INVITE_CODE,
    policy_version: policy.version,
    age_confirmed: true,
  });
  return nip98Post("/api/invites/claim", {
    code: INVITE_CODE,
    policy_receipt: receipt,
  });
}

console.log(`\nClaiming invite at ${httpBase} …`);
let claim;
try {
  claim = await claimInvite();
} catch (error) {
  fail(
    `invite claim failed: ${error.message}\n` +
      (error.code === "invite_expired"
        ? "  The invite has expired — mint a fresh one from the Buzz client."
        : "  Check that the code is complete and belongs to this relay."),
  );
}
console.log(`  ${claim.status} — community ${claim.community_id}, role ${claim.role}`);

// ------------------------------------------------------- relay + NIP-42 auth ---

const relay = new Relay(RELAY_URL);
await relay.connect({ timeout: 15_000 });

async function authenticate() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await relay.auth((template) => Promise.resolve(finalizeEvent(template, secretKey)));
      return;
    } catch (error) {
      if (!String(error.message).includes("no challenge was received")) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the relay's NIP-42 challenge");
      }
      await sleep(50);
    }
  }
}

try {
  await authenticate();
  console.log("Authenticated over NIP-42.");
} catch (error) {
  relay.close();
  fail(`NIP-42 auth failed: ${error.message}`);
}

function queryOnce(filter, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const events = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.close();
      resolve(events);
    };
    const timer = setTimeout(finish, timeoutMs);
    const sub = relay.subscribe([filter], {
      onevent: (event) => events.push(event),
      oneose: finish,
      onclose: finish,
    });
  });
}

const tagValue = (event, name) =>
  event.tags.find((tag) => tag[0] === name)?.[1];

// ----------------------------------------------------------------- profile ---

await relay.publish(
  finalizeEvent(
    {
      kind: KIND_PROFILE,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({
        name: "wasp-tweet-dashboard",
        display_name: "Wasp Tweet Dashboard",
        about: "Daily X/Twitter stats for the Wasp team, posted by the dashboard app.",
      }),
      tags: [],
    },
    secretKey,
  ),
);
console.log("Published the bot's profile.");

// ----------------------------------------------------------------- channel ---

/** Channels are discovered through relay-signed kind:39000 metadata events. */
async function findChannel() {
  const groups = await queryOnce({ kinds: [KIND_GROUP_METADATA] });
  const match = groups.find((event) => tagValue(event, "name") === CHANNEL_NAME);
  return match ? tagValue(match, "d") : null;
}

let channelId = await findChannel();
if (channelId) {
  console.log(`Channel "${CHANNEL_NAME}" already exists: ${channelId}`);
} else {
  console.log(`Creating channel "${CHANNEL_NAME}" …`);
  await relay.publish(
    finalizeEvent(
      {
        kind: KIND_CREATE_GROUP,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["name", CHANNEL_NAME],
          ["visibility", CHANNEL_VISIBILITY],
        ],
      },
      secretKey,
    ),
  );

  // The relay assigns the UUID and emits kind:39000 asynchronously, so poll
  // discovery rather than assuming it's queryable the instant publish returns.
  for (let attempt = 0; attempt < 10 && !channelId; attempt++) {
    await sleep(1_000);
    channelId = await findChannel();
  }
  if (!channelId) {
    relay.close();
    fail(
      "the channel was created but its kind:39000 metadata never appeared.\n" +
        "  Re-run this script — it will find and reuse the existing channel.",
    );
  }
  console.log(`  created: ${channelId}`);
}

relay.close();

// ------------------------------------------------------------------- output ---

console.log("\n─────────────────────────────────────────────");
console.log("Add these to .env.server:\n");
if (!existingKey) {
  console.log(`BUZZ_NOSTR_SECRET_KEY=${bytesToHex(secretKey)}`);
}
console.log(`BUZZ_STATS_CHANNEL_ID=${channelId}`);
if (process.env.BUZZ_RELAY_URL) {
  console.log(`BUZZ_RELAY_URL=${RELAY_URL}`);
}
console.log("\n─────────────────────────────────────────────");
if (!existingKey) {
  console.log("The secret key is the bot's identity — it is printed once and not stored.");
}
