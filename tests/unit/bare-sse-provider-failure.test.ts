import test from "node:test";
import assert from "node:assert/strict";
import { runNonStreamingProviderLeg } from "../../open-sse/handlers/chatCore/nonStreamingProviderLeg.ts";
import { baseInput, makeExecutorResult } from "./_helpers/nonStreamingProviderLegFixtures.ts";

// #17198 made a bare error frame a failed Responses payload. It is valid SSE
// carrying an upstream failure, whereas malformed data remains invalid_sse_payload.
for (const fallback of [false, true]) {
  for (const scenario of [
    { error: { message: "Devin CLI not found" }, status: 502, code: "upstream_error" },
    {
      error: { message: "Quota exhausted", code: "rate_limit_exceeded" },
      status: 429,
      code: "rate_limit_exceeded",
    },
  ]) {
    test(`bare SSE error is preserved on ${fallback ? "empty-content fallback" : "initial send"}: ${scenario.code}`, async () => {
      let calls = 0;
      const result = await runNonStreamingProviderLeg(
        baseInput({
          provider: "gemini",
          model: "gemini-3-pro",
          allowModelFallback: fallback,
          clientHeaders: { "x-omniroute-allow-cross-version-fallback": "true" },
          executeProviderRequest: async () => {
            calls++;
            if (fallback && calls === 1) {
              return makeExecutorResult({
                choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
              });
            }
            return makeExecutorResult(
              `data: ${JSON.stringify({ error: scenario.error })}\n\n`,
              200,
              {
                "content-type": "text/event-stream",
              }
            );
          },
        })
      );
      assert.equal(calls, fallback ? 2 : 1);
      assert.equal(result.kind, "error");
      if (result.kind !== "error") return;
      assert.equal(result.result.status, scenario.status);
      assert.equal(result.result.errorCode, scenario.code);
      assert.notEqual(result.result.errorCode, "invalid_sse_payload");
      assert.equal(result.result.rawMessage, scenario.error.message);
      assert.deepEqual(result.result.upstreamErrorBody?.error, scenario.error);
      assert.equal(result.receipt.httpStatus, scenario.status);
      assert.equal(result.receipt.termination, "provider_error");
    });
  }
}
