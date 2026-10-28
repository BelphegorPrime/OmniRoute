import assert from "node:assert/strict";
import test from "node:test";
import { DecisionModelStrategyImpl } from "../../../open-sse/services/autoCombo/decisionModelStrategy.ts";
import { NadirStrategyImpl } from "../../../open-sse/services/autoCombo/nadirStrategy.ts";
import {
  getStrategy,
  listStrategies,
} from "../../../open-sse/services/autoCombo/routerStrategy.ts";
import type { ProviderCandidate } from "../../../open-sse/services/autoCombo/scoring.ts";

const pool = [
  { provider: "p", model: "cheap", circuitBreakerState: "CLOSED", costPer1MTokens: 1 },
  { provider: "q", model: "capable", circuitBreakerState: "CLOSED", costPer1MTokens: 5 },
] as ProviderCandidate[];
const context = {
  taskType: "general",
  messages: [{ role: "user", content: "Explain this code" }],
  decisionModel: {
    baseUrl: "https://decision.invalid/proxy/",
    model: "decision-model",
    apiKey: "secret",
    timeoutMs: 900,
  },
};
const fallback = {
  name: "rules",
  description: "fallback",
  select: (items: ProviderCandidate[]) => ({
    provider: items[0].provider,
    model: items[0].model,
    strategy: "rules",
    reason: "rules",
    candidatesConsidered: items.length,
    finalScore: 1,
  }),
};

test("single unique model falls back without network and preserves connection selection", async () => {
  const singleModelPool = [
    { ...pool[0], provider: "p", connectionId: "account-a" },
    { ...pool[0], provider: "q", connectionId: "account-b" },
  ] as ProviderCandidate[];
  for (const format of ["openai", "systemone"] as const) {
    let calls = 0;
    let fallbackPool: ProviderCandidate[] = [];
    const connectionFallback = {
      ...fallback,
      select: (items: ProviderCandidate[]) => {
        fallbackPool = items;
        return {
          provider: items[1].provider,
          model: items[1].model,
          connectionId: items[1].connectionId,
          strategy: "rules",
          reason: "rules selected account-b",
          candidatesConsidered: items.length,
          finalScore: 1,
        };
      },
    };
    const strategy = new DecisionModelStrategyImpl(
      {
        fallback: connectionFallback,
        transport: async () => {
          calls += 1;
          return Response.json({});
        },
      },
      format
    );

    const result = await strategy.selectAsync(singleModelPool, context);
    assert.equal(calls, 0, `${format} must skip decision-service I/O for a one-model pool`);
    assert.deepEqual(fallbackPool, singleModelPool);
    assert.equal(result.provider, "q");
    assert.equal(result.connectionId, "account-b");
    assert.match(result.reason, /one unique model/i);
  }
});

test("menu cap never truncates eligible connections or fallback candidates", async () => {
  const manyConnections = Array.from({ length: 51 }, (_, index) => ({
    ...pool[0],
    provider: `provider-${index}`,
    connectionId: `account-${index}`,
  }));
  const secondModel = {
    ...pool[1],
    provider: "last-provider",
    model: "second-model",
    connectionId: "last-account",
  };
  const largePool = [...manyConnections, secondModel] as ProviderCandidate[];
  let capturedMenu: string[] = [];
  let fallbackPool: ProviderCandidate[] = [];
  const connectionFallback = {
    ...fallback,
    select: (items: ProviderCandidate[]) => {
      fallbackPool = items;
      return {
        provider: items[0].provider,
        model: items[0].model,
        connectionId: items[0].connectionId,
        strategy: "rules",
        reason: "rules selected matching connection",
        candidatesConsidered: items.length,
        finalScore: 1,
      };
    },
  };
  const strategy = new DecisionModelStrategyImpl(
    {
      fallback: connectionFallback,
      transport: async (_url, init) => {
        const body = JSON.parse(init.body);
        capturedMenu = body.questions[0].choices.map((choice: { value: string }) => choice.value);
        return Response.json({
          answers: [{ type: "choice", name: "route_model", choice: "second-model" }],
        });
      },
    },
    "openai"
  );

  const result = await strategy.selectAsync(largePool, context);
  assert.deepEqual(capturedMenu, ["cheap", "second-model"]);
  assert.equal(fallbackPool.length, 1);
  assert.equal(fallbackPool[0].connectionId, "last-account");
  assert.equal(result.provider, "last-provider");
  assert.equal(result.connectionId, "last-account");
  assert.equal(result.candidatesConsidered, largePool.length);
});

test("legacy shared credentials and model do not configure either decision format", async () => {
  const names = [
    "OMNIROUTE_DECISION_API_KEY",
    "OMNIROUTE_DECISION_BASE_URL",
    "OMNIROUTE_DECISION_MODEL",
    "OMNIROUTE_OPENAI_DECISION_API_KEY",
    "OMNIROUTE_OPENAI_DECISION_BASE_URL",
    "OMNIROUTE_OPENAI_DECISION_MODEL",
    "OMNIROUTE_SYSTEM_ONE_DECISION_API_KEY",
    "OMNIROUTE_SYSTEM_ONE_DECISION_BASE_URL",
    "OMNIROUTE_SYSTEM_ONE_DECISION_MODEL",
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.OMNIROUTE_DECISION_API_KEY = "legacy";
    process.env.OMNIROUTE_DECISION_BASE_URL = "https://legacy.invalid";
    process.env.OMNIROUTE_DECISION_MODEL = "legacy-model";
    for (const name of names.filter((name) => !name.startsWith("OMNIROUTE_DECISION_")))
      delete process.env[name];
    for (const format of ["openai", "systemone"] as const) {
      let calls = 0;
      const strategy = new DecisionModelStrategyImpl(
        {
          fallback,
          transport: async () => {
            calls++;
            return Response.json({});
          },
        },
        format
      );
      const result = await strategy.selectAsync(pool, { ...context, decisionModel: undefined });
      assert.match(result.reason, /not configured/);
      assert.equal(calls, 0);
    }
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("OpenAI decisions request uses one documented choice and forwards all config", async () => {
  let captured:
    | {
        url: string;
        init: {
          headers: Record<string, string>;
          timeoutMs: number;
          body: string;
          signal: AbortSignal;
        };
      }
    | undefined;
  const strategy = new DecisionModelStrategyImpl(
    {
      fallback,
      transport: async (url, init) => {
        captured = { url, init };
        return Response.json({
          model: "backend-model",
          answers: [{ type: "choice", name: "route_model", choice: "capable" }],
        });
      },
    },
    "openai"
  );
  const result = await strategy.selectAsync(pool, {
    ...context,
    decisionModel: { ...context.decisionModel, apiKey: "test-decision-key" },
  });
  assert.equal(result.model, "capable");
  assert.equal(captured?.url, "https://decision.invalid/proxy/v1/decisions");
  assert.equal(captured?.init.timeoutMs, 900);
  assert.equal(captured?.init.headers.Authorization, "Bearer test-decision-key");
  const body = JSON.parse(captured!.init.body);
  assert.equal(body.model, "decision-model");
  assert.deepEqual(body.input[0], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Explain this code" }],
  });
  assert.deepEqual(
    body.questions[0].choices.map((choice: { value: string }) => choice.value),
    ["cheap", "capable"]
  );
  assert.match(body.questions[0].instructions, /cheapest model tier/i);
});

test("format-specific timeout defaults, overrides, invalid values, and cap are independent", async () => {
  const original = process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS;
  const systemOriginal = process.env.OMNIROUTE_SYSTEM_ONE_DECISION_TIMEOUT_MS;
  const legacy = process.env.OMNIROUTE_DECISION_TIMEOUT_MS;
  const captured: number[] = [];
  const systemOneCaptured: number[] = [];
  const strategy = new DecisionModelStrategyImpl(
    {
      fallback,
      transport: async (_url, init) => {
        captured.push(init.timeoutMs);
        return Response.json({
          model: "backend-model",
          answers: [{ type: "choice", name: "route_model", choice: "cheap" }],
        });
      },
    },
    "openai"
  );
  try {
    delete process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS;
    process.env.OMNIROUTE_SYSTEM_ONE_DECISION_TIMEOUT_MS = "1800";
    process.env.OMNIROUTE_DECISION_TIMEOUT_MS = "26000";
    await strategy.selectAsync(pool, {
      ...context,
      decisionModel: { baseUrl: "https://decision.invalid/first", model: "decision-model" },
    });
    const systemOneStrategy = new DecisionModelStrategyImpl(
      {
        fallback,
        transport: async (_url, init) => {
          systemOneCaptured.push(init.timeoutMs);
          return Response.json({
            model: "backend-model",
            answers: [{ type: "choice", name: "route_model", choice: "cheap" }],
          });
        },
      },
      "systemone"
    );
    await systemOneStrategy.selectAsync(pool, {
      ...context,
      decisionModel: { baseUrl: "https://decision.invalid/systemone", model: "decision-model" },
    });
    process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS = "7500";
    await strategy.selectAsync(pool, {
      ...context,
      decisionModel: { baseUrl: "https://decision.invalid/second", model: "decision-model" },
    });
    process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS = "60000";
    await strategy.selectAsync(pool, {
      ...context,
      decisionModel: { baseUrl: "https://decision.invalid/third", model: "decision-model" },
    });
    process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS = "invalid";
    await strategy.selectAsync(pool, {
      ...context,
      decisionModel: { baseUrl: "https://decision.invalid/fourth", model: "decision-model" },
    });
  } finally {
    if (original === undefined) delete process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS;
    else process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS = original;
    if (systemOriginal === undefined) delete process.env.OMNIROUTE_SYSTEM_ONE_DECISION_TIMEOUT_MS;
    else process.env.OMNIROUTE_SYSTEM_ONE_DECISION_TIMEOUT_MS = systemOriginal;
    if (legacy === undefined) delete process.env.OMNIROUTE_DECISION_TIMEOUT_MS;
    else process.env.OMNIROUTE_DECISION_TIMEOUT_MS = legacy;
  }
  assert.deepEqual(captured, [2_000, 7_500, 30_000, 2_000]);
  assert.deepEqual(systemOneCaptured, [1_800]);
});

test("combo timeout takes precedence over format-specific environment and legacy fallback", async () => {
  const original = process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS;
  const legacy = process.env.OMNIROUTE_DECISION_TIMEOUT_MS;
  let captured = 0;
  process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS = "7500";
  process.env.OMNIROUTE_DECISION_TIMEOUT_MS = "12000";
  try {
    const strategy = new DecisionModelStrategyImpl(
      {
        fallback,
        transport: async (_url, init) => {
          captured = init.timeoutMs;
          return Response.json({
            model: "backend-model",
            answers: [{ type: "choice", name: "route_model", choice: "cheap" }],
          });
        },
      },
      "openai"
    );
    await strategy.selectAsync(pool, context);
  } finally {
    if (original === undefined) delete process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS;
    else process.env.OMNIROUTE_OPENAI_DECISION_TIMEOUT_MS = original;
    if (legacy === undefined) delete process.env.OMNIROUTE_DECISION_TIMEOUT_MS;
    else process.env.OMNIROUTE_DECISION_TIMEOUT_MS = legacy;
  }
  assert.equal(captured, 900);
});

test("System One request and keyed choice response follow documented format", async () => {
  let captured = "";
  const strategy = new DecisionModelStrategyImpl(
    {
      fallback,
      transport: async (_url, init) => {
        captured = init.body;
        return Response.json({
          model: "backend-model",
          answers: { route_model: { type: "choice", choice: "cheap" } },
        });
      },
    },
    "systemone"
  );
  assert.equal((await strategy.selectAsync(pool, context)).model, "cheap");
  const body = JSON.parse(captured);
  assert.equal(body.model, "decision-model");
  assert.equal(body.state, "Explain this code");
  assert.equal(body.questions.route_model.type, "choice");
  assert.deepEqual(Object.keys(body.questions.route_model.criteria), ["cheap", "capable"]);
});

test("requires explicit config, rejects invalid URLs and safely falls back", async () => {
  let calls = 0;
  const strategy = new DecisionModelStrategyImpl(
    {
      fallback,
      transport: async () => {
        calls += 1;
        return Response.json({});
      },
    },
    "openai"
  );
  await strategy.selectAsync(pool, { ...context, decisionModel: {} });
  await strategy.selectAsync(pool, {
    ...context,
    decisionModel: { baseUrl: "https://u:p@x.test", model: "d" },
  });
  assert.equal(calls, 0);
});

test("malformed and out-of-menu answers fail open; errors are redacted and cooled down", async () => {
  let calls = 0;
  let now = 1;
  const strategy = new DecisionModelStrategyImpl(
    {
      now: () => now,
      transport: async () => {
        calls += 1;
        return Response.json({
          answers: [{ type: "choice", name: "route_model", choice: "not-in-pool" }],
        });
      },
      fallback,
    },
    "openai"
  );
  const result = await strategy.selectAsync(pool, context);
  assert.equal(result.strategy, "rules");
  assert.equal(result.model, "cheap");
  assert.equal(calls, 1);
  const httpFailure = new DecisionModelStrategyImpl(
    { transport: async () => new Response("private error", { status: 503 }), fallback },
    "openai"
  );
  assert.equal((await httpFailure.selectAsync(pool, context)).strategy, "rules");
  const malformed = new DecisionModelStrategyImpl(
    { transport: async () => Response.json({ answers: "refusal" }), fallback },
    "systemone"
  );
  assert.equal((await malformed.selectAsync(pool, context)).strategy, "rules");
  const broken = new DecisionModelStrategyImpl(
    {
      now: () => now,
      transport: async () => {
        calls += 1;
        throw new Error("secret url and prompt");
      },
      fallback,
    },
    "openai"
  );
  const failed = await broken.selectAsync(pool, context);
  assert.doesNotMatch(failed.reason, /secret|prompt|https:/i);
  await broken.selectAsync(pool, context);
  assert.equal(calls, 2);
  now += 31_000;
  await broken.selectAsync(pool, context);
  assert.equal(calls, 3);
});

test("timeout aborts pending transport and response-body parsing", async () => {
  for (const stage of ["transport", "body"] as const) {
    let signal: AbortSignal | undefined;
    const strategy = new DecisionModelStrategyImpl(
      {
        fallback,
        transport: async (_url, init) => {
          signal = init.signal;
          if (stage === "transport") return new Promise<Response>(() => undefined);
          return {
            ok: true,
            status: 200,
            json: () => new Promise<never>(() => undefined),
          } as Response;
        },
      },
      "openai"
    );
    const result = await strategy.selectAsync(pool, {
      ...context,
      decisionModel: { baseUrl: "https://decision.invalid", model: "decision", timeoutMs: 100 },
    });
    assert.equal(result.strategy, "rules");
    assert.equal(signal?.aborted, true, `${stage} should receive cancellation`);
  }
});

test("registry exposes both DecisionModel strategies and Nadir remains registered", async () => {
  for (const name of ["decision-openai", "decision-systemone", "nadir"]) {
    assert.equal(
      listStrategies().some((item) => item.name === name),
      true
    );
  }
  assert.equal(getStrategy("nadir").name, "nadir");
  assert.equal(getStrategy("decision-openai").name, "decision-openai");
  const nadir = new NadirStrategyImpl({
    fallback,
    transport: async () => Response.json({ selected_model: "capable", confidence: 0.9 }),
  });
  const nadirResult = await nadir.selectAsync(pool, {
    taskType: "general",
    messages: [{ role: "user", content: "Explain this code" }],
    nadir: { baseUrl: "https://nadir.invalid" },
  });
  assert.equal(nadirResult.strategy, "nadir");
  assert.equal(nadirResult.model, "capable");
});
