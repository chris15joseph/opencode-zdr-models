/**
 * Data-retention policy lookup for OpenCode Console and OpenCode Go models.
 *
 * LIVE DATA: `fetch.ts` downloads and parses the privacy tables from
 * https://opencode.ai/v2/docs/console/go#privacy and
 * https://opencode.ai/v2/docs/console/models#privacy every time OpenCode loads
 * the plugin (i.e. before a coding session starts), because these policies can
 * change at any time. This module contains:
 *
 *   1. The types and pure resolution logic.
 *   2. A bundled snapshot (fallback only, used when the live fetch fails).
 *
 * Retention statuses:
 * - "zero"     data retention is 0 days (zero data retention). Model is listed.
 * - "30d"      requests are retained for 30 days. Model is hidden.
 * - "not-zdr"  the endpoint is not zero-data-retention (may retain and/or
 *              train on request data). Model is hidden.
 * - "training" collected data may be used to improve the model. Model is hidden.
 * - "unknown"  no published policy found. Hidden by default (strict),
 *              configurable via plugin options.
 */

export type Retention = "zero" | "30d" | "not-zdr" | "training" | "unknown"

export interface RetentionPolicy {
  /** Normalized model ID the policy applies to. */
  id: string
  /** Display name used in diagnostics. */
  name: string
  retention: Retention
  /** Human-readable justification, citing the source. */
  reason: string
}

export interface ResolvedRetention {
  retention: Retention
  reason: string
}

/** Providers that run inference locally; request data never leaves the machine. */
export const LOCAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "lm-studio",
  "llamacpp",
  "llama.cpp",
  "local",
  "local-gateway",
])

/**
 * Family rules applied when a model ID has no explicit policy entry.
 * Derived from the API-level exceptions on
 * https://opencode.ai/v2/docs/console/models#privacy and the Go privacy table.
 */
export const FAMILY_RULES: readonly { pattern: RegExp; retention: Retention; reason: string }[] = [
  { pattern: /^gpt-/, retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { pattern: /^claude-/, retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { pattern: /^grok-/, retention: "30d", reason: "xAI endpoints retain 30 days (console/go#privacy)" },
  { pattern: /^muse-/, retention: "not-zdr", reason: "Muse endpoints train on request data (console/go#privacy)" },
  { pattern: /^nemotron-/, retention: "not-zdr", reason: "NVIDIA trial endpoints log use (console/models#privacy)" },
  { pattern: /^mistral-/, retention: "zero", reason: "Mistral zero-data-retention policy (console/models#privacy)" },
]

/**
 * Bundled snapshot of the published privacy tables (retrieved 2026-10-31).
 *
 * Primary source — OpenCode Go privacy table
 * (https://opencode.ai/v2/docs/console/go#privacy, "Model training" /
 * "Data retention" columns), including its footnotes:
 * - Grok 4.7: ZDR would disable the stateful Responses API; table lists 30 days.
 * - GPT 6 Luna / GPT 5.6 Luna: abuse-monitoring logs retained up to 30 days.
 * - Claude Haiku 5.5: requests retained 30 days per Anthropic's Data Policies.
 * - DeepSeek (0 days*): zero retention, available only with the Global region.
 *
 * Secondary source — OpenCode Console privacy section
 * (https://opencode.ai/v2/docs/console/models#privacy): zero-retention baseline
 * plus exceptions (OpenAI APIs 30 days, Anthropic APIs 30 days, per-free-model
 * notes).
 *
 * This snapshot is ONLY used when the live fetch fails.
 */
export const SNAPSHOT_POLICIES: readonly RetentionPolicy[] = [
  // ---- OpenAI family: "OpenAI APIs: Requests are retained for 30 days" ----
  { id: "gpt-6-astra", name: "GPT 6 Astra", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-6-sol", name: "GPT 6 Sol", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-6-luna", name: "GPT 6 Luna", retention: "30d", reason: "Go privacy table: 30 days (abuse-monitoring logs up to 30 days)" },
  { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.6-terra", name: "GPT 5.6 Terra", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", retention: "30d", reason: "Go privacy table: 30 days (abuse-monitoring logs up to 30 days)" },
  { id: "gpt-5.5", name: "GPT 5.5", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.5-pro", name: "GPT 5.5 Pro", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.4", name: "GPT 5.4", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.4-pro", name: "GPT 5.4 Pro", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.4-mini", name: "GPT 5.4 Mini", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.4-nano", name: "GPT 5.4 Nano", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.3-codex", name: "GPT 5.3 Codex", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.2", name: "GPT 5.2", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.2-codex", name: "GPT 5.2 Codex", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.1", name: "GPT 5.1", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.1-codex", name: "GPT 5.1 Codex", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.1-codex-max", name: "GPT 5.1 Codex Max", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5.1-codex-mini", name: "GPT 5.1 Codex Mini", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5", name: "GPT 5", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5-codex", name: "GPT 5 Codex", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },
  { id: "gpt-5-nano", name: "GPT 5 Nano", retention: "30d", reason: "OpenAI APIs retain requests 30 days (console/models#privacy)" },

  // ---- Anthropic family: "Anthropic APIs: Requests are retained for 30 days" ----
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-fable-5", name: "Claude Fable 5", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-opus-5", name: "Claude Opus 5", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", retention: "30d", reason: "Go privacy table: 30 days (Anthropic Data Policies)" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", retention: "30d", reason: "Anthropic APIs retain requests 30 days (console/models#privacy)" },

  // ---- xAI Grok: Go privacy table lists 30 days ----
  { id: "grok-4.7", name: "Grok 4.7", retention: "30d", reason: "Go privacy table: 30 days (xAI ZDR caveat)" },
  { id: "grok-4.6", name: "Grok 4.6", retention: "30d", reason: "xAI endpoints retain 30 days (Go privacy table, Grok family)" },
  { id: "grok-4.5", name: "Grok 4.5", retention: "30d", reason: "xAI endpoints retain 30 days (Go privacy table, Grok family)" },
  { id: "grok-build-0.1", name: "Grok Build 0.1", retention: "30d", reason: "xAI endpoints retain 30 days (Go privacy table, Grok family)" },

  // ---- Mistral: zero-data-retention policy ----
  { id: "mistral-large-4", name: "Mistral Large 4", retention: "zero", reason: "Mistral zero-data-retention policy (console/models#privacy)" },

  // ---- Meta Muse: Go privacy table — "Not ZDR", training on request data ----
  { id: "muse-wonder-1.0", name: "Muse Wonder 1.0", retention: "not-zdr", reason: "Muse endpoints are not ZDR and train on request data (console/go#privacy)" },
  { id: "muse-spark-1.3", name: "Muse Spark 1.3", retention: "not-zdr", reason: "Muse endpoints are not ZDR and train on request data (console/go#privacy)" },
  { id: "muse-spark-1.2", name: "Muse Spark 1.2", retention: "not-zdr", reason: "Muse endpoints are not ZDR and train on request data (console/go#privacy)" },
  { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", retention: "not-zdr", reason: "Go privacy table: Not ZDR, model training: Yes" },
  { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", retention: "not-zdr", reason: "Go privacy table: Not ZDR, model training: Yes" },

  // ---- Google Gemini: zero-retention per Console privacy baseline ----
  { id: "gemini-4-argon", name: "Gemini 4 Argon", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", retention: "zero", reason: "Console privacy baseline: zero retention" },

  // ---- Zhipu GLM ----
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash / GLM-5.3-Flash", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "glm-5.3-flash-free", name: "GLM-5.3-Flash Free", retention: "zero", reason: "Console free models: zero-retention provider, no training" },
  { id: "glm-5.3", name: "GLM 5.3 / GLM-5.3", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "glm-5.2", name: "GLM 5.2 / GLM-5.2", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "glm-5.1", name: "GLM 5.1", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "glm-5", name: "GLM 5", retention: "zero", reason: "Console privacy baseline: zero retention" },

  // ---- Moonshot Kimi ----
  { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "kimi-k3", name: "Kimi K3", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "kimi-k2.6", name: "Kimi K2.6", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "kimi-k2.5", name: "Kimi K2.5", retention: "zero", reason: "Console privacy baseline: zero retention" },

  // ---- Alibaba Qwen ----
  { id: "qwen3.8-max", name: "Qwen3.8 Max", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "qwen3.8-flash", name: "Qwen3.8 Flash", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "qwen3.5-plus", name: "Qwen3.5 Plus", retention: "zero", reason: "Console privacy baseline: zero retention" },

  // ---- DeepSeek: Go privacy table — 0 days* (region: Global) ----
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", retention: "zero", reason: "Go privacy table: 0 days (region: Global)" },
  { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", retention: "zero", reason: "Console free models: zero-retention provider, no training" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", retention: "zero", reason: "Go privacy table: 0 days (region: Global)" },

  // ---- MiniMax ----
  { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "minimax-m3", name: "MiniMax M3", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "minimax-m2.7", name: "MiniMax M2.7", retention: "zero", reason: "Console privacy baseline: zero retention" },
  { id: "minimax-m2.5", name: "MiniMax M2.5", retention: "zero", reason: "Console privacy baseline: zero retention" },

  // ---- Xiaomi MiMo ----
  { id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "mimo-v2.5", name: "MiMo-V2.5", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free", retention: "training", reason: "Console free models: collected data may be used to improve the model" },

  // ---- LongCat / StepFun / Hy ----
  { id: "longcat-2.0", name: "LongCat-2.0", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "step-5-preview", name: "Step 5 Preview", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "hy4-preview", name: "Hy4 preview", retention: "zero", reason: "Go privacy table: 0 days" },
  { id: "hy3", name: "Hy3", retention: "zero", reason: "Go privacy table: 0 days" },

  // ---- Reflection Beam ----
  { id: "beam-free", name: "Beam Free", retention: "30d", reason: "Console free models + Go privacy table: retained 30 days for safety" },

  // ---- NVIDIA Nemotron free endpoints ----
  { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", retention: "not-zdr", reason: "NVIDIA trial endpoints log use for security and product improvement" },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", retention: "not-zdr", reason: "NVIDIA trial endpoints log use for security and product improvement" },
  { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free", retention: "not-zdr", reason: "NVIDIA trial endpoints log use for security and product improvement" },

  // ---- Stealth / free trial models with training or retention exceptions ----
  { id: "big-pickle", name: "Big Pickle", retention: "training", reason: "Console free models: collected data may be used to improve the model" },
  { id: "flint-40b-free", name: "Flint 40B Free", retention: "training", reason: "Console free models: training data use; data retained 30 days" },

  // ---- Iceman (Go) ----
  { id: "iceman-contributor-free", name: "Iceman Contributor Free", retention: "not-zdr", reason: "Go privacy table: Not ZDR, model training: Yes" },

  // ---- TypeSafe Jev: no exception listed; zero-retention baseline applies ----
  { id: "jev-1.13", name: "Jev 1.13", retention: "zero", reason: "Console privacy baseline: zero retention (no exception listed)" },
  { id: "jev-1.13-free", name: "Jev 1.13 Free", retention: "zero", reason: "Console privacy baseline: zero retention (no exception listed)" },
]

function normalize(id: string): string {
  return id.trim().toLowerCase()
}

/** Convert a list of policies into a lookup map keyed by normalized model ID. */
export function toPolicyMap(policies: readonly RetentionPolicy[]): Map<string, RetentionPolicy> {
  const map = new Map<string, RetentionPolicy>()
  for (const policy of policies) map.set(normalize(policy.id), policy)
  return map
}

/**
 * Resolve the data-retention policy for a model ID (any provider).
 *
 * Order: explicit per-model policy (live data first, snapshot for gaps), then
 * family rules, then "unknown". Local providers always resolve to "zero":
 * request data never leaves the machine, so retention is trivially 0 days.
 */
export function resolveRetention(
  providerID: string,
  modelID: string,
  live?: ReadonlyMap<string, RetentionPolicy>,
): ResolvedRetention {
  if (LOCAL_PROVIDERS.has(normalize(providerID))) {
    return { retention: "zero", reason: `local provider "${providerID}" keeps data on this machine` }
  }
  const id = normalize(modelID)
  const exact = live?.get(id) ?? SNAPSHOT_BY_ID.get(id)
  if (exact) return { retention: exact.retention, reason: exact.reason }
  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(id)) return { retention: rule.retention, reason: rule.reason }
  }
  return { retention: "unknown", reason: `no published retention policy for "${modelID}" (console/go#privacy)` }
}

/** Whether a model with this policy may appear in the model list. */
export function isAllowed(policy: ResolvedRetention, showUnknown: boolean): boolean {
  if (policy.retention === "zero") return true
  if (policy.retention === "unknown") return showUnknown
  return false
}

export const SNAPSHOT_BY_ID: ReadonlyMap<string, RetentionPolicy> = toPolicyMap(SNAPSHOT_POLICIES)
