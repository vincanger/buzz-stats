import { HttpError } from "wasp/server";
import type { SyncNow } from "wasp/server/operations";
import { runRelaySync, type SyncSummary } from "./syncRelay";

/** Manual "sync now" from the dashboard, so users don't wait for the cron. */
export const syncNow: SyncNow<void, SyncSummary> = async (_args, context) => {
  if (!context.user) throw new HttpError(401);
  return runRelaySync(context.entities);
};
