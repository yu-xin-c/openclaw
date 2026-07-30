import { isRunnerAbortError } from "../abort.js";
import { log } from "../logger.js";
import { resolveEmbeddedAbortSettleTimeoutMs } from "./attempt.abort-settle-timeout.js";

const ATTEMPT_HANDOFF_ABORT_SETTLE_TIMEOUT_MS = resolveEmbeddedAbortSettleTimeoutMs();

type AttemptHandoffCode = "sessions_yield" | "session_status_compact";

export type AttemptHandoffAbortReason = {
  code: AttemptHandoffCode;
  turnHandoff: true;
};

export function createAttemptHandoffAbortReason(
  code: AttemptHandoffCode,
): AttemptHandoffAbortReason {
  return { code, turnHandoff: true };
}

export function isAttemptHandoffAbortReason(reason: unknown): reason is AttemptHandoffAbortReason {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }
  const candidate = reason as { code?: unknown; turnHandoff?: unknown };
  return (
    candidate.turnHandoff === true &&
    (candidate.code === "sessions_yield" || candidate.code === "session_status_compact")
  );
}

export function isAttemptHandoffAbortError(error: unknown, code: AttemptHandoffCode): boolean {
  return (
    isRunnerAbortError(error) &&
    error instanceof Error &&
    isAttemptHandoffAbortReason(error.cause) &&
    error.cause.code === code
  );
}

export async function waitForAttemptHandoffAbortSettle(params: {
  settlePromise: Promise<void> | null;
  runId: string;
  sessionId: string;
  label: string;
}): Promise<void> {
  if (!params.settlePromise) {
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    params.settlePromise
      .then(() => "settled" as const)
      .catch((error: unknown) => {
        log.warn(
          `${params.label} abort settle failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(error)}`,
        );
        return "errored" as const;
      }),
    new Promise<"timed_out">((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), ATTEMPT_HANDOFF_ABORT_SETTLE_TIMEOUT_MS);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (outcome === "timed_out") {
    log.warn(
      `${params.label} abort settle timed out: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${ATTEMPT_HANDOFF_ABORT_SETTLE_TIMEOUT_MS}`,
    );
  }
}

export function createAttemptHandoffAbortedResponse(model: {
  api?: string;
  provider?: string;
  id?: string;
}): {
  [Symbol.asyncIterator]: () => AsyncGenerator<never, void, unknown>;
  result: () => Promise<{
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    stopReason: "aborted";
    api: string;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
    timestamp: number;
  }>;
} {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "" }],
    stopReason: "aborted" as const,
    api: model.api ?? "",
    provider: model.provider ?? "",
    model: model.id ?? "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => message,
  };
}
