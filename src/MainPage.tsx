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
    <main style={{ maxWidth: "56rem", margin: "2rem auto", padding: "0 1rem" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h1>Buzz Stats</h1>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <code style={{ fontSize: "0.8rem" }}>{shortKey(user.pubkey)}</code>
          <button onClick={() => void onSyncNow()}>Sync now</button>
          <button onClick={logout}>Log out</button>
        </div>
      </header>
      {syncState && <p>{syncState}</p>}

      {overview.data && (
        <>
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
              gap: "1rem",
              margin: "1.5rem 0",
            }}
          >
            <StatCard label="Members" value={overview.data.memberCount} />
            <StatCard label="Agents" value={overview.data.agentCount} />
            <StatCard
              label={`Messages (${overview.data.periodDays}d)`}
              value={overview.data.messagesInPeriod}
            />
            <StatCard
              label={`Tasks completed (${overview.data.periodDays}d)`}
              value={overview.data.tasksCompletedInPeriod}
            />
            <StatCard
              label={`Job requests (${overview.data.periodDays}d)`}
              value={overview.data.jobRequestsInPeriod}
            />
            <StatCard
              label={`Agent tokens (${overview.data.periodDays}d)`}
              value={overview.data.tokensInPeriod}
            />
          </section>
          <p style={{ fontSize: "0.85rem", color: "#666" }}>
            {overview.data.activeAgents.length > 0
              ? `Active agents right now: ${overview.data.activeAgents
                  .map((a) => a.name ?? shortKey(a.pubkey))
                  .join(", ")}`
              : "No agents active in the last 15 minutes."}
            {overview.data.lastSyncedAt &&
              ` · Last synced event: ${new Date(overview.data.lastSyncedAt).toLocaleString()}`}
          </p>
        </>
      )}
      {overview.error && (
        <p role="alert">Failed to load overview: {overview.error.message}</p>
      )}

      {myStats.data && (
        <section>
          <h2>You (last {overview.data?.periodDays ?? 7} days)</h2>
          <p>
            {myStats.data.messagesInPeriod} messages ·{" "}
            {myStats.data.threadsStarted} threads started
            {myStats.data.invokedAgents.length > 0 &&
              ` · most-invoked agent: ${
                myStats.data.invokedAgents[0].name ??
                shortKey(myStats.data.invokedAgents[0].pubkey)
              } (${myStats.data.invokedAgents[0].mentions}×)`}
          </p>
        </section>
      )}

      {leaderboard.data && (
        <section>
          <h2>Member activity (last {overview.data?.periodDays ?? 7} days)</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th>Member</th>
                  <th>Type</th>
                  <th>Messages</th>
                  <th>Reactions</th>
                  <th>Mentions received</th>
                  <th>Threads started</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.data.map((row) => (
                  <tr key={row.pubkey}>
                    <td>{row.name ?? shortKey(row.pubkey)}</td>
                    <td>{row.isAgent ? "agent" : (row.role ?? "member")}</td>
                    <td>{row.messages}</td>
                    <td>{row.reactionsGiven}</td>
                    <td>{row.mentionsReceived}</td>
                    <td>{row.threadsStarted}</td>
                    <td>{row.tokensUsed > 0 ? row.tokensUsed.toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {leaderboard.data.length === 0 && (
            <p>
              No relay activity synced yet — hit “Sync now” (needs the bot key
              in .env.server).
            </p>
          )}
        </section>
      )}
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: "0.5rem",
        padding: "0.75rem 1rem",
      }}
    >
      <div style={{ fontSize: "1.75rem", fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: "0.85rem", color: "#666" }}>{label}</div>
    </div>
  );
}
