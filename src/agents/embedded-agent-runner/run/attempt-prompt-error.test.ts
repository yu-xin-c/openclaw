import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  handleMidTurnPrecheckRequest: vi.fn(),
  isMidTurnPrecheckSignal: vi.fn(() => false),
  isSessionStatusSelfCompactAbortError: vi.fn(() => false),
  isSessionsYieldAbortError: vi.fn(() => false),
  markSelfCompactionAborted: vi.fn(),
  markYieldAborted: vi.fn(),
  normalizeCompactionRecoveryTranscriptTail: vi.fn(),
  persistSessionsYieldContextMessage: vi.fn(async () => undefined),
  releaseHeldLockForAbort: vi.fn(async () => undefined),
  releaseLeasedSteering: vi.fn(),
  stripSessionsYieldArtifacts: vi.fn(),
  waitForAttemptHandoffAbortSettle: vi.fn(async () => undefined),
  waitForSessionsYieldAbortSettle: vi.fn(async () => undefined),
  withOwnedSessionWriteLock: vi.fn(async (operation: () => unknown) => await operation()),
}));

vi.mock("./attempt.sessions-yield.js", () => ({
  isSessionsYieldAbortError: hoisted.isSessionsYieldAbortError,
  persistSessionsYieldContextMessage: hoisted.persistSessionsYieldContextMessage,
  stripSessionsYieldArtifacts: hoisted.stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle: hoisted.waitForSessionsYieldAbortSettle,
}));
vi.mock("./attempt-handoff.js", () => ({
  waitForAttemptHandoffAbortSettle: hoisted.waitForAttemptHandoffAbortSettle,
}));
vi.mock("./attempt-self-compaction.js", () => ({
  isSessionStatusSelfCompactAbortError: hoisted.isSessionStatusSelfCompactAbortError,
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  normalizeCompactionRecoveryTranscriptTail: hoisted.normalizeCompactionRecoveryTranscriptTail,
}));
vi.mock("./midturn-precheck.js", () => ({
  isMidTurnPrecheckSignal: hoisted.isMidTurnPrecheckSignal,
}));

import { handleEmbeddedAttemptPromptError } from "./attempt-prompt-error.js";
import { PREEMPTIVE_OVERFLOW_ERROR_TEXT } from "./preemptive-compaction.js";

type PromptErrorInput = Parameters<typeof handleEmbeddedAttemptPromptError>[0];

function createInput(overrides: Partial<PromptErrorInput> = {}): PromptErrorInput {
  const sessionManager = {};
  return {
    activeSession: { agent: { state: { messages: [] } }, messages: [] },
    attempt: { runId: "run-1", sessionId: "session-1" },
    error: new Error("prompt failed"),
    handleMidTurnPrecheckRequest: hoisted.handleMidTurnPrecheckRequest,
    markSelfCompactionAborted: hoisted.markSelfCompactionAborted,
    markYieldAborted: hoisted.markYieldAborted,
    releaseLeasedSteering: hoisted.releaseLeasedSteering,
    sessionManager,
    sessionLockController: {
      releaseHeldLockForAbort: hoisted.releaseHeldLockForAbort,
    },
    selfCompactionAbortSettled: null,
    selfCompactionRequested: false,
    withOwnedSessionWriteLock: hoisted.withOwnedSessionWriteLock,
    yieldAbortSettled: null,
    yieldDetected: false,
    yieldMessage: null,
    ...overrides,
  } as PromptErrorInput;
}

describe("handleEmbeddedAttemptPromptError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.isMidTurnPrecheckSignal.mockReturnValue(false);
    hoisted.isSessionStatusSelfCompactAbortError.mockReturnValue(false);
    hoisted.isSessionsYieldAbortError.mockReturnValue(false);
  });

  it("returns ordinary provider failures to the prompt state owner", async () => {
    const error = new Error("provider failed");

    await expect(handleEmbeddedAttemptPromptError(createInput({ error }))).resolves.toEqual({
      kind: "prompt_failure",
      error,
      source: "prompt",
    });

    expect(hoisted.releaseLeasedSteering).toHaveBeenCalledWith(error);
  });

  it("routes mid-turn prechecks under the owned session lock", async () => {
    const request = {
      route: "compact_only",
      estimatedPromptTokens: 12,
      promptBudgetBeforeReserve: 10,
      overflowTokens: 2,
      toolResultReducibleChars: 0,
      effectiveReserveTokens: 1,
    } as const;
    const error = { request };
    hoisted.isMidTurnPrecheckSignal.mockReturnValue(true);

    await expect(handleEmbeddedAttemptPromptError(createInput({ error }))).resolves.toEqual({
      kind: "handled",
    });

    expect(hoisted.withOwnedSessionWriteLock).toHaveBeenCalledOnce();
    expect(hoisted.handleMidTurnPrecheckRequest).toHaveBeenCalledWith(request);
  });

  it("settles yield aborts, strips artifacts, and persists handoff context", async () => {
    const settlePromise = Promise.resolve();
    const error = new Error("yield handoff");
    const input = createInput({
      error,
      yieldAbortSettled: settlePromise,
      yieldDetected: true,
      yieldMessage: "wait for follow-up",
    });
    hoisted.isSessionsYieldAbortError.mockReturnValue(true);

    await expect(handleEmbeddedAttemptPromptError(input)).resolves.toEqual({ kind: "handled" });

    expect(hoisted.markYieldAborted).toHaveBeenCalledOnce();
    expect(hoisted.waitForSessionsYieldAbortSettle).toHaveBeenCalledWith({
      settlePromise,
      runId: "run-1",
      sessionId: "session-1",
    });
    expect(hoisted.releaseHeldLockForAbort).toHaveBeenCalledWith({ terminal: false });
    expect(hoisted.stripSessionsYieldArtifacts).toHaveBeenCalledWith(input.activeSession);
    expect(hoisted.persistSessionsYieldContextMessage).toHaveBeenCalledWith(
      input.activeSession,
      "wait for follow-up",
    );
  });

  it("marks yield state before fallible recovery begins", async () => {
    const recoveryError = new Error("settle failed");
    let marked = false;
    hoisted.isSessionsYieldAbortError.mockReturnValue(true);
    hoisted.waitForSessionsYieldAbortSettle.mockImplementationOnce(async () => {
      expect(marked).toBe(true);
      throw recoveryError;
    });

    await expect(
      handleEmbeddedAttemptPromptError(
        createInput({
          error: new Error("yield handoff"),
          markYieldAborted: () => {
            marked = true;
          },
          yieldDetected: true,
        }),
      ),
    ).rejects.toBe(recoveryError);
  });

  it("turns a self-compaction abort into compact-only transcript recovery", async () => {
    const settlePromise = Promise.resolve();
    const error = new Error("self compact");
    const input = createInput({
      error,
      selfCompactionAbortSettled: settlePromise,
      selfCompactionRequested: true,
    });
    hoisted.isSessionStatusSelfCompactAbortError.mockReturnValue(true);

    const outcome = await handleEmbeddedAttemptPromptError(input);

    expect(hoisted.markSelfCompactionAborted).toHaveBeenCalledOnce();
    expect(hoisted.waitForAttemptHandoffAbortSettle).toHaveBeenCalledWith({
      settlePromise,
      runId: "run-1",
      sessionId: "session-1",
      label: "session_status compact",
    });
    expect(
      hoisted.markSelfCompactionAborted.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    ).toBeLessThan(
      hoisted.waitForAttemptHandoffAbortSettle.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(hoisted.releaseHeldLockForAbort).toHaveBeenCalledWith({ terminal: false });
    expect(hoisted.normalizeCompactionRecoveryTranscriptTail).toHaveBeenCalledWith({
      activeSession: input.activeSession,
      sessionManager: input.sessionManager,
    });
    expect(outcome).toEqual({
      kind: "self_compaction",
      preflightRecovery: {
        route: "compact_only",
        source: "mid-turn",
        handled: false,
      },
      promptError: expect.objectContaining({ message: PREEMPTIVE_OVERFLOW_ERROR_TEXT }),
    });
  });
});
