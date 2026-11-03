/**
 * Live retention-policy pipeline.
 *
 * The Go and Console privacy pages are fetched independently with
 * Promise.allSettled, so one page failing does not discard the other page's
 * successful data. An empty parse is `complete: false` and must not replace a
 * previous cache entry.
 */

import { type ScopedPolicy } from "./retention.ts"
import { dedupePolicies, parseConsolePrivacy, parseGoPrivacy } from "./privacy.ts"

export const GO_PAGE_URL = "https://opencode.ai/v2/docs/console/go"
export const CONSOLE_PAGE_URL = "https://opencode.ai/v2/docs/console/models"

export interface ProviderFetchResult {
  providerID: string
  policies: ScopedPolicy[]
  source: string
  fetchedAt: string
  /** True only when the page was fetched and at least one policy parsed. */
  complete: boolean
  error?: string
}

export interface FetchResult {
  providers: Record<string, ProviderFetchResult>
  sources: string[]
  fetchedAt: string
  complete: boolean
}

interface PageDescriptor {
  providerID: string
  url: string
  parse: (html: string) => ScopedPolicy[]
}

const PAGES: readonly PageDescriptor[] = [
  { providerID: "opencode-go", url: GO_PAGE_URL, parse: parseGoPrivacy },
  { providerID: "opencode", url: CONSOLE_PAGE_URL, parse: parseConsolePrivacy },
]

/**
 * Fetch one page with a hard per-attempt deadline.
 *
 * `Promise.race` is deliberate: even a `fetchImpl` that ignores its abort
 * signal cannot hang the caller past the deadline. The external signal is
 * raced too, so cleanup aborts in-flight work immediately.
 */
async function fetchPage(
  page: PageDescriptor,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderFetchResult> {
  const fetchedAt = new Date().toISOString()
  const controller = new AbortController()
  const attemptTimeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 60_000)
      : 10_000

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  const failed = (error: unknown): ProviderFetchResult => ({
    providerID: page.providerID,
    policies: [],
    source: page.url,
    fetchedAt,
    complete: false,
    error: error instanceof Error ? error.message : String(error),
  })

  if (signal?.aborted) {
    controller.abort()
    return failed(new Error("aborted"))
  }

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${attemptTimeout}ms`))
    }, attemptTimeout)
  })

  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return
    onAbort = () => {
      controller.abort()
      reject(new Error("aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

  const work = (async () => {
    const response = await fetchImpl(page.url, { signal: controller.signal })
    if (!response.ok) throw new Error(`${page.url} returned ${response.status}`)
    const html = await response.text()
    return page.parse(html)
  })()

  try {
    const parsed = await Promise.race([work, timeout, aborted])
    // De-duplicate by (provider, modelID); conflicting duplicates keep the
    // worst signal via toPolicyMap.
    const policies = dedupePolicies(parsed)
    return {
      providerID: page.providerID,
      policies,
      source: page.url,
      fetchedAt,
      complete: policies.length > 0,
      ...(policies.length === 0 ? { error: "page parsed zero policies" } : {}),
    }
  } catch (error) {
    return failed(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener("abort", onAbort)
  }
}

/**
 * Fetch both documentation pages independently. A failure on one page is
 * reported in that provider's `error` field and does not discard the other
 * provider's data. An empty parse is `complete: false`.
 */
export async function fetchRetentionPolicies(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const settled = await Promise.allSettled(
    PAGES.map((page) => fetchPage(page, fetchImpl, timeoutMs, signal)),
  )

  const providers: Record<string, ProviderFetchResult> = {}
  for (const [index, item] of settled.entries()) {
    const page = PAGES[index]
    if (item.status === "fulfilled") {
      providers[item.value.providerID] = item.value
    } else {
      providers[page.providerID] = {
        providerID: page.providerID,
        policies: [],
        source: page.url,
        fetchedAt: new Date().toISOString(),
        complete: false,
        error: item.reason instanceof Error ? item.reason.message : String(item.reason),
      }
    }
  }
  const sources = Object.values(providers)
    .filter((provider) => provider.complete)
    .map((provider) => provider.source)
  return {
    providers,
    sources,
    fetchedAt: new Date().toISOString(),
    complete: PAGES.every((page) => providers[page.providerID]?.complete === true),
  }
}

// Parser facade: `fetch.ts` stays the import point for the plugin and tests.
export {
  classifyRetentionCell,
  classifyTrainingCell,
  nameKey,
  parseConsolePrivacy,
  parseGoPrivacy,
  parseNameToIdMap,
  type ParseOptions,
} from "./privacy.ts"
export { extractTables, stripTags } from "./html.ts"
