/**
 * opencode-zero-retention-models
 *
 * Filters the model list shown by `/models` (and available to sessions) so that
 * only models whose published data-retention policy is 0 days remain. Policies
 * are fetched live from the OpenCode documentation and cached:
 *
 *   https://opencode.ai/v2/docs/console/go#privacy
 *   https://opencode.ai/v2/docs/console/models#privacy
 *
 * Startup is fail-safe and non-blocking: the transform is registered from the
 * bundled snapshot before any storage/network await, cached/live data is applied
 * in the background, and storage/network errors never remove the filter.
 */

import { Plugin } from "@opencode/plugin"
import {
  CACHE_KEY,
  CACHE_VERSION,
  buildActivePolicyMap,
  mergeProviderData,
  parseCachedPayload,
  policyFingerprint,
  toStorageJson,
  type CachedPayload,
  type CachedProvider,
} from "./cache.ts"
import { fetchRetentionPolicies } from "./fetch.ts"
import { validateOptions } from "./options.ts"
import {
  isAllowed,
  resolveRetention,
  snapshotPolicyMap,
  type PolicyMap,
  type ResolveOptions,
} from "./retention.ts"

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
