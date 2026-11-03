/**
 * Policy cache: storage serialization, validation, and provider-scoped merging.
 *
 * The cache is advisory. Invalid entries are ignored rather than thrown, and
 * the bundled snapshot stays active until complete live data replaces it.
 */

import { type ProviderFetchResult } from "./fetch.ts"
import {
  snapshotPolicyMap,
  toPolicyMap,
  type PolicyMap,
  type Retention,
  type ScopedPolicy,
} from "./retention.ts"

export const CACHE_KEY = "policies/v2"
export const CACHE_VERSION = 2
export const CACHE_MAX_AGE_MS = 30 * 86_400_000

export interface CachedProvider {
  providerID: string
  policies: ScopedPolicy[]
  source: string
  fetchedAt: string
  complete: boolean
}

export interface CachedPayload {
  version: number
  providers: Record<string, CachedProvider>
  fetchedAt: string
}

const RETENTIONS: readonly Retention[] = ["zero", "30d", "not-zdr", "training", "unknown"]

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

function normalizedID(value: string): string {
  return value.trim().toLowerCase()
}

function isCachedProvider(value: unknown, key: string, now: number): value is CachedProvider {
  if (!isRecord(value)) return false
  if (
    typeof value.providerID !== "string" ||
    normalizedID(value.providerID) !== normalizedID(key) ||
    typeof value.source !== "string" ||
    value.source.trim().length === 0 ||
    typeof value.fetchedAt !== "string" ||
    value.complete !== true ||
    !Array.isArray(value.policies) ||
    value.policies.length === 0
  ) {
    return false
  }
  const fetched = Date.parse(value.fetchedAt)
  // Future timestamps would stay "fresh" forever; old ones must not pin policies.
  if (!Number.isFinite(fetched) || fetched > now || now - fetched > CACHE_MAX_AGE_MS) return false
  const providerID = normalizedID(value.providerID)
  // Provider/model identity must match the entry key; cache data cannot smuggle
  // another provider's policy into the active map.
  return value.policies.every(
    (policy) => isScopedPolicy(policy) && normalizedID(policy.providerID) === providerID,
  )
}

/**
 * Validate a cached payload. Corrupt/future/too-old caches are ignored (the
 * snapshot remains active), never thrown. Individual stale/corrupt provider
 * entries are skipped so a successful provider is still usable.
 */
export function parseCachedPayload(raw: unknown, now = Date.now()): CachedPayload | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.version !== CACHE_VERSION) return undefined
  if (typeof raw.fetchedAt !== "string") return undefined
  const fetched = Date.parse(raw.fetchedAt)
  if (!Number.isFinite(fetched) || fetched > now) return undefined
  if (now - fetched > CACHE_MAX_AGE_MS) return undefined
  if (!isRecord(raw.providers)) return undefined
  const providers: Record<string, CachedProvider> = {}
  for (const [key, value] of Object.entries(raw.providers)) {
    if (!isCachedProvider(value, key, now)) continue
    providers[normalizedID(key)] = value
  }
  if (Object.keys(providers).length === 0) return undefined
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

export function mergeProviderData(
  previous: Record<string, CachedProvider>,
  next: Record<string, ProviderFetchResult>,
): Record<string, CachedProvider> {
  const merged = { ...previous }
  for (const [providerID, result] of Object.entries(next)) {
    // Incomplete/empty parses never replace last-known-good provider data.
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
    } else {
      // The Go privacy table is exhaustive. Models absent from a complete live
      // table must not inherit a stale snapshot zero. Other configured providers
      // have no Console baseline, so their complete live table replaces it too.
      active.set(providerID, live.get(providerID) ?? new Map())
    }
  }
  return active
}

export function policyFingerprint(map: PolicyMap): string {
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

export function toStorageJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}
