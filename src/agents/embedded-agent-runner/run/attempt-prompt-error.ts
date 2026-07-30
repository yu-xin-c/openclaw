/** Classifies prompt failures and performs yield or mid-turn recovery. */
import type { AgentSession } from "../../sessions/index.js";
import { waitForAttemptHandoffAbortSettle } from "./attempt-handoff.js";
import { isSessionStatusSelfCompactAbortError } from "./attempt-self-compaction.js";
import { normalizeCompactionRecoveryTranscriptTail } from "./attempt-transcript-helpers.js";
import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import {
  isSessionsYieldAbortError,
  persistSessionsYieldContextMessage,
  stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle,
} from "./attempt.sessions-yield.js";
import { isMidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./midturn-precheck.js";
import { PREEMPTIVE_OVERFLOW_ERROR_TEXT } from "./preemptive-compaction.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PromptErrorAttempt = Pick<EmbeddedRunAttemptParams, "runId" | "sessionId">;
type PromptErrorSessionLockController = Pick<
  EmbeddedAttemptSessionLockController,
  "releaseHeldLockForAbort"
>;
type WithOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

type EmbeddedAttemptPromptErrorOutcome =
  | { kind: "handled" }
  | {
      kind: "self_compaction";
      preflightRecovery: {
        route: "compact_only";
        source: "mid-turn";
        handled: false;
      };
      promptError: Error;
    }
  | {
      kind: "prompt_failure";
      error: unknown;
      source: "prompt";
    };

export async function handleEmbeddedAttemptPromptError(input: {
  activeSession: AgentSession;
  attempt: PromptErrorAttempt;
  error: unknown;
  handleMidTurnPrecheckRequest: (request: MidTurnPrecheckRequest) => void;
  markSelfCompactionAborted: () => void;
  markYieldAborted: () => void;
  releaseLeasedSteering: (error?: unknown) => void;
  sessionManager: Parameters<typeof normalizeCompactionRecoveryTranscriptTail>[0]["sessionManager"];
  sessionLockController: PromptErrorSessionLockController;
  selfCompactionAbortSettled: Promise<void> | null;
  selfCompactionRequested: boolean;
  withOwnedSessionWriteLock: WithOwnedSessionWriteLock;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
}): Promise<EmbeddedAttemptPromptErrorOutcome> {
  input.releaseLeasedSteering(input.error);
  const yieldAborted = input.yieldDetected && isSessionsYieldAbortError(input.error);
  if (yieldAborted) {
    // Publish terminal state before fallible recovery so outer cleanup still recognizes the yield.
    input.markYieldAborted();
    await waitForSessionsYieldAbortSettle({
      settlePromise: input.yieldAbortSettled,
      runId: input.attempt.runId,
      sessionId: input.attempt.sessionId,
    });
    await input.sessionLockController.releaseHeldLockForAbort({ terminal: false });
    await input.withOwnedSessionWriteLock(async () => {
      stripSessionsYieldArtifacts(input.activeSession);
      if (input.yieldMessage) {
        await persistSessionsYieldContextMessage(input.activeSession, input.yieldMessage);
      }
    });
    return { kind: "handled" };
  }

  const selfCompactionAborted =
    input.selfCompactionRequested && isSessionStatusSelfCompactAbortError(input.error);
  if (selfCompactionAborted) {
    // Publish the handoff before fallible teardown, then leave a continuable
    // transcript tail for the outer compact-and-retry owner.
    input.markSelfCompactionAborted();
    await waitForAttemptHandoffAbortSettle({
      settlePromise: input.selfCompactionAbortSettled,
      runId: input.attempt.runId,
      sessionId: input.attempt.sessionId,
      label: "session_status compact",
    });
    await input.sessionLockController.releaseHeldLockForAbort({ terminal: false });
    await input.withOwnedSessionWriteLock(() => {
      normalizeCompactionRecoveryTranscriptTail({
        activeSession: input.activeSession,
        sessionManager: input.sessionManager,
      });
    });
    return {
      kind: "self_compaction",
      preflightRecovery: {
        route: "compact_only",
        source: "mid-turn",
        handled: false,
      },
      promptError: new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT),
    };
  }

  if (isMidTurnPrecheckSignal(input.error)) {
    const request = input.error.request;
    await input.withOwnedSessionWriteLock(() => {
      input.handleMidTurnPrecheckRequest(request);
    });
    return { kind: "handled" };
  }

  return {
    kind: "prompt_failure",
    error: input.error,
    source: "prompt",
  };
}
