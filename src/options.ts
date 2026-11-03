/**
 * Plugin option parsing.
 *
 * Options are set in opencode.jsonc under `plugins`:
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

import { DEFAULT_PROVIDERS } from "./retention.ts"

export const MIN_REFRESH_HOURS = 1
export const MAX_REFRESH_HOURS = 596

export interface Options {
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
      for (const item of value) {
        if (!item || typeof item !== "object") continue
        const entry = item as Record<string, unknown>
        if (typeof entry.providerID !== "string" || typeof entry.modelID !== "string") continue
        const providerID = entry.providerID.trim()
        const modelID = entry.modelID.trim()
        if (!providerID || !modelID) continue
        verifiedZdr.push({ providerID, modelID })
      }
      if (verifiedZdr.length !== value.length) {
        warnings.push("verifiedZdr entries must be non-empty {providerID, modelID} strings; invalid entries ignored")
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
