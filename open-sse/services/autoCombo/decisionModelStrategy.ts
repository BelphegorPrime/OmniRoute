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
type Format = "openai" | "systemone";

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
  model: string
): Record<string, unknown> {
  const instructions =
    "Choose the cheapest model tier in this pool that can reliably complete the user's request. Use a more capable tier only when the task requires it.";
  const choices = menu.map((modelId) => ({ value: modelId, description: `Model tier ${modelId}` }));
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
        criteria: Object.fromEntries(menu.map((id) => [id, `Model tier ${id}`])),
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
    if ((this.cooldownUntil.get(`${base}${this.endpoint}`) ?? 0) > this.now())
      return this.fallbackDecision(candidates, context, "decision service cooling down");
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const key = readString(config?.apiKey) ?? readString(process.env[`${prefix}_API_KEY`]);
      if (key) headers.Authorization = "Bearer " + key;
      const rawEnvTimeout = readString(process.env[`${prefix}_TIMEOUT_MS`]);
      const configuredTimeout = rawEnvTimeout === undefined ? Number.NaN : Number(rawEnvTimeout);
      const envTimeout =
        Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : undefined;
      const boundedTimeout = timeout(config?.timeoutMs ?? envTimeout);
      const controller = new AbortController();
      const operation = async () => {
        const response = await this.transport(`${base}${this.endpoint}`, {
          method: "POST",
          headers,
          timeoutMs: boundedTimeout,
          signal: controller.signal,
          body: JSON.stringify(buildBody(this.format, prompt, menu, model)),
        });
        if (!response.ok) throw new Error("http_failure");
        return response.json();
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const data: unknown = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, boundedTimeout);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      const selected = this.readSelection(data);
      if (!selected || !menu.includes(selected))
        return this.fallbackDecision(candidates, context, "invalid or out-of-pool choice");
      const matching = candidates.filter((item) => item.model === selected);
      const decision = this.fallback.select(matching, context);
      return {
        ...decision,
        strategy: this.name,
        candidatesConsidered: candidates.length,
        reason: `${this.name}: selected an allowed model (${decision.reason})`,
      };
    } catch {
      this.cooldownUntil.set(`${base}${this.endpoint}`, this.now() + FAILURE_COOLDOWN_MS);
      return this.fallbackDecision(candidates, context, "decision request failed; cooling down");
    }
  }
  private readSelection(data: unknown): string | undefined {
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const answers = (data as { answers?: unknown }).answers;
    if (this.format === "openai") {
      if (!Array.isArray(answers)) return undefined;
      const answer = answers.find(
        (item) =>
          item && typeof item === "object" && (item as { name?: unknown }).name === "route_model"
      ) as { type?: unknown; choice?: unknown } | undefined;
      return answer?.type === "choice" ? readString(answer.choice) : undefined;
    }
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined;
    const answer = (answers as Record<string, { type?: unknown; choice?: unknown }>).route_model;
    return answer?.type === "choice" ? readString(answer.choice) : undefined;
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
