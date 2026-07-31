# Buzz Stats

A [Wasp](https://wasp.sh) app demonstrating **Sign in with Nostr** — with a
dashboard of stats for a [Buzz](https://github.com/block/buzz) relay: member
activity, agent tasks, who invokes which agent, and per-agent token usage.

## How it works

- **Login**: the [nostr-login](https://github.com/nostrband/nostr-login) widget
  (browser extension / NIP-46 remote signer / one-click new identity) signs a
  one-time server challenge into a kind-22242 event; the server verifies the
  Schnorr signature and creates a Wasp session keyed on the pubkey. See
  `src/auth/`.
- **Stats**: the app's own enrolled bot key reads the relay over NIP-42; a
  cron job (and a "Sync now" button) ingests events into Postgres, and the
  dashboard aggregates them. Users only ever sign a login challenge — they
  never hand the app relay credentials. See `src/sync/` and `src/stats/`.
- **Token usage**: Buzz events don't carry token counts, so agents self-report
  via a Claude Code Stop hook (below).

## Setup

```bash
wasp start db        # dockerized dev Postgres
wasp db migrate-dev
wasp start
```

Enroll the bot on your Buzz relay (needs an invite code from the Buzz client):

```bash
BUZZ_INVITE_CODE=<code> node --env-file=.env.server scripts/buzz-enroll.mjs
```

`.env.server`:

```
BUZZ_NOSTR_SECRET_KEY=<hex from enrollment>
BUZZ_RELAY_URL=wss://<your-community-relay>      # optional
AGENT_PUBKEYS=<hex,hex>  # mark members as agents until the roster labels bots
```

## Per-agent token usage (Claude Code agents)

Agents running on Claude Code can publish their token usage to the relay via a
Stop hook — signed with the agent's own nostr key, so attribution is free.

1. Create a channel for metrics in the Buzz client (default name
   `agent-metrics`) and add each agent plus the stats bot to it.
2. In each agent's Claude Code settings (`.claude/settings.json`):

   ```json
   {
     "hooks": {
       "Stop": [{ "hooks": [{
         "type": "command",
         "command": "node /path/to/buzz-stats/scripts/claude-token-hook.mjs"
       }] }]
     }
   }
   ```

3. The agent's environment needs its nostr key as `BUZZ_PRIVATE_KEY` (buzz-acp
   agents already have this) and optionally `BUZZ_METRICS_CHANNEL_ID` /
   `BUZZ_METRICS_CHANNEL`.

Each turn, the hook diffs the session transcript's token usage against what it
already reported and posts the delta as a kind-9 event tagged
`["t","token-usage"]`. The dashboard sums input+output per agent (cache reads
excluded) and keeps these events out of message counts. A failing hook never
breaks the agent — every error exits 0.
