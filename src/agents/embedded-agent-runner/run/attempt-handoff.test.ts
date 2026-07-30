import { describe, expect, it } from "vitest";
import {
  createAttemptHandoffAbortReason,
  createAttemptHandoffAbortedResponse,
  isAttemptHandoffAbortError,
  isAttemptHandoffAbortReason,
} from "./attempt-handoff.js";

function createAbortError(cause: unknown): Error {
  const error = new Error("attempt aborted", { cause });
  error.name = "AbortError";
  return error;
}

describe("attempt handoff", () => {
  it.each(["sessions_yield", "session_status_compact"] as const)(
    "recognizes the %s handoff reason and abort error",
    (code) => {
      const reason = createAttemptHandoffAbortReason(code);

      expect(reason).toEqual({ code, turnHandoff: true });
      expect(isAttemptHandoffAbortReason(reason)).toBe(true);
      expect(isAttemptHandoffAbortError(createAbortError(reason), code)).toBe(true);
    },
  );

  it("rejects unrelated or non-handoff abort reasons", () => {
    expect(isAttemptHandoffAbortReason({ code: "session_status_compact" })).toBe(false);
    expect(isAttemptHandoffAbortReason({ code: "other", turnHandoff: true })).toBe(false);
    expect(
      isAttemptHandoffAbortError(
        createAbortError({ code: "sessions_yield", turnHandoff: true }),
        "session_status_compact",
      ),
    ).toBe(false);
  });

  it("builds a provider-shaped synthetic aborted response", async () => {
    const response = createAttemptHandoffAbortedResponse({
      api: "openai-responses",
      provider: "openai",
      id: "gpt-test",
    });

    await expect(response.result()).resolves.toMatchObject({
      role: "assistant",
      stopReason: "aborted",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: { totalTokens: 0 },
    });
    const chunks: unknown[] = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });
});
