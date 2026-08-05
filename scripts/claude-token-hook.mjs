/**
 * Claude Code Stop hook: publish this session's token usage to a Buzz channel
 * as a nostr event, signed with the agent's own key — so buzz-stats can chart
 * tokens per agent.
 *
 * Install location: ~/.buzz/.claude/settings.json 
 *
 *   {
 *     "hooks": {
 *       "Stop": [{ "hooks": [{
 *         "type": "command",
 *         "command": "node /path/to/buzz-stats/scripts/claude-token-hook.mjs"
 *       }] }]
 *     }
 *   }
 *
 * Env (the agent's buzz-acp environment already has the key):
 *   BUZZ_PRIVATE_KEY          agent's nostr secret key (hex). Falls back to
 *                             BUZZ_NOSTR_SECRET_KEY.
 *   BUZZ_RELAY_URL            defaults to wss://wasp.communities.buzz.xyz
 *   BUZZ_METRICS_CHANNEL_ID   channel UUID to post into, or
 *   BUZZ_METRICS_CHANNEL      channel name to resolve (default "agent-metrics")
 *
 * The agent must be a member of the channel (add it in the Buzz client).
 * Every failure exits 0 — a metrics hiccup must never break the agent.
 */

import { readFile, writeFile } from "node:fs/promises";
import { finalizeEvent } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { hexToBytes } from "nostr-tools/utils";

const RELAY_URL =
  process.env.BUZZ_RELAY_URL ?? "wss://wasp.communities.buzz.xyz";
const CHANNEL_NAME = process.env.BUZZ_METRICS_CHANNEL ?? "agent-metrics";
const KIND_STREAM_MESSAGE = 9;
const KIND_GROUP_METADATA = 39000;
const USAGE_TOPIC = "token-usage";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bail(message) {
  // stderr only shows up in Claude Code debug output; exit 0 keeps the agent
  // running no matter what went wrong here.
  console.error(`[buzz-token-hook] ${message}`);
  process.exit(0);
}

// ----------------------------------------------------------------- input ---

const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data));
  setTimeout(() => resolve(data), 3_000);
});

let hookInput;
try {
  hookInput = JSON.parse(stdin);
} catch {
  bail("could not parse hook JSON from stdin");
}
const { transcript_path: transcriptPath, session_id: sessionId } = hookInput;
if (!transcriptPath) bail("no transcript_path in hook input");

const secretKeyHex =
  process.env.BUZZ_PRIVATE_KEY ?? process.env.BUZZ_NOSTR_SECRET_KEY;
if (!secretKeyHex || !/^[0-9a-f]{64}$/i.test(secretKeyHex)) {
  bail("BUZZ_PRIVATE_KEY (agent nostr key, 64 hex chars) is not set");
}
const secretKey = hexToBytes(secretKeyHex);

// ------------------------------------------------------------ usage delta ---

let transcript;
try {
  transcript = await readFile(transcriptPath, "utf8");
} catch (error) {
  bail(`cannot read transcript: ${error.message}`);
}

// Dedupe by message id (a message can be re-appended as it's finalized) —
// keep the last occurrence, which carries the final usage numbers.
const usageByMessageId = new Map();
let model = null;
for (const line of transcript.split("\n")) {
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  const message = entry?.message;
  if (entry?.type !== "assistant" || !message?.usage) continue;
  usageByMessageId.set(message.id ?? `line-${usageByMessageId.size}`, {
    input: message.usage.input_tokens ?? 0,
    output: message.usage.output_tokens ?? 0,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    cacheCreation: message.usage.cache_creation_input_tokens ?? 0,
  });
  model = message.model ?? model;
}

const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
for (const usage of usageByMessageId.values()) {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheCreation += usage.cacheCreation;
}

// The Stop hook fires once per turn; report only what's new since the last
// successful publish for this transcript.
const statePath = `${transcriptPath}.buzz-tokens.json`;
let state = { reported: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } };
try {
  state = { ...state, ...JSON.parse(await readFile(statePath, "utf8")) };
} catch {
  // First run for this transcript.
}

const delta = Object.fromEntries(
  Object.entries(totals).map(([k, v]) => [
    k,
    Math.max(0, v - (state.reported[k] ?? 0)),
  ]),
);
if (Object.values(delta).every((v) => v === 0)) {
  process.exit(0);
}

// ---------------------------------------------------------------- publish ---

const relay = new Relay(RELAY_URL);
try {
  await relay.connect({ timeout: 10_000 });

  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await relay.auth((template) =>
        Promise.resolve(finalizeEvent(template, secretKey)),
      );
      break;
    } catch (error) {
      if (!String(error.message).includes("no challenge was received")) {
        throw new Error(`NIP-42 auth rejected: ${error.message}`);
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for NIP-42 challenge");
      }
      await sleep(50);
    }
  }

  let channelId = process.env.BUZZ_METRICS_CHANNEL_ID ?? state.channelId;
  if (!channelId) {
    channelId = await new Promise((resolve) => {
      const events = [];
      const timer = setTimeout(() => {
        sub.close();
        resolve(null);
      }, 8_000);
      const sub = relay.subscribe([{ kinds: [KIND_GROUP_METADATA] }], {
        onevent: (event) => events.push(event),
        oneose: () => {
          clearTimeout(timer);
          sub.close();
          const tag = (e, n) => e.tags.find((t) => t[0] === n)?.[1];
          const match = events.find((e) => tag(e, "name") === CHANNEL_NAME);
          resolve(match ? tag(match, "d") : null);
        },
      });
    });
    if (!channelId) {
      throw new Error(
        `channel "${CHANNEL_NAME}" not found — create it in Buzz and add this agent`,
      );
    }
  }

  await relay.publish(
    finalizeEvent(
      {
        kind: KIND_STREAM_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["h", channelId],
          ["t", USAGE_TOPIC],
        ],
        content: JSON.stringify({
          v: 1,
          session: sessionId ?? null,
          model,
          ...delta,
        }),
      },
      secretKey,
    ),
  );

  await writeFile(
    statePath,
    JSON.stringify({ reported: totals, channelId }),
    "utf8",
  );
} catch (error) {
  bail(`publish failed: ${error.message}`);
} finally {
  relay.close();
}
