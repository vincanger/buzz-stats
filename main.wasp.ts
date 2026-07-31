import { action, api, app, job, page, query, route } from "@wasp.sh/spec";
import { MainPage } from "./src/MainPage" with { type: "ref" };
import { LoginPage } from "./src/auth/LoginPage" with { type: "ref" };
import {
  getNostrChallenge,
  verifyNostrLogin,
} from "./src/auth/nostr/serverApi" with { type: "ref" };
import {
  getMemberLeaderboard,
  getMyStats,
  getOverview,
} from "./src/stats/queries" with { type: "ref" };
import { syncNow } from "./src/sync/actions" with { type: "ref" };
import { syncBuzzRelay } from "./src/sync/syncRelay" with { type: "ref" };

const STATS_ENTITIES = ["RelayEvent", "Member", "SyncCursor"];

export default app({
  name: "buzzStats",
  title: "Buzz Stats",
  wasp: { version: "^0.24.0" },
  head: ["<link rel='icon' href='/favicon.ico' />"],
  // Auth is backed by the `username` provider purely as a storage mechanism:
  // the "username" is the user's nostr pubkey and the password is random and
  // never disclosed, so the only way in is the nostr challenge-signature flow
  // under /auth/nostr/*.
  auth: {
    userEntity: "User",
    methods: {
      usernameAndPassword: {},
    },
    onAuthFailedRedirectTo: "/login",
  },
  spec: [
    route("RootRoute", "/", page(MainPage, { authRequired: true })),
    route("LoginRoute", "/login", page(LoginPage)),
    api("GET", "/auth/nostr/challenge", getNostrChallenge, {
      entities: ["NostrChallenge"],
      auth: false,
    }),
    api("POST", "/auth/nostr/verify", verifyNostrLogin, {
      entities: ["NostrChallenge", "User"],
      auth: false,
    }),
    job(syncBuzzRelay, {
      executor: "PgBoss",
      schedule: { cron: "*/10 * * * *" },
      entities: STATS_ENTITIES,
    }),
    action(syncNow, { entities: STATS_ENTITIES }),
    query(getOverview, { entities: STATS_ENTITIES }),
    query(getMemberLeaderboard, { entities: ["RelayEvent", "Member"] }),
    query(getMyStats, { entities: ["RelayEvent", "Member"] }),
  ],
});
