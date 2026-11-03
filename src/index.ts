/**
 * opencode-zero-retention-models
 *
 * Filters the model list shown by `/models` (and available to sessions) so that
 * only models whose published data-retention policy is 0 days remain.
 *
 * Policies are fetched LIVE from the OpenCode documentation and cached:
 *
 *   https://opencode.ai/v2/docs/console/go#privacy
 *   https://opencode.ai/v2/docs/console/models#privacy
 *
 * Startup is fail-safe and non-blocking:
 *   1. The model transform is registered immediately with the bundled snapshot.
 *   2. Cached data is applied in the background (and the list reloaded if it
 *      changes the allow-list).
 *   3. Stale/missing cache triggers a background fetch; fresh data reloads the
 *      list when it lands. Storage/network errors never remove the filter.
 *
 * Options (set in opencode.jsonc under `plugins`):
 *   - showUnknown: boolean   also list scoped models with no published policy
 *                            (default false — strict: unknown is not "0 days")
 *   - refreshHours: number   cache TTL / refresh interval (default 12,
 *                            clamped to 1..596 hours)
 *   - providers: string[]    providers to filter (default
 *                            ["opencode", "opencode-go"]); other providers are
 *                            left untouched
 *   - verifiedZdr: {providerID, modelID}[]  user attestations for a confirmed
 *                            Mistral/other ZDR agreement. Never auto-detected.
 */

import { Plugin } from "@opencode/plugin"
import { fetchRetentionPolicies, type ProviderFetchResult } from "./fetch.ts"
import {
  DEFAULT_PROVIDERS,
  isAllowed,
  resolveRetention,
  snapshotPolicyMap,
  toPolicyMap,
  type PolicyMap,
  type ResolveOptions,
  type Retention,
  type ScopedPolicy,
} from "./retention.ts"

const CACHE_KEY = "policies/v2"
const CACHE_VERSION = 2
const CACHE_MAX_AGE_MS = 30 * 86_400_000
const MIN_REFRESH_HOURS = 1
const MAX_REFRESH_HOURS = 596

interface Options {
  showUnknown?: boolean
  refreshHours?: number
  providers?: string[]
  verifiedZdr?: { providerID: string; modelID: string }[]
}

export interface ValidatedOptions {
  showUnknown: boolean
  refreshHours: number
  providers: string[]
  verifiedZdr: { providerID: string; modelID: string }[]
}

interface CachedProvider {
  providerID: string
  policies: ScopedPolicy[]
  source: string
  fetchedAt: string
  complete: boolean
}

interface CachedPayload {
  version: number
  providers: Record<string, CachedProvider>
  fetchedAt: string
}

const RETENTIONS: readonly Retention[] = ["zero", "30d", "not-zdr", "training", "unknown"]

/** Clamp a user-supplied refresh interval into Node's safe timer range. */
export function clampRefreshHours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 12
  return Math.min(MAX_REFRESH_HOURS, Math.max(MIN_REFRESH_HOURS, value))
}

/** Validate plugin options once; invalid values fall back with a warning. */
export function validateOptions(raw: unknown): ValidatedOptions {
  const options = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const warnings: string[] = []

  let showUnknown = false
  if (options.showUnknown !== undefined) {
    if (typeof options.showUnknown === "boolean") showUnknown = options.showUnknown
    else warnings.push(`showUnknown must be a boolean; ignoring ${JSON.stringify(options.showUnknown)}`)
  }

  let refreshHours = 12
  if (options.refreshHours !== undefined) {
    const value = options.refreshHours
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      refreshHours = clampRefreshHours(value)
    } else {
      warnings.push(`refreshHours must be a finite positive number; using 12`)
    }
  }

  let providers = [...DEFAULT_PROVIDERS]
  if (options.providers !== undefined) {
    const value = options.providers
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === "string" && item.trim().length > 0)
    ) {
      providers = [...new Set(value.map((item) => (item as string).trim().toLowerCase()))]
    } else {
      warnings.push(`providers must be a non-empty string array; using ${JSON.stringify(DEFAULT_PROVIDERS)}`)
    }
  }

  let verifiedZdr: { providerID: string; modelID: string }[] = []
  if (options.verifiedZdr !== undefined) {
    const value = options.verifiedZdr
    if (Array.isArray(value)) {
      verifiedZdr = value.filter(
        (item): item is { providerID: string; modelID: string } =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).providerID === "string" &&
          typeof (item as Record<string, unknown>).modelID === "string",
      )
      if (verifiedZdr.length !== value.length) {
        warnings.push("verifiedZdr entries must be {providerID, modelID} strings; invalid entries ignored")
      }
    } else {
      warnings.push("verifiedZdr must be an array; ignoring")
    }
  }

  if (warnings.length > 0) {
    console.warn(`[zero-retention-models] ${warnings.join("; ")}`)
  }
  return { showUnknown, refreshHours, providers, verifiedZdr }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isScopedPolicy(value: unknown): value is ScopedPolicy {
  if (!isRecord(value)) return false
  return (
    typeof value.providerID === "string" &&
    typeof value.modelID === "string" &&
    typeof value.name === "string" &&
    typeof value.reason === "string" &&
    typeof value.retention === "string" &&
    RETENTIONS.includes(value.retention as Retention)
  )
}

function isCachedProvider(value: unknown): value is CachedProvider {
  if (!isRecord(value)) return false
  return (
    typeof value.providerID === "string" &&
    typeof value.source === "string" &&
    typeof value.fetchedAt === "string" &&
    Number.isFinite(Date.parse(value.fetchedAt)) &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.policies) &&
    value.policies.every(isScopedPolicy)
  )
}

/**
 * Validate a cached payload. Corrupt/future/too-old caches are ignored (the
 * snapshot remains active), never thrown.
 */
export function parseCachedPayload(raw: unknown, now = Date.now()): CachedPayload | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.version !== CACHE_VERSION) return undefined
  if (typeof raw.fetchedAt !== "string") return undefined
  const fetched = Date.parse(raw.fetchedAt)
  if (!Number.isFinite(fetched) || fetched > now + 5 * 60_000) return undefined
  if (now - fetched > CACHE_MAX_AGE_MS) return undefined
  if (!isRecord(raw.providers)) return undefined
  const providers: Record<string, CachedProvider> = {}
  for (const [key, value] of Object.entries(raw.providers)) {
    if (!isCachedProvider(value)) return undefined
    providers[key] = value
  }
  return { version: CACHE_VERSION, providers, fetchedAt: raw.fetchedAt }
}

function providerCacheFrom(result: ProviderFetchResult): CachedProvider {
  return {
    providerID: result.providerID,
    policies: result.policies,
    source: result.source,
    fetchedAt: result.fetchedAt,
    complete: result.complete,
  }
}

function mergeProviderData(
  previous: Record<string, CachedProvider>,
  next: Record<string, ProviderFetchResult>,
): Record<string, CachedProvider> {
  const merged = { ...previous }
  for (const [providerID, result] of Object.entries(next)) {
    if (result.complete && result.policies.length > 0) {
      merged[providerID] = providerCacheFrom(result)
    }
  }
  return merged
}

/**
 * Build the active policy map:
 * - Console (`opencode`): snapshot baseline overlaid with live exceptions.
 * - Go (`opencode-go`): a complete live table is exhaustive; otherwise snapshot.
 * - Other configured providers: live if complete, snapshot otherwise.
 */
export function buildActivePolicyMap(
  providers: Record<string, CachedProvider> | undefined,
  snapshot: PolicyMap = snapshotPolicyMap(),
): PolicyMap {
  let active: PolicyMap = new Map()
  for (const [providerID, policies] of snapshot) {
    active.set(providerID, new Map(policies))
  }
  for (const [providerID, provider] of Object.entries(providers ?? {})) {
    if (!provider.complete || provider.policies.length === 0) continue
    const live = toPolicyMap(provider.policies)
    if (providerID === "opencode") {
      // Console docs state a baseline + exceptions, so keep snapshot baseline
      // entries and let live exceptions override them.
      const base = active.get(providerID) ?? new Map<string, ScopedPolicy>()
      const merged = new Map(base)
      for (const [key, policy] of live.get(providerID) ?? []) merged.set(key, policy)
      active.set(providerID, merged)
    } else if (providerID === "opencode-go") {
      // The Go privacy table is exhaustive. Models absent from a complete
      // live table must not inherit a stale snapshot zero.
      active.set(providerID, live.get(providerID) ?? new Map())
    } else {
      active.set(providerID, live.get(providerID) ?? new Map())
    }
  }
  return active
}

function policyFingerprint(map: PolicyMap): string {
  const parts: string[] = []
  const providers = [...map.keys()].sort()
  for (const provider of providers) {
    const policies = [...(map.get(provider)?.entries() ?? [])].sort(([a], [b]) => a.localeCompare(b))
    for (const [key, policy] of policies) {
      parts.push(`${provider}/${key}=${policy.retention}@${policy.validUntil ?? ""}`)
    }
  }
  return parts.join("|")
}

function toStorageJson(value: unknown): Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0] extends never
  ? never
  : Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

export default Plugin.define({
  id: "zero-retention-models",
  async setup(ctx) {
    const options = validateOptions(ctx.options)
    const refreshMs = options.refreshHours * 3_600_000
    const resolveOptions: ResolveOptions = {
      providers: options.providers,
      verifiedZdr: options.verifiedZdr,
    }

    const snapshot = snapshotPolicyMap()
    let policies: PolicyMap = snapshot
    let providerData: Record<string, CachedProvider> = {}
    let lastFingerprint = policyFingerprint(policies)
    let disposed = false
    let inFlight: Promise<boolean> | undefined
    let abortController: AbortController | undefined
    let registration: Awaited<ReturnType<typeof ctx.model.transform>> | undefined

    // Register the filter BEFORE any storage/network await. The snapshot is
    // the safe default, so the user is never left unfiltered while loading.
    registration = await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        const policy = resolveRetention(model.providerID, model.id, policies, resolveOptions)
        if (!isAllowed(policy, options.showUnknown)) {
          editor.remove(model.providerID, model.id)
        }
      }
    })

    async function reloadIfChanged(next: PolicyMap): Promise<boolean> {
      const fingerprint = policyFingerprint(next)
      if (fingerprint === lastFingerprint) return false
      policies = next
      lastFingerprint = fingerprint
      if (!disposed) {
        try {
          await ctx.model.reload()
        } catch (error) {
          console.error("[zero-retention-models] model reload failed:", error)
        }
      }
      return true
    }

    async function readCache(): Promise<CachedPayload | undefined> {
      try {
        const raw = await ctx.storage.get(CACHE_KEY)
        const parsed = parseCachedPayload(raw)
        if (!parsed) {
          if (raw !== undefined) {
            console.warn("[zero-retention-models] ignoring invalid/stale policy cache")
          }
          return undefined
        }
        return parsed
      } catch (error) {
        console.error("[zero-retention-models] policy cache read failed:", error)
        return undefined
      }
    }

    async function writeCache(payload: CachedPayload): Promise<void> {
      if (disposed) return
      try {
        await ctx.storage.set(CACHE_KEY, toStorageJson(payload) as never)
      } catch (error) {
        // A cache write failure must not discard live data.
        console.error("[zero-retention-models] policy cache write failed:", error)
      }
    }

    async function load(force: boolean): Promise<boolean> {
      if (inFlight) return inFlight
      inFlight = (async () => {
        let changed = false
        let cached: CachedPayload | undefined
        try {
          cached = await readCache()
        } catch (error) {
          console.error("[zero-retention-models] cache load failed:", error)
        }

        if (cached && !force) {
          providerData = { ...cached.providers }
          const next = buildActivePolicyMap(providerData, snapshot)
          changed = (await reloadIfChanged(next)) || changed
          const ageHours = Math.max(0, (Date.now() - Date.parse(cached.fetchedAt)) / 3_600_000)
          console.log(
            `[zero-retention-models] using cached policies (${ageHours.toFixed(1)} h old, sources: ${
              Object.values(cached.providers)
                .filter((provider) => provider.complete)
                .map((provider) => provider.source)
                .join(", ") || "none"
            })`,
          )
          if (Date.now() - Date.parse(cached.fetchedAt) < refreshMs) {
            return changed
          }
        }

        if (disposed) return changed
        const controller = new AbortController()
        abortController = controller
        try {
          const result = await fetchRetentionPolicies(fetch, 10_000, controller.signal)
          if (disposed) return changed
          providerData = mergeProviderData(providerData, result.providers)
          const next = buildActivePolicyMap(providerData, snapshot)
          changed = (await reloadIfChanged(next)) || changed

          if (Object.values(result.providers).some((provider) => provider.complete)) {
            const payload: CachedPayload = {
              version: CACHE_VERSION,
              providers: providerData,
              fetchedAt: result.fetchedAt,
            }
            await writeCache(payload)
          }
          const sources = Object.values(result.providers)
            .filter((provider) => provider.complete)
            .map((provider) => provider.source)
          const failures = Object.values(result.providers)
            .filter((provider) => !provider.complete)
            .map((provider) => `${provider.providerID}: ${provider.error ?? "incomplete parse"}`)
          console.log(
            `[zero-retention-models] refreshed policies from ${sources.join(", ") || "snapshot (no live source)"}${
              failures.length > 0 ? `; failed: ${failures.join("; ")}` : ""
            }`,
          )
        } catch (error) {
          console.error("[zero-retention-models] live fetch failed; keeping last policy data:", error)
        } finally {
          if (abortController === controller) abortController = undefined
        }
        return changed
      })().finally(() => {
        inFlight = undefined
      })
      return inFlight
    }

    // Background hydration/refresh: setup has already registered the filter.
    void load(false).catch((error) => {
      console.error("[zero-retention-models] background policy load failed:", error)
    })

    // Policies can change daily: refresh while the session is open. The timer
    // is clamped and an in-flight guard prevents overlapping fetches.
    const timer = setInterval(() => {
      void load(true).catch((error) => {
        console.error("[zero-retention-models] refresh failed:", error)
      })
    }, refreshMs)
    timer.unref?.()

    return async () => {
      disposed = true
      clearInterval(timer)
      abortController?.abort()
      try {
        await registration?.dispose()
      } catch {
        // Best-effort cleanup.
      }
    }
  },
})
