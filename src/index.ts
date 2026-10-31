/**
 * opencode-zero-retention-models
 *
 * Filters the model list shown by `/models` (and available to sessions) so that
 * only models whose published data-retention policy is 0 days remain.
 *
 * The retention policies are fetched LIVE from the OpenCode documentation
 * every time OpenCode loads this plugin — i.e. before a coding session starts —
 * because these policies can change at any time:
 *
 *   https://opencode.ai/v2/docs/console/go#privacy
 *   https://opencode.ai/v2/docs/console/models#privacy
 *
 * A cached copy is kept in plugin storage and refreshed periodically while the
 * session is open. When both the network and the cache are unavailable, the
 * bundled snapshot from `retention.ts` is used.
 *
 * Options (set in opencode.jsonc under `plugins`):
 *   - showUnknown: boolean   also list models with no published policy
 *                            (default false — strict: unknown is not "0 days")
 *   - refreshHours: number   cache TTL / refresh interval (default 12)
 */

import { Plugin } from "@opencode/plugin"
import { fetchRetentionPolicies, type FetchResult } from "./fetch.ts"
import {
  SNAPSHOT_POLICIES,
  isAllowed,
  resolveRetention,
  toPolicyMap,
  type RetentionPolicy,
} from "./retention.ts"

const CACHE_KEY = "policies/v1"

interface Options {
  showUnknown?: boolean
  refreshHours?: number
}

export default Plugin.define({
  id: "zero-retention-models",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const showUnknown = options.showUnknown === true
    const refreshMs = Math.max(1, options.refreshHours ?? 12) * 3_600_000

    let policies: ReadonlyMap<string, RetentionPolicy> = toPolicyMap(SNAPSHOT_POLICIES)

    async function load(force: boolean): Promise<void> {
      const cached = (await ctx.storage.get(CACHE_KEY)) as FetchResult | undefined
      const cacheFresh =
        cached !== undefined && Date.now() - Date.parse(cached.fetchedAt) < refreshMs
      if (cached && cacheFresh && !force) {
        policies = toPolicyMap(cached.policies)
        return
      }
      try {
        const result = await fetchRetentionPolicies()
        policies = toPolicyMap(result.policies)
        await ctx.storage.set(CACHE_KEY, result)
        console.log(
          `[zero-retention-models] loaded ${result.policies.length} retention policies from ${result.sources.join(", ") || "snapshot"}`,
        )
      } catch (error) {
        console.error("[zero-retention-models] live fetch failed:", error)
        if (cached) policies = toPolicyMap(cached.policies)
      }
    }

    // Fetch current policies up front: plugin setup runs while OpenCode loads
    // plugins for the session, i.e. before the coding session begins.
    await load(false)

    await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        const policy = resolveRetention(model.providerID, model.id, policies)
        if (!isAllowed(policy, showUnknown)) {
          editor.remove(model.providerID, model.id)
        }
      }
    })

    // Policies can change daily: keep refreshing while the session is open and
    // re-apply the filter when fresh data arrives.
    const timer = setInterval(() => {
      void load(true)
        .then(() => ctx.model.reload())
        .catch((error) => console.error("[zero-retention-models] refresh failed:", error))
    }, refreshMs)

    return () => clearInterval(timer)
  },
})
