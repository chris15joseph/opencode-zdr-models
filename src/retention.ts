/**
 * Data-retention policy model for OpenCode Console and OpenCode Go models.
 *
 * LIVE DATA: `fetch.ts` downloads and parses the privacy tables from
 * https://opencode.ai/v2/docs/console/go#privacy and
 * https://opencode.ai/v2/docs/console/models#privacy. This module contains the
 * types, the pure resolution logic, and a bundled snapshot used only when live
 * data and the cache are unavailable.
 *
 * Policies are SCOPED BY PROVIDER. The OpenCode Console docs describe the
 * `opencode` provider; the Go docs describe `opencode-go`. Other providers are
 * untouched by default because there is no evidence that these policies apply
 * to them. See `DEFAULT_PROVIDERS`.
 *
 * Retention statuses:
 * - "zero"     data retention is 0 days (zero data retention). Model is listed.
 * - "30d"      requests are retained for 30 days. Model is hidden.
 * - "not-zdr"  the endpoint is not zero-data-retention (may retain and/or
 *              train on request data). Model is hidden.
 * - "training" collected data may be used to improve the model. Model is hidden.
 * - "unknown"  no published/usable policy found. Hidden by default (strict),
 *              configurable via `showUnknown`.
 */

export type Retention = "zero" | "30d" | "not-zdr" | "training" | "unknown"

/** A policy bound to one provider/model pair. */
export interface ScopedPolicy {
  providerID: string
  modelID: string
  name: string
  retention: Retention
  /** Human-readable justification quoting the source cells/bullet. */
  reason: string
  /** "live" or "snapshot". Used for freshness/diagnostic decisions. */
  source?: "live" | "snapshot"
  /** ISO timestamp/date after which a conditional zero policy is void. */
  validUntil?: string
  /** Extra published conditions (region, agreement, footnote text). */
  conditions?: string
  /**
   * Optional API-family wildcard. When set, `modelID` is "*" and the policy
   * applies to model IDs starting with `<family>-` (or equal to `<family>`).
   */
  family?: string
}

/** provider -> normalized model ID (or `family:<family>`) -> policy. */
export type PolicyMap = Map<string, Map<string, ScopedPolicy>>

export interface ResolvedRetention {
  retention: Retention
  reason: string
  /**
   * False when this provider is outside the configured scope (or is a local
   * provider). Unscoped models are always allowed through untouched.
   */
  scoped: boolean
  policy?: ScopedPolicy
}

export interface ResolveOptions {
  /** Providers this plugin filters. Defaults to Console + Go. */
  providers?: readonly string[]
  /** User attestations that a specific provider/model has a ZDR agreement. */
  verifiedZdr?: readonly { providerID: string; modelID: string }[]
  /** Injectable clock for tests. */
  now?: number
}

export const DEFAULT_PROVIDERS: readonly string[] = ["opencode", "opencode-go"]

/** Bundled snapshot capture date (ISO). */
export const SNAPSHOT_CAPTURED_AT = "2026-10-31"

/**
 * Snapshot entries older than this are not trusted to permit a model. They
 * still hide models (the safe direction), but a stale `zero` becomes `unknown`.
 */
export const SNAPSHOT_MAX_AGE_DAYS = 30

/**
 * Explicit local-provider allowlist.
 *
 * Locality is an assumption about the endpoint, not a security guarantee: a
 * provider named `local` can point at a remote base URL. Only well-known local
 * runtimes are listed here, and the README documents the assumption. Aliases
 * with underscores/hyphens are included because provider IDs are user-defined.
 * Deliberately excluded: `local` and `local-gateway` are arbitrary names and
 * can be configured with a remote base URL.
 */
export const LOCAL_PROVIDERS = new Set([
  "ollama",
  "ollama-local",
  "ollama_local",
  "lmstudio",
  "lm-studio",
  "lm_studio",
  "llamacpp",
  "llama.cpp",
  "llama_cpp",
  "vllm",
  "mlx",
  "localai",
  "jan",
  "koboldcpp",
])

/**
 * Family rules applied when no explicit provider-scoped policy exists.
 *
 * These encode documented API-level exceptions only. Rules are provider
 * scoped so an OpenCode policy cannot leak to OpenRouter or a custom gateway.
 */
export const FAMILY_RULES: readonly {
  providers: readonly string[]
  pattern: RegExp
  retention: Retention
  reason: string
}[] = [
  {
    providers: ["opencode", "opencode-go"],
    pattern: /^gpt-/,
    retention: "30d",
    reason: "OpenAI APIs retain requests for 30 days (console/models#privacy, console/go#privacy)",
  },
  {
    providers: ["opencode", "opencode-go"],
    pattern: /^claude-/,
    retention: "30d",
    reason: "Anthropic APIs retain requests for 30 days (console/models#privacy, console/go#privacy)",
  },
  {
    providers: ["opencode-go"],
    pattern: /^grok-/,
    retention: "30d",
    reason: "Go privacy table: xAI requests retained 30 days (ZDR would disable the Responses API)",
  },
  {
    providers: ["opencode-go"],
    pattern: /^muse-/,
    retention: "not-zdr",
    reason: "Go privacy table: Muse contributor endpoints are Not ZDR and train on request data",
  },
  {
    providers: ["opencode"],
    pattern: /^mistral-/,
    retention: "not-zdr",
    reason:
      "Console privacy exception: Mistral inputs are not used for training, but data is retained under Mistral's Data Retention Policy; ZDR requires an opt-in/verified agreement",
  },
  {
    providers: ["opencode"],
    pattern: /^nemotron-/,
    retention: "not-zdr",
    reason: "Console privacy: NVIDIA free endpoints are trial-only and log use for security/product improvement",
  },
]

const RETENTION_RANK: Record<Retention, number> = {
  zero: 0,
  "30d": 1,
  "not-zdr": 2,
  training: 3,
  unknown: 4,
}

/** Return the more restrictive of two retention signals. */
export function worstRetention(...values: (Retention | undefined)[]): Retention | undefined {
  let worst: Retention | undefined
  for (const value of values) {
    if (!value) continue
    if (!worst || RETENTION_RANK[value] > RETENTION_RANK[worst]) worst = value
  }
  return worst
}

export function normalizeID(id: string): string {
  return id.trim().toLowerCase()
}

function policyKey(policy: ScopedPolicy): string {
  return policy.family ? `family:${policy.family.toLowerCase()}` : normalizeID(policy.modelID)
}

function generatedSource(policy: ScopedPolicy): "live" | "snapshot" {
  return policy.source ?? (policy.reason.includes("snapshot") ? "snapshot" : "live")
}

/** Convert a list of policies into a provider-scoped lookup map. */
export function toPolicyMap(policies: readonly ScopedPolicy[]): PolicyMap {
  const map: PolicyMap = new Map()
  for (const input of policies) {
    const policy: ScopedPolicy = {
      ...input,
      providerID: normalizeID(input.providerID),
      modelID: input.family ? "*" : normalizeID(input.modelID),
      source: generatedSource(input),
    }
    const providerKey = policy.providerID
    let providerMap = map.get(providerKey)
    if (!providerMap) {
      providerMap = new Map()
      map.set(providerKey, providerMap)
    }
    const key = policyKey(policy)
    const existing = providerMap.get(key)
    // Conflicting duplicate rows fail closed: keep the worst signal.
    const retention = existing
      ? (worstRetention(existing.retention, policy.retention) ?? policy.retention)
      : policy.retention
    if (!existing || retention !== existing.retention) {
      providerMap.set(key, { ...(existing ?? policy), ...policy, retention })
    }
  }
  return map
}

/** Merge two policy maps; `overlay` wins for the same provider/model key. */
export function mergePolicyMaps(base: PolicyMap, overlay: PolicyMap): PolicyMap {
  const out: PolicyMap = new Map()
  for (const [provider, policies] of base) out.set(provider, new Map(policies))
  for (const [provider, policies] of overlay) {
    const target = out.get(provider) ?? new Map<string, ScopedPolicy>()
    for (const [key, policy] of policies) target.set(key, policy)
    out.set(provider, target)
  }
  return out
}

/** Build the bundled snapshot map (Console + Go kept separate). */
export function snapshotPolicyMap(): PolicyMap {
  return toPolicyMap([...CONSOLE_POLICIES, ...GO_POLICIES])
}

/** Whether the bundled snapshot is still within its freshness window. */
export function snapshotIsFresh(now = Date.now()): boolean {
  const captured = Date.parse(SNAPSHOT_CAPTURED_AT)
  return Number.isFinite(captured) && now - captured <= SNAPSHOT_MAX_AGE_DAYS * 86_400_000
}

function expired(policy: ScopedPolicy, now: number): boolean {
  if (!policy.validUntil) return false
  const until = Date.parse(policy.validUntil)
  return !Number.isFinite(until) || until < now
}

function staleSnapshotZero(policy: ScopedPolicy, now: number): boolean {
  return policy.source === "snapshot" && policy.retention === "zero" && !snapshotIsFresh(now)
}

function findPolicy(
  providerMap: ReadonlyMap<string, ScopedPolicy> | undefined,
  modelID: string,
) {
  if (!providerMap) return undefined
  const id = normalizeID(modelID)
  const exact = providerMap.get(id)
  if (exact) return exact
  for (const policy of providerMap.values()) {
    if (!policy.family) continue
    if (id === policy.family || id.startsWith(`${policy.family}-`)) return policy
  }
  return undefined
}

/**
 * Resolve the data-retention policy for one provider/model pair.
 *
 * Order:
 *   1. Provider scope: providers outside `options.providers` are untouched.
 *   2. Local providers are untouched (request data stays on the machine).
 *   3. User-attested `verifiedZdr` entries resolve to zero.
 *   4. Provider-scoped live/snapshot policy (exact, then API-family wildcard).
 *   5. Provider-scoped family rules.
 *   6. "unknown" (hidden unless `showUnknown`).
 */
export function resolveRetention(
  providerID: string,
  modelID: string,
  policies?: PolicyMap,
  options: ResolveOptions = {},
): ResolvedRetention {
  const provider = normalizeID(providerID)
  const providers = (options.providers ?? DEFAULT_PROVIDERS).map(normalizeID)
  if (!providers.includes(provider)) {
    return {
      retention: "unknown",
      scoped: false,
      reason: `provider "${providerID}" is not in the configured provider scope; left untouched`,
    }
  }
  if (LOCAL_PROVIDERS.has(provider)) {
    return {
      retention: "zero",
      scoped: false,
      reason: `local provider "${providerID}" is assumed to keep request data on this machine`,
    }
  }

  const verified = options.verifiedZdr?.find(
    (entry) =>
      normalizeID(entry.providerID) === provider && normalizeID(entry.modelID) === normalizeID(modelID),
  )
  if (verified) {
    return {
      retention: "zero",
      scoped: true,
      reason:
        "user-attested verified ZDR agreement (`verifiedZdr`); not auto-detected from provider or docs",
    }
  }

  const now = options.now ?? Date.now()
  const policySource = policies ?? SNAPSHOT_BY_PROVIDER
  const policy = findPolicy(policySource.get(provider), modelID)
  if (policy) {
    if (expired(policy, now)) {
      return {
        retention: "unknown",
        scoped: true,
        policy,
        reason: `published policy expired${policy.validUntil ? ` on ${policy.validUntil}` : ""}: ${policy.reason}`,
      }
    }
    if (staleSnapshotZero(policy, now)) {
      return {
        retention: "unknown",
        scoped: true,
        policy,
        reason: `bundled snapshot is older than ${SNAPSHOT_MAX_AGE_DAYS} days; refusing to reuse a stale zero: ${policy.reason}`,
      }
    }
    return { retention: policy.retention, scoped: true, policy, reason: policy.reason }
  }

  const id = normalizeID(modelID)
  for (const rule of FAMILY_RULES) {
    if (!rule.providers.map(normalizeID).includes(provider)) continue
    if (rule.pattern.test(id)) {
      return { retention: rule.retention, scoped: true, reason: rule.reason }
    }
  }

  return {
    retention: "unknown",
    scoped: true,
    reason: `no published retention policy for "${modelID}" on "${providerID}" (console/go#privacy)`,
  }
}

/** Whether a model with this policy may appear in the model list. */
export function isAllowed(policy: ResolvedRetention, showUnknown: boolean): boolean {
  // Only an explicit out-of-scope/local marker bypasses filtering.
  if (policy.scoped === false) return true
  if (policy.retention === "zero") return true
  if (policy.retention === "unknown") return showUnknown === true
  return false
}

// ---------------------------------------------------------------------------
// Bundled snapshot
// ---------------------------------------------------------------------------

function consolePolicy(
  modelID: string,
  name: string,
  retention: Retention,
  reason: string,
  extra: Partial<ScopedPolicy> = {},
): ScopedPolicy {
  return {
    providerID: "opencode",
    modelID,
    name,
    retention,
    reason,
    source: "snapshot",
    ...extra,
  }
}

function goPolicy(
  modelID: string,
  name: string,
  retention: Retention,
  reason: string,
  extra: Partial<ScopedPolicy> = {},
): ScopedPolicy {
  return {
    providerID: "opencode-go",
    modelID,
    name,
    retention,
    reason,
    source: "snapshot",
    ...extra,
  }
}

const CONSOLE_CAPTURED = `snapshot ${SNAPSHOT_CAPTURED_AT} (console/models#privacy)`
const GO_CAPTURED = `snapshot ${SNAPSHOT_CAPTURED_AT} (console/go#privacy)`

/**
 * OpenCode Console snapshot.
 *
 * Console privacy baseline (re-verified 2026-11-02): "All our models ... follow
 * a zero-retention policy and do not use your data for model training, with the
 * following exceptions:". Models not named in that exception list (including
 * Grok and the non-contributor Muse models) are therefore baseline zero. The
 * exceptions below are copied from the live bullets, including the newer
 * Pulse Alpha Free training bullet.
 */
export const CONSOLE_POLICIES: readonly ScopedPolicy[] = [
  // OpenAI / Anthropic API exceptions.
  ...["gpt-6-astra","gpt-6-sol","gpt-6.1-sol","gpt-6-luna","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","gpt-5.5-pro","gpt-5.4","gpt-5.4-pro","gpt-5.4-mini","gpt-5.4-nano","gpt-5.3-codex","gpt-5.3-codex-spark","gpt-5.2","gpt-5.2-codex","gpt-5.1","gpt-5.1-codex","gpt-5.1-codex-max","gpt-5.1-codex-mini","gpt-5","gpt-5-codex","gpt-5-nano"].map((id) =>
    consolePolicy(id, id, "30d", `OpenAI API exception, 30 days (${CONSOLE_CAPTURED})`),
  ),
  ...["claude-fable-5-1","claude-fable-5","claude-opus-5-5","claude-opus-5","claude-opus-4-8","claude-opus-4-7","claude-opus-4-6","claude-opus-4-5","claude-sonnet-5-5","claude-sonnet-5","claude-sonnet-4-6","claude-sonnet-4-5","claude-haiku-5-5","claude-haiku-4-5"].map((id) =>
    consolePolicy(id, id, "30d", `Anthropic API exception, 30 days (${CONSOLE_CAPTURED})`),
  ),

  // Mistral is an explicit exception. ZDR is opt-in/paid and requires a
  // verified agreement; never infer it from a docs link.
  consolePolicy(
    "mistral-large-4",
    "Mistral Large 4",
    "not-zdr",
    `Console privacy exception: Mistral inputs are not used for training, but data is retained under Mistral's Data Retention Policy; ZDR requires an opt-in/verified agreement (${CONSOLE_CAPTURED})`,
  ),

  // Baseline-zero catalog models.
  ...["gemini-4-argon","gemini-3.8-flash","gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash","gemini-3.5-flash-lite","gemini-3.1-pro","gemini-3-flash","glm-5.3-flash","glm-5.3-flash-free","glm-5.3","glm-5.2","glm-5.1","glm-5","kimi-k3.1-pro","kimi-k3","kimi-k2.7-code","kimi-k2.6","kimi-k2.5","qwen3.8-max","qwen3.8-flash","qwen3.7-plus","qwen3.6-plus","qwen3.5-plus","minimax-m3.1-flash","minimax-m3","minimax-m2.7","minimax-m2.5","mimo-v2.6-pro","mimo-v2.6-flash","mimo-v2.5-pro","mimo-v2.5","longcat-2.0","step-5-preview","hy4-preview","hy3","jev-1.13","jev-1.13-free"].map((id) =>
    consolePolicy(id, id, "zero", `Console privacy baseline: zero retention, no training exception listed (${CONSOLE_CAPTURED})`),
  ),

  // Console baseline zero for Grok and non-contributor Muse models. Re-verified
  // against the live exception list on 2026-11-02: neither appears there.
  ...["grok-4.7","grok-4.6","grok-4.5","grok-build-0.1"].map((id) =>
    consolePolicy(id, id, "zero", `Console privacy baseline: zero retention; no Grok exception is listed for Console (${CONSOLE_CAPTURED}, re-verified 2026-11-02)`),
  ),
  ...["muse-wonder-1.0","muse-spark-1.3","muse-spark-1.2"].map((id) =>
    consolePolicy(id, id, "zero", `Console privacy baseline: zero retention; only the Go contributor variants are Not ZDR (${CONSOLE_CAPTURED}, re-verified 2026-11-02)`),
  ),

  // DeepSeek Console baseline (free Console model and any Console exposure).
  consolePolicy("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "zero", `Console privacy baseline: zero retention (${CONSOLE_CAPTURED}); Go footnote requires the Global region and a current ZDR agreement`, { conditions: "Global region; ZDR agreement must be current" }),
  consolePolicy("deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash Free", "zero", `Console free model: zero-retention provider, no training (${CONSOLE_CAPTURED})`),
  consolePolicy("deepseek-v4-pro", "DeepSeek V4 Pro", "zero", `Console privacy baseline: zero retention (${CONSOLE_CAPTURED}); Go footnote requires the Global region and a current ZDR agreement`, { conditions: "Global region; ZDR agreement must be current" }),

  // Console exceptions with training.
  consolePolicy("big-pickle", "Big Pickle", "training", `Console free-model exception: collected data may be used to improve the model (${CONSOLE_CAPTURED})`),
  consolePolicy("pulse-alpha-free", "Pulse Alpha Free", "training", `Console free-model exception: collected data may be retained and used to improve the model (${CONSOLE_CAPTURED}; live re-check 2026-11-02)`),
  consolePolicy("flint-40b-free", "Flint 40B Free", "training", `Console free-model exception: training plus 30-day retention; training dominates (${CONSOLE_CAPTURED})`),
  consolePolicy("mimo-v2.6-flash-free", "MiMo-V2.6-Flash Free", "training", `Console free-model exception: collected data may be used to improve the model (${CONSOLE_CAPTURED})`),

  // NVIDIA trial endpoints.
  ...["nemotron-3-ultra-free","nemotron-3.5-lightning-free","nemotron-3.5-super-vl-free"].map((id) =>
    consolePolicy(id, id, "not-zdr", `Console privacy exception: NVIDIA trial endpoint logs use for security and product improvement (${CONSOLE_CAPTURED})`),
  ),

  // Beam Free: 30-day retention for safety.
  consolePolicy("beam-free", "Beam Free", "30d", `Console privacy exception: retained for 30 days for safety reasons (${CONSOLE_CAPTURED})`),

  // Family-level Console exceptions, also usable when the catalog adds variants.
  consolePolicy("*", "OpenAI APIs", "30d", `Console privacy exception: OpenAI requests retained for 30 days (${CONSOLE_CAPTURED})`, { family: "gpt" }),
  consolePolicy("*", "Anthropic APIs", "30d", `Console privacy exception: Anthropic requests retained for 30 days (${CONSOLE_CAPTURED})`, { family: "claude" }),
  consolePolicy("*", "Mistral APIs", "not-zdr", `Console privacy exception: Mistral is not ZDR by default (${CONSOLE_CAPTURED})`, { family: "mistral" }),
]

/**
 * OpenCode Go snapshot. The Go privacy table is exhaustive: models absent from
 * a complete live table are treated as unknown (fail closed), not as zero.
 */
export const GO_POLICIES: readonly ScopedPolicy[] = [
  ...["grok-4.7","grok-4.6","grok-4.5","grok-build-0.1"].map((id) =>
    goPolicy(id, id, "30d", `Go privacy table: 30 days (${GO_CAPTURED})`),
  ),
  ...["gpt-6-luna","gpt-5.6-luna"].map((id) =>
    goPolicy(id, id, "30d", `Go privacy table: 30 days; abuse-monitoring logs retained up to 30 days (${GO_CAPTURED})`),
  ),
  goPolicy("claude-haiku-5-5", "Claude Haiku 5.5", "30d", `Go privacy table: 30 days per Anthropic's Data Policies (${GO_CAPTURED})`),
  ...["gemini-4-argon","glm-5.3-flash","glm-5.3","glm-5.2","kimi-k3.1-pro","kimi-k3","kimi-k2.7-code","longcat-2.0","mimo-v2.6-pro","mimo-v2.6-flash","mimo-v2.5-pro","mimo-v2.5","qwen3.8-max","qwen3.8-flash","qwen3.7-plus","minimax-m3.1-flash","minimax-m3","hy4-preview","hy3","step-5-preview"].map((id) =>
    goPolicy(id, id, "zero", `Go privacy table: 0 days, training not used (${GO_CAPTURED})`),
  ),
  goPolicy("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "zero", `Go privacy table: 0 days*; footnote requires the Global region and a current ZDR agreement valid through 2026-11-30 (${GO_CAPTURED})`, { validUntil: "2026-11-30", conditions: "Global region; ZDR agreement renewed monthly" }),
  goPolicy("deepseek-v4-pro", "DeepSeek V4 Pro", "zero", `Go privacy table: 0 days*; footnote requires the Global region and a current ZDR agreement valid through 2026-11-30 (${GO_CAPTURED})`, { validUntil: "2026-11-30", conditions: "Global region; ZDR agreement renewed monthly" }),
  goPolicy("muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", "not-zdr", `Go privacy table: Not ZDR; training=Yes (${GO_CAPTURED})`),
  goPolicy("muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", "not-zdr", `Go privacy table: Not ZDR; training=Yes (${GO_CAPTURED})`),
  goPolicy("iceman-contributor-free", "Iceman Contributor Free", "not-zdr", `Go privacy table: Not ZDR; training=Yes (${GO_CAPTURED})`),
  goPolicy("beam-free", "Beam Free", "30d", `Go privacy table: 30 days (${GO_CAPTURED})`),
]

/** Backwards-compatible combined snapshot list. */
export const SNAPSHOT_POLICIES: readonly ScopedPolicy[] = [...CONSOLE_POLICIES, ...GO_POLICIES]

/** Backwards-compatible map keyed by provider/model. */
export const SNAPSHOT_BY_PROVIDER: ReadonlyMap<string, ReadonlyMap<string, ScopedPolicy>> =
  snapshotPolicyMap()
