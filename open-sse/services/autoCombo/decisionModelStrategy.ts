/** Provider-neutral decision-model routing through /v1/decisions and /v1/systemone. */
import type { ProviderCandidate } from "./scoring.ts";
import type { RouterStrategy, RoutingContext, RoutingDecision } from "./routerStrategy.ts";

export interface DecisionModelRoutingConfig {
  apiKey?: string;
  /** Absolute http(s) URL; path prefixes are preserved before the documented endpoint. */
  baseUrl?: string;
  /** Required decision-model alias (or the format-specific decision model env var). */
  model?: string;
  timeoutMs?: number;
  /** Per-model choice descriptions, keyed by model ID or `provider/model`; replaces the generated text. */
  descriptions?: Record<string, string>;
}
export interface DecisionModelTransportInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  signal: AbortSignal;
}
export type DecisionModelTransport = (
  url: string,
  init: DecisionModelTransportInit
) => Promise<Response>;
export interface DecisionModelStrategyOptions {
  fallback: RouterStrategy;
  transport?: DecisionModelTransport;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 30_000;
const FAILURE_COOLDOWN_MS = 30_000;
const MAX_MENU_ITEMS = 50;
const MAX_PROMPT_CHARS = 16_000;
const MAX_LOGGED_CHOICE_CHARS = 100;
const MAX_LOGGED_MODEL_CHARS = 100;
type Format = "openai" | "systemone";
type FailureKind = "timeout" | "http" | "invalid_json" | "network";

/** Failure cause safe to log: never carries the URL, key, prompt or upstream body. */
class DecisionRequestError extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly status?: number
  ) {
    super(kind);
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}
function timeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_TIMEOUT_MS, value)
    : DEFAULT_TIMEOUT_MS;
}
/** Normalize a combo's raw `config.decisionModel` block; non-objects yield `undefined`. */
export function resolveDecisionModelRoutingConfig(
  raw: unknown
): DecisionModelRoutingConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const timeoutMs = Number(record.timeoutMs);
  return {
    apiKey: readString(record.apiKey),
    baseUrl: readString(record.baseUrl),
    model: readString(record.model),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    descriptions: resolveDescriptions(record.descriptions),
  };
}
function resolveDescriptions(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).flatMap(([key, value]) => {
    const id = readString(key);
    const text = readString(value);
    return id && text ? [[id, text] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}
/**
 * One description per menu entry. An operator description (by model ID, else by
 * `provider/model`) wins; otherwise the text carries the pool's cost ranking, but only
 * when costs differ — unpriced models take the pool median, so the figure is an estimate.
 */
function describeMenu(
  menu: string[],
  candidates: ProviderCandidate[],
  descriptions: Record<string, string> | undefined
): Record<string, string> {
  const costs = new Map<string, number>();
  for (const item of candidates) {
    const cost = item.costPer1MTokens;
    if (!Number.isFinite(cost) || cost < 0) continue;
    costs.set(item.model, Math.min(costs.get(item.model) ?? Infinity, cost));
  }
  const ranked = [...new Set(menu.map((id) => costs.get(id)).filter((c) => c !== undefined))].sort(
    (a, b) => a - b
  );
  return Object.fromEntries(
    menu.map((id) => {
      const operator =
        descriptions?.[id] ??
        candidates
          .filter((item) => item.model === id)
          .map((item) => descriptions?.[`${item.provider}/${id}`])
          .find(Boolean);
      if (operator) return [id, operator];
      const cost = costs.get(id);
      if (cost === undefined || ranked.length < 2) return [id, `Model ${id}`];
      return [
        id,
        `Model ${id}; estimated cost $${Number(cost.toPrecision(3))} per 1M tokens (cost rank ${
          ranked.indexOf(cost) + 1
        } of ${ranked.length}, 1 = cheapest)`,
      ];
    })
  );
}
interface DecisionAnswer {
  choice?: string;
  refused: boolean;
  /** Log-safe summary: confidence, probability of the choice, answering backend model. */
  details: string;
}
function formatScore(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Number(value.toFixed(4)))
    : undefined;
}
/** Probability of `choice`: an array of `{value, probability}` (decisions) or a label map (System One). */
function choiceProbability(probabilities: unknown, choice: string | undefined): unknown {
  if (choice === undefined) return undefined;
  if (Array.isArray(probabilities))
    return (
      probabilities.find(
        (item) => item && typeof item === "object" && (item as { value?: unknown }).value === choice
      ) as { probability?: unknown } | undefined
    )?.probability;
  if (probabilities && typeof probabilities === "object")
    return (probabilities as Record<string, unknown>)[choice];
  return undefined;
}
function describeFailure(error: unknown, timeoutMs: number): string {
  if (!(error instanceof DecisionRequestError)) return "network error";
  if (error.kind === "timeout") return `timeout after ${timeoutMs}ms`;
  if (error.kind === "http") return `HTTP ${error.status}`;
  if (error.kind === "invalid_json") return "invalid JSON response";
  return "network error";
}
export function extractDecisionModelLastUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown } | null;
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim() || null;
    if (!Array.isArray(message.content)) return null;
    const text = message.content
      .map((part: unknown) => {
        const item = part as { type?: unknown; text?: unknown } | null;
        return (item?.type === "text" || item?.type === "input_text") &&
          typeof item.text === "string"
          ? item.text
          : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}
function buildBody(
  format: Format,
  prompt: string,
  menu: string[],
  described: Record<string, string>,
  model: string
): Record<string, unknown> {
  const instructions =
    "Choose the cheapest model tier in this pool that can reliably complete the user's request. Use a more capable tier only when the task requires it.";
  const choices = menu.map((modelId) => ({ value: modelId, description: described[modelId] }));
  if (format === "openai")
    return {
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt.slice(0, MAX_PROMPT_CHARS) }],
        },
      ],
      questions: [{ type: "choice", name: "route_model", instructions, choices }],
    };
  return {
    model,
    state: prompt.slice(0, MAX_PROMPT_CHARS),
    questions: {
      route_model: {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(menu.map((id) => [id, described[id]])),
      },
    },
  };
}
const defaultTransport: DecisionModelTransport = async (url, init) => {
  const [{ safeOutboundFetch }, { getProviderOutboundGuard }] = await Promise.all([
    import("@/shared/network/safeOutboundFetch"),
    import("@/shared/network/outboundUrlGuardPolicy"),
  ]);
  return safeOutboundFetch(url, { ...init, retry: false, guard: getProviderOutboundGuard() });
};

export class DecisionModelStrategyImpl implements RouterStrategy {
  readonly name: string;
  readonly description: string;
  private readonly fallback: RouterStrategy;
  private readonly transport: DecisionModelTransport;
  private readonly now: () => number;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly format: Format;
  private readonly endpoint: string;
  constructor(options: DecisionModelStrategyOptions, format: Format) {
    this.format = format;
    this.endpoint = format === "openai" ? "/v1/decisions" : "/v1/systemone";
    this.name = format === "openai" ? "decision-openai" : "decision-systemone";
    this.description = `Routes by a decision API ${this.endpoint} choice; failures use rules fallback`;
    this.fallback = options.fallback;
    this.transport = options.transport ?? defaultTransport;
    this.now = options.now ?? Date.now;
  }
  select(pool: ProviderCandidate[], context: RoutingContext): RoutingDecision {
    return this.fallbackDecision(pool, context, "sync caller; decision requires network I/O");
  }
  async selectAsync(pool: ProviderCandidate[], context: RoutingContext): Promise<RoutingDecision> {
    const healthy = pool.filter((item) => item.circuitBreakerState !== "OPEN");
    const candidates = healthy.length ? healthy : pool;
    if (!candidates.length) throw new Error(`[${this.name}] No candidates available`);
    const menu = [...new Set(candidates.map((item) => item.model))].slice(0, MAX_MENU_ITEMS);
    if (menu.length < 2)
      return this.fallbackDecision(candidates, context, "only one unique model is eligible");
    const prompt = extractDecisionModelLastUserText(context.messages);
    const config = context.decisionModel;
    const prefix =
      this.format === "openai" ? "OMNIROUTE_OPENAI_DECISION" : "OMNIROUTE_SYSTEM_ONE_DECISION";
    const rawBase = readString(config?.baseUrl) ?? readString(process.env[`${prefix}_BASE_URL`]);
    const model = readString(config?.model) ?? readString(process.env[`${prefix}_MODEL`]);
    if (!rawBase || !model)
      return this.fallbackDecision(
        candidates,
        context,
        "decision API base URL or decision model is not configured"
      );
    const base = normalizeBaseUrl(rawBase);
    if (!base) return this.fallbackDecision(candidates, context, "invalid decision API base URL");
    if (!prompt) return this.fallbackDecision(candidates, context, "request carries no user text");
    const cooldownUntil = this.cooldownUntil.get(`${base}${this.endpoint}`) ?? 0;
    if (cooldownUntil > this.now())
      return this.fallbackDecision(
        candidates,
        context,
        `decision service cooling down for ${Math.ceil((cooldownUntil - this.now()) / 1000)}s; not called`
      );
    let boundedTimeout = DEFAULT_TIMEOUT_MS;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const key = readString(config?.apiKey) ?? readString(process.env[`${prefix}_API_KEY`]);
      if (key) headers.Authorization = "Bearer " + key;
      const rawEnvTimeout = readString(process.env[`${prefix}_TIMEOUT_MS`]);
      const configuredTimeout = rawEnvTimeout === undefined ? Number.NaN : Number(rawEnvTimeout);
      const envTimeout =
        Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : undefined;
      boundedTimeout = timeout(config?.timeoutMs ?? envTimeout);
      const described = describeMenu(menu, candidates, config?.descriptions);
      const controller = new AbortController();
      const operation = async () => {
        const response = await this.transport(`${base}${this.endpoint}`, {
          method: "POST",
          headers,
          timeoutMs: boundedTimeout,
          signal: controller.signal,
          body: JSON.stringify(buildBody(this.format, prompt, menu, described, model)),
        });
        if (!response.ok) throw new DecisionRequestError("http", response.status);
        try {
          return await response.json();
        } catch {
          if (controller.signal.aborted) throw new DecisionRequestError("timeout");
          throw new DecisionRequestError("invalid_json");
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const data: unknown = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new DecisionRequestError("timeout"));
          }, boundedTimeout);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      const answer = this.readAnswer(data);
      const selected = answer.choice;
      if (!selected || !menu.includes(selected))
        return this.fallbackDecision(
          candidates,
          context,
          (answer.refused
            ? "decision model refused route_model"
            : selected
              ? `out-of-pool choice ${JSON.stringify(selected.slice(0, MAX_LOGGED_CHOICE_CHARS))} from ${menu.length} options`
              : "response carries no valid route_model choice") + answer.details
        );
      const matching = candidates.filter((item) => item.model === selected);
      const decision = this.fallback.select(matching, context);
      return {
        ...decision,
        strategy: this.name,
        candidatesConsidered: candidates.length,
        reason: `${this.name}: selected ${selected} from ${menu.length} options${answer.details} (${decision.reason})`,
      };
    } catch (error) {
      this.cooldownUntil.set(`${base}${this.endpoint}`, this.now() + FAILURE_COOLDOWN_MS);
      return this.fallbackDecision(
        candidates,
        context,
        `decision request failed (${describeFailure(error, boundedTimeout)}); cooling down for ${
          FAILURE_COOLDOWN_MS / 1000
        }s`
      );
    }
  }
  private readAnswer(data: unknown): DecisionAnswer {
    if (!data || typeof data !== "object" || Array.isArray(data))
      return { refused: false, details: "" };
    const record = data as { answers?: unknown; model?: unknown };
    let answer: Record<string, unknown> | undefined;
    if (this.format === "openai") {
      answer = Array.isArray(record.answers)
        ? (record.answers.find(
            (item) =>
              item &&
              typeof item === "object" &&
              (item as { name?: unknown }).name === "route_model"
          ) as Record<string, unknown> | undefined)
        : undefined;
    } else if (
      record.answers &&
      typeof record.answers === "object" &&
      !Array.isArray(record.answers)
    ) {
      const keyed = (record.answers as Record<string, unknown>).route_model;
      answer = keyed && typeof keyed === "object" ? (keyed as Record<string, unknown>) : undefined;
    }
    const choice = answer?.type === "choice" ? readString(answer.choice) : undefined;
    const backend = readString(record.model)?.slice(0, MAX_LOGGED_MODEL_CHARS);
    const confidence = formatScore(answer?.confidence);
    const probability = formatScore(choiceProbability(answer?.probabilities, choice));
    const parts = [
      confidence && `confidence ${confidence}`,
      probability && `p=${probability}`,
      backend && `decision model ${JSON.stringify(backend)}`,
    ].filter(Boolean);
    return {
      choice,
      refused: answer?.type === "refusal",
      details: parts.length ? `; ${parts.join(", ")}` : "",
    };
  }
  private fallbackDecision(
    pool: ProviderCandidate[],
    context: RoutingContext,
    reason: string
  ): RoutingDecision {
    const decision = this.fallback.select(pool, context);
    return { ...decision, reason: `${this.name}: fallback (${reason}); ${decision.reason}` };
  }
}
