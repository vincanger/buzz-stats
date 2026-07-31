import type { Event } from "nostr-tools/pure";
import type { SyncBuzzRelay } from "wasp/server/jobs";
import {
  readAgentPubkeyOverrides,
  readRelayBotConfig,
  SYNCED_KINDS,
} from "../relay/config";
import { queryOnce, withBuzzRelay } from "../relay/relay";

/**
 * Re-fetch a little history behind the cursor each run: relay clocks and
 * delivery order aren't strictly monotonic, and upserts make overlap free.
 */
const CURSOR_OVERLAP_SECONDS = 5 * 60;
/** First sync backfills this much history. */
const BACKFILL_DAYS = 90;
/** Relay page size per query; loop until a page comes back short. */
const PAGE_LIMIT = 500;

export type SyncSummary = {
  eventsFetched: number;
  eventsStored: number;
  membersUpdated: number;
  skipped: boolean;
};

type Entities = Parameters<SyncBuzzRelay<{}, SyncSummary>>[1]["entities"];

export const syncBuzzRelay: SyncBuzzRelay<{}, SyncSummary> = async (
  _args,
  context,
) => runRelaySync(context.entities);

export async function runRelaySync(entities: Entities): Promise<SyncSummary> {
  const config = readRelayBotConfig();
  if (!config) {
    return { eventsFetched: 0, eventsStored: 0, membersUpdated: 0, skipped: true };
  }

  const cursor = await entities.SyncCursor.findFirst();
  const since = cursor?.lastSeenAt
    ? Math.floor(cursor.lastSeenAt.getTime() / 1000) - CURSOR_OVERLAP_SECONDS
    : Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 24 * 60 * 60;

  const events = await withBuzzRelay(config, async (relay) => {
    const collected: Event[] = [];
    let pageSince = since;
    for (;;) {
      const page = await queryOnce(relay, {
        kinds: SYNCED_KINDS,
        since: pageSince,
        limit: PAGE_LIMIT,
      });
      collected.push(...page);
      if (page.length < PAGE_LIMIT) break;
      // Advance past this page. Equal-timestamp events on the boundary are
      // re-fetched and deduped by the upsert.
      pageSince = Math.max(...page.map((e) => e.created_at));
    }
    return collected;
  });

  let stored = 0;
  let newestSeconds = cursor?.lastSeenAt
    ? Math.floor(cursor.lastSeenAt.getTime() / 1000)
    : 0;
  for (const event of events) {
    const channelId = event.tags.find((t) => t[0] === "h")?.[1] ?? null;
    const data = {
      kind: event.kind,
      pubkey: event.pubkey.toLowerCase(),
      createdAt: new Date(event.created_at * 1000),
      channelId,
      content: event.content,
      tags: JSON.stringify(event.tags),
    };
    await entities.RelayEvent.upsert({
      where: { id: event.id },
      create: { id: event.id, ...data },
      update: data,
    });
    stored++;
    newestSeconds = Math.max(newestSeconds, event.created_at);
  }

  const membersUpdated = await updateMembers(entities, events);

  if (newestSeconds > 0) {
    const lastSeenAt = new Date(newestSeconds * 1000);
    if (cursor) {
      await entities.SyncCursor.update({
        where: { id: cursor.id },
        data: { lastSeenAt },
      });
    } else {
      await entities.SyncCursor.create({ data: { lastSeenAt } });
    }
  }

  const summary = {
    eventsFetched: events.length,
    eventsStored: stored,
    membersUpdated,
    skipped: false,
  };
  console.log("[buzz-sync]", JSON.stringify(summary));
  return summary;
}

/**
 * Members come from three signals: kind-0 profiles (name/picture), the
 * relay's kind-13534 roster (roles; `Bot` marks agents), and the
 * AGENT_PUBKEYS env override. Everyone who authored a synced event gets at
 * least a bare row so leaderboards can render pubkeys before profiles land.
 */
async function updateMembers(
  entities: Entities,
  events: Event[],
): Promise<number> {
  const agentOverrides = readAgentPubkeyOverrides();
  const updates = new Map<
    string,
    { name?: string; picture?: string; role?: string; isAgent?: boolean }
  >();

  const noteMember = (pubkey: string) => {
    const key = pubkey.toLowerCase();
    if (!updates.has(key)) updates.set(key, {});
    return updates.get(key)!;
  };

  for (const event of events) {
    noteMember(event.pubkey);

    if (event.kind === 0) {
      try {
        const profile = JSON.parse(event.content) as {
          name?: string;
          display_name?: string;
          picture?: string;
        };
        const entry = noteMember(event.pubkey);
        entry.name = profile.display_name || profile.name || entry.name;
        entry.picture = profile.picture ?? entry.picture;
      } catch {
        // Malformed profile — keep the bare member row.
      }
    }

    if (event.kind === 13534) {
      // Buzz roster tags (observed on the wire): ["member", <pubkey>, <role>]
      // with roles like owner/admin/member/guest/bot.
      for (const tag of event.tags) {
        if (tag[0] !== "member" || !/^[0-9a-f]{64}$/i.test(tag[1] ?? "")) {
          continue;
        }
        const entry = noteMember(tag[1]);
        const role = tag[2]?.toLowerCase();
        if (role) {
          entry.role = role;
          if (role === "bot") entry.isAgent = true;
        }
      }
    }
  }

  let updated = 0;
  for (const [pubkey, entry] of updates) {
    const isAgent = entry.isAgent || agentOverrides.has(pubkey) || undefined;
    await entities.Member.upsert({
      where: { pubkey },
      create: {
        pubkey,
        name: entry.name,
        picture: entry.picture,
        role: entry.role,
        isAgent: isAgent ?? false,
      },
      update: {
        ...(entry.name !== undefined && { name: entry.name }),
        ...(entry.picture !== undefined && { picture: entry.picture }),
        ...(entry.role !== undefined && { role: entry.role }),
        ...(isAgent !== undefined && { isAgent }),
      },
    });
    updated++;
  }
  return updated;
}
