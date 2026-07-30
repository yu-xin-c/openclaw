import { createAttemptHandoffAbortReason, isAttemptHandoffAbortError } from "./attempt-handoff.js";

export const SESSION_STATUS_SELF_COMPACT_ABORT_REASON =
  createAttemptHandoffAbortReason("session_status_compact");

export function isSessionStatusSelfCompactAbortError(error: unknown): boolean {
  return isAttemptHandoffAbortError(error, "session_status_compact");
}
