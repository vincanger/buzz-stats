/**
 * Create the agent-metrics channel as the stats bot and add agent pubkeys to
 * it — no Buzz client needed. The bot creates the channel itself (creator =
 * owner), so it can both read the metrics and admit the agents.
 *
 *   node --env-file=.env.server scripts/setup-metrics-channel.mjs <agent-pubkey-or-npub>...
 *
 * Safe to re-run: an existing channel is reused, and re-adding a member is a
 * no-op. Reads BUZZ_NOSTR_SECRET_KEY, optionally BUZZ_RELAY_URL and
 * BUZZ_METRICS_CHANNEL (name, default "agent-metrics").
 */

import { finalizeEvent } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { hexToBytes } from "nostr-tools/utils";
import { nip19 } from "nostr-tools";

const RELAY_URL =
  process.env.BUZZ_RELAY_URL ?? "wss://wasp.communities.buzz.xyz";
const CHANNEL_NAME = process.env.BUZZ_METRICS_CHANNEL ?? "agent-metrics";
const SECRET_KEY = process.env.BUZZ_NOSTR_SECRET_KEY;

const KIND_CREATE_GROUP = 9007;
/** NIP-29 put-user: adds/updates a member, sent by a group admin. */
const KIND_PUT_USER = 9000;
const KIND_GROUP_METADATA = 39000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

if (!SECRET_KEY || !/^[0-9a-f]{64}$/i.test(SECRET_KEY)) {
  fail("BUZZ_NOSTR_SECRET_KEY must be set to 64 hex characters.");
}
const secretKey = hexToBytes(SECRET_KEY);

const agentPubkeys = process.argv.slice(2).map((arg) => {
  if (/^[0-9a-f]{64}$/i.test(arg)) return arg.toLowerCase();
  try {
    const decoded = nip19.decode(arg);
    if (decoded.type === "npub") return decoded.data;
  } catch {
    // fall through to fail below
  }
  fail(`"${arg}" is neither a hex pubkey nor an npub.`);
});

const relay = new Relay(RELAY_URL);
await relay.connect({ timeout: 15_000 });

const deadline = Date.now() + 10_000;
for (;;) {
  try {
    await relay.auth((template) =>
      Promise.resolve(finalizeEvent(template, secretKey)),
    );
    break;
  } catch (error) {
    if (!String(error.message).includes("no challenge was received")) {
      relay.close();
      fail(`NIP-42 auth failed: ${error.message}`);
    }
    if (Date.now() >= deadline) {
      relay.close();
      fail("timed out waiting for the relay's NIP-42 challenge");
    }
    await sleep(50);
  }
}
console.log("Authenticated as the stats bot.");

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

const tagValue = (event, name) => event.tags.find((t) => t[0] === name)?.[1];

async function findChannel() {
  const groups = await queryOnce({ kinds: [KIND_GROUP_METADATA] });
  const match = groups.find((e) => tagValue(e, "name") === CHANNEL_NAME);
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
          ["about", "Agent token-usage reports, published by Claude Code hooks"],
          ["visibility", "open"],
        ],
      },
      secretKey,
    ),
  );
  // The relay assigns the UUID and emits kind:39000 asynchronously.
  for (let attempt = 0; attempt < 10 && !channelId; attempt++) {
    await sleep(1_000);
    channelId = await findChannel();
  }
  if (!channelId) {
    relay.close();
    fail("channel created but its metadata never appeared — re-run to reuse it.");
  }
  console.log(`  created: ${channelId}`);
}

for (const pubkey of agentPubkeys) {
  try {
    await relay.publish(
      finalizeEvent(
        {
          kind: KIND_PUT_USER,
          created_at: Math.floor(Date.now() / 1000),
          content: "",
          tags: [
            ["h", channelId],
            ["p", pubkey, "member"],
          ],
        },
        secretKey,
      ),
    );
    console.log(`  added member ${pubkey.slice(0, 12)}…`);
  } catch (error) {
    console.error(
      `  ✖ could not add ${pubkey.slice(0, 12)}…: ${error.message}\n` +
        "    (the relay may not accept kind-9000 put-user — add the agent in the Buzz client instead)",
    );
  }
}

relay.close();

console.log("\n─────────────────────────────────────────────");
console.log("Optional, skips name lookup in the hook:");
console.log(`BUZZ_METRICS_CHANNEL_ID=${channelId}`);
console.log("─────────────────────────────────────────────");
