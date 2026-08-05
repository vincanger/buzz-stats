import { useState } from "react";
import type { AuthUser } from "wasp/auth";
import { logout } from "wasp/client/auth";
import {
  getMemberLeaderboard,
  getMyStats,
  getOverview,
  syncNow,
  useQuery,
} from "wasp/client/operations";
import "./Main.css";

function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

export function MainPage({ user }: { user: AuthUser }) {
  const overview = useQuery(getOverview);
  const leaderboard = useQuery(getMemberLeaderboard);
  const myStats = useQuery(getMyStats);
  const [syncState, setSyncState] = useState<string | null>(null);

  async function onSyncNow() {
    setSyncState("Syncing…");
    try {
      const result = await syncNow();
      setSyncState(
        result.skipped
          ? "Sync skipped — relay bot key not configured (see .env.server)."
          : `Synced ${result.eventsStored} events.`,
      );
      await Promise.all([
        overview.refetch(),
        leaderboard.refetch(),
        myStats.refetch(),
      ]);
    } catch (error) {
      setSyncState(
        `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return (
    <main className="page">
      <header className="topbar">
        <span className="logo">
          Buzz <mark>Stats</mark>
        </span>
        <div className="topbar-actions">
          <code className="pubkey">{shortKey(user.pubkey)}</code>
          <button className="btn btn-ghost" onClick={() => void onSyncNow()}>
            Sync now
          </button>
          <button className="btn" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      {syncState && <p className="sync-note">{syncState}</p>}

      {overview.data && (
        <>
          <section className="cards">
            <StatCard label="Members" value={overview.data.memberCount} />
            <StatCard label="Agents" value={overview.data.agentCount} />
            <StatCard
              label={`Messages · ${overview.data.periodDays}d`}
              value={overview.data.messagesInPeriod}
            />
            <StatCard
              label={`Tasks done · ${overview.data.periodDays}d`}
              value={overview.data.tasksCompletedInPeriod}
            />
            <StatCard
              label={`Job requests · ${overview.data.periodDays}d`}
              value={overview.data.jobRequestsInPeriod}
            />
            <StatCard
              label={`Agent tokens · ${overview.data.periodDays}d`}
              value={overview.data.tokensInPeriod}
              highlight
            />
          </section>
          <p className="meta">
            {overview.data.activeAgents.length > 0 ? (
              <>
                Active now:{" "}
                {overview.data.activeAgents.map((a, i) => (
                  <span key={a.pubkey}>
                    {i > 0 && ", "}
                    <b>{a.name ?? shortKey(a.pubkey)}</b>
                  </span>
                ))}
              </>
            ) : (
              "No agents active in the last 15 minutes."
            )}
            {overview.data.lastSyncedAt &&
              ` · last synced ${new Date(overview.data.lastSyncedAt).toLocaleString()}`}
          </p>
        </>
      )}
      {overview.error && (
        <p role="alert">Failed to load overview: {overview.error.message}</p>
      )}

      {myStats.data && (
        <section>
          <h2>You — last {overview.data?.periodDays ?? 7} days</h2>
          <p className="meta">
            <b>{myStats.data.messagesInPeriod}</b> messages ·{" "}
            <b>{myStats.data.threadsStarted}</b> threads started
            {myStats.data.invokedAgents.length > 0 && (
              <>
                {" "}
                · most-invoked agent:{" "}
                <b>
                  {myStats.data.invokedAgents[0].name ??
                    shortKey(myStats.data.invokedAgents[0].pubkey)}
                </b>{" "}
                ({myStats.data.invokedAgents[0].mentions}×)
              </>
            )}
          </p>
        </section>
      )}

      {leaderboard.data && (
        <section>
          <h2>Member activity — last {overview.data?.periodDays ?? 7} days</h2>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Type</th>
                  <th className="num">Messages</th>
                  <th className="num">Reactions</th>
                  <th className="num">Mentions</th>
                  <th className="num">Threads</th>
                  <th className="num">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.data.map((row) => (
                  <tr key={row.pubkey}>
                    <td>{row.name ?? shortKey(row.pubkey)}</td>
                    <td>
                      <span
                        className={
                          row.isAgent ? "chip chip-agent" : "chip"
                        }
                      >
                        {row.isAgent ? "agent" : (row.role ?? "member")}
                      </span>
                    </td>
                    <td className="num">{row.messages}</td>
                    <td className="num">{row.reactionsGiven}</td>
                    <td className="num">{row.mentionsReceived}</td>
                    <td className="num">{row.threadsStarted}</td>
                    <td className="num">
                      {row.tokensUsed > 0 ? row.tokensUsed.toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {leaderboard.data.length === 0 && (
            <p className="empty">
              No relay activity synced yet — hit “Sync now” (needs the bot key
              in .env.server).
            </p>
          )}
        </section>
      )}
    </main>
  );
}

function StatCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className={highlight ? "card card-hi" : "card"}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value.toLocaleString()}</div>
    </div>
  );
}
