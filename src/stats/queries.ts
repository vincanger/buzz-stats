import { HttpError } from "wasp/server";
import type {
  GetMemberLeaderboard,
  GetMyStats,
  GetOverview,
} from "wasp/server/operations";
import {
  ACTIVE_WINDOW_MINUTES,
  readAgentPubkeyOverrides,
  STATS_PERIOD_DAYS,
} from "../relay/config";

/**
 * AGENT_PUBKEYS is applied at read time, not just during sync — so adding an
 * override takes effect immediately instead of waiting for that member to
 * appear in newly synced events.
 */
function isAgentMember(
  member: { pubkey: string; isAgent: boolean },
  overrides: Set<string>,
): boolean {
  return member.isAgent || overrides.has(member.pubkey);
}

/** Chat message kinds (v1 and v2 stream messages). */
const MESSAGE_KINDS = [9, 40002];
const REACTION_KIND = 7;
const FORUM_POST_KIND = 45001;
const JOB_REQUEST_KIND = 43001;
const WORKFLOW_KIND_MIN = 46001;
const WORKFLOW_KIND_MAX = 46012;

type StoredEvent = {
  kind: number;
  pubkey: string;
  createdAt: Date;
  tags: string;
  content: string;
};

function parseTags(event: StoredEvent): string[][] {
  try {
    return JSON.parse(event.tags) as string[][];
  } catch {
    return [];
  }
}

/**
 * Token-usage reports published by the Claude Code Stop hook
 * (scripts/claude-token-hook.mjs): kind-9 events tagged ["t","token-usage"]
 * with a JSON body. They're metrics, not conversation — excluded from all
 * message counts.
 */
function isTokenUsageEvent(event: StoredEvent): boolean {
  return (
    MESSAGE_KINDS.includes(event.kind) &&
    parseTags(event).some((t) => t[0] === "t" && t[1] === "token-usage")
  );
}

/** New tokens the agent burned (input + output; cache reads excluded). */
function tokensOf(event: StoredEvent): number {
  try {
    const body = JSON.parse(event.content) as {
      input?: number;
      output?: number;
    };
    return (body.input ?? 0) + (body.output ?? 0);
  } catch {
    return 0;
  }
}

function isChatMessage(event: StoredEvent): boolean {
  return MESSAGE_KINDS.includes(event.kind) && !isTokenUsageEvent(event);
}

function mentionedPubkeys(event: StoredEvent): string[] {
  return parseTags(event)
    .filter((t) => t[0] === "p" && /^[0-9a-f]{64}$/i.test(t[1] ?? ""))
    .map((t) => t[1].toLowerCase());
}

/**
 * Buzz doesn't encode ACP agent-task state in events, so "tasks completed" is
 * a documented heuristic: workflow-run events whose tags or content mention a
 * completed status.
 */
function isCompletedWorkflowEvent(event: StoredEvent): boolean {
  if (event.kind < WORKFLOW_KIND_MIN || event.kind > WORKFLOW_KIND_MAX) {
    return false;
  }
  const haystack = (
    parseTags(event).flat().join(" ") +
    " " +
    event.content.slice(0, 2000)
  ).toLowerCase();
  return haystack.includes("completed");
}

async function loadPeriodEvents(
  relayEvent: { findMany: Function },
  periodStart: Date,
): Promise<StoredEvent[]> {
  return relayEvent.findMany({
    where: { createdAt: { gte: periodStart } },
    select: {
      kind: true,
      pubkey: true,
      createdAt: true,
      tags: true,
      content: true,
    },
  }) as Promise<StoredEvent[]>;
}

export type Overview = {
  periodDays: number;
  memberCount: number;
  agentCount: number;
  messagesInPeriod: number;
  tasksCompletedInPeriod: number;
  jobRequestsInPeriod: number;
  tokensInPeriod: number;
  activeAgents: { pubkey: string; name: string | null }[];
  lastSyncedAt: string | null;
};

export const getOverview: GetOverview<void, Overview> = async (
  _args,
  context,
) => {
  if (!context.user) throw new HttpError(401);
  const { RelayEvent, Member, SyncCursor } = context.entities;

  const periodStart = new Date(
    Date.now() - STATS_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );
  const activeSince = new Date(Date.now() - ACTIVE_WINDOW_MINUTES * 60 * 1000);

  const [members, events, cursor, recentAgentEvents] = await Promise.all([
    Member.findMany(),
    loadPeriodEvents(RelayEvent, periodStart),
    SyncCursor.findFirst(),
    RelayEvent.findMany({
      where: { createdAt: { gte: activeSince } },
      select: { pubkey: true },
      distinct: ["pubkey"],
    }),
  ]);

  const overrides = readAgentPubkeyOverrides();
  const agentPubkeys = new Set(
    members.filter((m) => isAgentMember(m, overrides)).map((m) => m.pubkey),
  );
  const nameByPubkey = new Map(members.map((m) => [m.pubkey, m.name]));

  const activeAgents = recentAgentEvents
    .filter((e) => agentPubkeys.has(e.pubkey))
    .map((e) => ({
      pubkey: e.pubkey,
      name: nameByPubkey.get(e.pubkey) ?? null,
    }));

  return {
    periodDays: STATS_PERIOD_DAYS,
    memberCount: members.length,
    agentCount: agentPubkeys.size,
    messagesInPeriod: events.filter(isChatMessage).length,
    tasksCompletedInPeriod: events.filter(isCompletedWorkflowEvent).length,
    jobRequestsInPeriod: events.filter((e) => e.kind === JOB_REQUEST_KIND)
      .length,
    tokensInPeriod: events
      .filter(isTokenUsageEvent)
      .reduce((sum, e) => sum + tokensOf(e), 0),
    activeAgents,
    lastSyncedAt: cursor?.lastSeenAt?.toISOString() ?? null,
  };
};

export type LeaderboardRow = {
  pubkey: string;
  name: string | null;
  isAgent: boolean;
  role: string | null;
  messages: number;
  reactionsGiven: number;
  mentionsReceived: number;
  threadsStarted: number;
  tokensUsed: number;
};

export const getMemberLeaderboard: GetMemberLeaderboard<
  void,
  LeaderboardRow[]
> = async (_args, context) => {
  if (!context.user) throw new HttpError(401);
  const { RelayEvent, Member } = context.entities;

  const periodStart = new Date(
    Date.now() - STATS_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );
  const [members, events] = await Promise.all([
    Member.findMany(),
    loadPeriodEvents(RelayEvent, periodStart),
  ]);

  const overrides = readAgentPubkeyOverrides();
  const rows = new Map<string, LeaderboardRow>();
  const rowFor = (pubkey: string): LeaderboardRow => {
    if (!rows.has(pubkey)) {
      const member = members.find((m) => m.pubkey === pubkey);
      rows.set(pubkey, {
        pubkey,
        name: member?.name ?? null,
        isAgent: member ? isAgentMember(member, overrides) : false,
        role: member?.role ?? null,
        messages: 0,
        reactionsGiven: 0,
        mentionsReceived: 0,
        threadsStarted: 0,
        tokensUsed: 0,
      });
    }
    return rows.get(pubkey)!;
  };

  for (const event of events) {
    if (isTokenUsageEvent(event)) {
      rowFor(event.pubkey).tokensUsed += tokensOf(event);
    } else if (MESSAGE_KINDS.includes(event.kind)) {
      rowFor(event.pubkey).messages++;
      for (const mentioned of mentionedPubkeys(event)) {
        rowFor(mentioned).mentionsReceived++;
      }
    } else if (event.kind === REACTION_KIND) {
      rowFor(event.pubkey).reactionsGiven++;
    } else if (event.kind === FORUM_POST_KIND) {
      rowFor(event.pubkey).threadsStarted++;
    }
  }

  return [...rows.values()].sort((a, b) => b.messages - a.messages);
};

export type MyStats = {
  pubkey: string;
  messagesInPeriod: number;
  threadsStarted: number;
  invokedAgents: { pubkey: string; name: string | null; mentions: number }[];
};

export const getMyStats: GetMyStats<void, MyStats> = async (
  _args,
  context,
) => {
  if (!context.user) throw new HttpError(401);
  const pubkey = context.user.pubkey;
  const { RelayEvent, Member } = context.entities;

  const periodStart = new Date(
    Date.now() - STATS_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );
  const overrides = readAgentPubkeyOverrides();
  const [allMembers, myEvents] = await Promise.all([
    Member.findMany(),
    RelayEvent.findMany({
      where: { pubkey, createdAt: { gte: periodStart } },
      select: {
        kind: true,
        pubkey: true,
        createdAt: true,
        tags: true,
        content: true,
      },
    }) as Promise<StoredEvent[]>,
  ]);

  const agentByPubkey = new Map(
    allMembers
      .filter((m) => isAgentMember(m, overrides))
      .map((m) => [m.pubkey, m]),
  );
  const mentionCounts = new Map<string, number>();
  for (const event of myEvents) {
    if (!isChatMessage(event)) continue;
    for (const mentioned of mentionedPubkeys(event)) {
      if (!agentByPubkey.has(mentioned)) continue;
      mentionCounts.set(mentioned, (mentionCounts.get(mentioned) ?? 0) + 1);
    }
  }

  return {
    pubkey,
    messagesInPeriod: myEvents.filter(isChatMessage).length,
    threadsStarted: myEvents.filter((e) => e.kind === FORUM_POST_KIND).length,
    invokedAgents: [...mentionCounts.entries()]
      .map(([agentPubkey, mentions]) => ({
        pubkey: agentPubkey,
        name: agentByPubkey.get(agentPubkey)?.name ?? null,
        mentions,
      }))
      .sort((a, b) => b.mentions - a.mentions),
  };
};
