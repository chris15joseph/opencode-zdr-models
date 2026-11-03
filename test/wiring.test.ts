/**
 * Runtime/wiring tests for the zero-retention plugin.
 *
 * These tests use a fake plugin context and a fake global fetch. They prove the
 * privacy-critical startup contract: the transform is registered from the
 * snapshot before storage or network work, storage failures never disable the
 * filter, live data survives cache-write failures, empty/partial fetch results
 * do not erase good data, timers are clamped and cleaned up, and a slow fetch
 * cannot overlap the next tick.
 */
import { after, before, mock, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import plugin, { CACHE_KEY, CACHE_VERSION } from "../src/index.ts"
import { CONSOLE_PAGE_URL, GO_PAGE_URL } from "../src/fetch.ts"
import { snapshotPolicyMap } from "../src/retention.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const goHtml = readFileSync(join(fixtures, "console-go.html"), "utf8")
const modelsHtml = readFileSync(join(fixtures, "console-models.html"), "utf8")

// Freeze the wall clock inside the bundled snapshot's trust window. Runtime
// behaviour after 30 days is still covered explicitly in retention.test.ts.
const SNAPSHOT_WINDOW_NOW = Date.parse("2026-11-02T12:00:00Z")
before(() => mock.timers.enable({ apis: ["Date"], now: SNAPSHOT_WINDOW_NOW }))
after(() => mock.timers.reset())

interface ModelRow {
  providerID: string
  id: string
  name?: string
}

interface HarnessOptions {
  options?: Record<string, unknown>
  models?: ModelRow[]
  get?: (key: string) => unknown
  set?: (key: string, value: unknown) => void
}

function makeEditor(models: ModelRow[], removed: string[]) {
  return {
    list: () => models,
    get: (providerID: string, id: string) =>
      models.find((model) => model.providerID === providerID && model.id === id),
    update: () => {},
    remove: (providerID: string, id: string) => {
      removed.push(`${providerID}/${id}`)
    },
    default: {
      get: () => undefined,
      set: () => {},
    },
    provider: {
      list: () => [],
      get: () => undefined,
    },
  }
}

function makeHarness(input: HarnessOptions = {}) {
  const events: string[] = []
  const transforms: Array<(editor: ReturnType<typeof makeEditor>) => void> = []
  const storageGets: string[] = []
  const storageSets: Array<{ key: string; value: any }> = []
  let reloads = 0
  let disposals = 0

  const ctx = {
    options: input.options ?? {},
    model: {
      transform: async (callback: (editor: ReturnType<typeof makeEditor>) => void) => {
        events.push("transform")
        transforms.push(callback)
        return {
          dispose: async () => {
            disposals++
            events.push("dispose")
          },
        }
      },
      reload: async () => {
        reloads++
        events.push("reload")
      },
    },
    storage: {
      get: async (key: string) => {
        events.push("storage.get")
        storageGets.push(key)
        return input.get ? await input.get(key) : undefined
      },
      set: async (key: string, value: unknown) => {
        events.push("storage.set")
        storageSets.push({ key, value })
        if (input.set) await input.set(key, value)
      },
    },
  }

  const apply = () => {
    const removed: string[] = []
    const editor = makeEditor(input.models ?? [], removed)
    for (const transform of transforms) transform(editor)
    return removed
  }

  return {
    ctx,
    events,
    transforms,
    storageGets,
    storageSets,
    apply,
    get reloads() {
      return reloads
    },
    get disposals() {
      return disposals
    },
  }
}

async function withFetch<T>(fake: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fake
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function silently<T>(run: () => Promise<T>): Promise<T> {
  const original = { log: console.log, warn: console.warn, error: console.error }
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  try {
    return await run()
  } finally {
    Object.assign(console, original)
  }
}

interface TimerRecord {
  handle: object
  delay: number
  cleared: boolean
  callback: () => void
}

function captureIntervals() {
  const records: TimerRecord[] = []
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    const handle = {}
    records.push({ handle, delay: Number(delay), cleared: false, callback })
    return handle as never
  }) as typeof setInterval
  globalThis.clearInterval = ((handle: object) => {
    const record = records.find((item) => item.handle === handle)
    if (record) record.cleared = true
  }) as typeof clearInterval
  return {
    records,
    restore: () => {
      globalThis.setInterval = originalSet
      globalThis.clearInterval = originalClear
    },
  }
}

function snapshotCache(fetchedAt: string) {
  const providers: Record<string, any> = {}
  for (const [providerID, policies] of snapshotPolicyMap()) {
    providers[providerID] = {
      providerID,
      policies: [...policies.values()],
      source: `test:${providerID}`,
      fetchedAt,
      complete: true,
    }
  }
  return { version: CACHE_VERSION, providers, fetchedAt }
}

function fixtureFetch(calls: string[] = []) {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith(GO_PAGE_URL)) return new Response(goHtml)
    if (url.startsWith(CONSOLE_PAGE_URL)) return new Response(modelsHtml)
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
}

const SNAPSHOT_MODELS: ModelRow[] = [
  { providerID: "opencode", id: "kimi-k3" },
  { providerID: "opencode", id: "gpt-5" },
  { providerID: "opencode", id: "big-pickle" },
  { providerID: "opencode", id: "mistral-large-4" },
  { providerID: "opencode-go", id: "kimi-k3" },
  { providerID: "opencode-go", id: "grok-4.7" },
  { providerID: "openrouter", id: "kimi-k3" },
  { providerID: "openrouter", id: "mistral-large-4" },
  { providerID: "ollama", id: "llama3" },
]

const SNAPSHOT_REMOVED = [
  "opencode/big-pickle",
  "opencode/gpt-5",
  "opencode/mistral-large-4",
  "opencode-go/grok-4.7",
]

test("registers transform before storage/network, filters snapshot, and cleanup aborts", async () => {
  await silently(async () => {
    const timers = captureIntervals()
    try {
      const harness = makeHarness({
        models: SNAPSHOT_MODELS,
        get: async () => {
          throw new Error("disk read error")
        },
      })
      let aborted = false
      const slowFetch = ((_input: string | URL | Request, init?: RequestInit) => {
        harness.events.push("fetch")
        const signal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            aborted = true
            reject(new DOMException("aborted", "AbortError"))
          }
          if (signal?.aborted) {
            abort()
            return
          }
          signal?.addEventListener("abort", abort, { once: true })
        })
      }) as typeof fetch

      await withFetch(slowFetch, async () => {
        const cleanup = await plugin.setup(harness.ctx as never)
        assert.equal(harness.transforms.length, 1)
        assert.equal(harness.events[0], "transform")
        await waitFor(() => harness.events.includes("fetch"), "fetch start")
        assert.ok(harness.events.indexOf("transform") < harness.events.indexOf("storage.get"))
        assert.ok(harness.events.indexOf("storage.get") < harness.events.indexOf("fetch"))

        const removed = harness.apply()
        assert.deepEqual([...removed].sort(), [...SNAPSHOT_REMOVED].sort())
        // Replay-safe: the same filter applies to a fresh editor.
        assert.deepEqual([...harness.apply()].sort(), [...SNAPSHOT_REMOVED].sort())
        assert.equal(harness.reloads, 0, "snapshot wiring should not reload")

        const timer = timers.records.at(-1)
        assert.ok(timer)
        assert.equal(timer.delay, 12 * 3_600_000)
        assert.equal(timer.cleared, false)

        await cleanup?.()
        assert.equal(timer.cleared, true)
        assert.equal(harness.disposals, 1)
        await waitFor(() => aborted, "in-flight fetch abort")
      })
    } finally {
      timers.restore()
    }
  })
})

test("corrupt/future/stale caches fall back to snapshot and never throw", async () => {
  await silently(async () => {
    const now = new Date().toISOString()
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString()
    const validPolicy = {
      providerID: "opencode-go",
      modelID: "kimi-k3",
      name: "Kimi K3",
      retention: "zero",
      reason: "test",
      source: "live",
    }
    const provider = {
      providerID: "opencode-go",
      policies: [validPolicy],
      source: GO_PAGE_URL,
      fetchedAt: now,
      complete: true,
    }
    const corruptCaches: unknown[] = [
      null,
      42,
      "corrupt",
      {},
      { version: CACHE_VERSION, fetchedAt: now, providers: null },
      { version: 1, fetchedAt: now, providers: { "opencode-go": provider } },
      { version: CACHE_VERSION, fetchedAt: future, providers: { "opencode-go": provider } },
      { version: CACHE_VERSION, fetchedAt: old, providers: { "opencode-go": provider } },
      {
        version: CACHE_VERSION,
        fetchedAt: now,
        providers: { "opencode-go": { ...provider, policies: null } },
      },
    ]

    for (const cached of corruptCaches) {
      let fetches = 0
      const fakeFetch = (async () => {
        fetches++
        return new Response("<html><body>empty</body></html>")
      }) as typeof fetch
      await withFetch(fakeFetch, async () => {
        const harness = makeHarness({
          models: [
            { providerID: "opencode", id: "gpt-5" },
            { providerID: "opencode", id: "kimi-k3" },
            { providerID: "openrouter", id: "kimi-k3" },
          ],
          get: async () => cached,
        })
        const cleanup = await plugin.setup(harness.ctx as never)
        assert.equal(harness.transforms.length, 1)
        await waitFor(() => fetches === 2, "background refresh after invalid cache")
        assert.deepEqual(harness.apply(), ["opencode/gpt-5"])
        await cleanup?.()
      })
    }
  })
})

test("storage.set failure keeps fresh live data instead of reverting to cache", async () => {
  await silently(async () => {
    const stale = new Date(Date.now() - 48 * 3_600_000).toISOString()
    const oldCache = {
      version: CACHE_VERSION,
      fetchedAt: stale,
      providers: {
        "opencode-go": {
          providerID: "opencode-go",
          policies: [
            {
              providerID: "opencode-go",
              modelID: "grok-4.7",
              name: "Grok 4.7",
              retention: "zero",
              reason: "stale cached zero",
              source: "live",
            },
          ],
          source: "test:stale",
          fetchedAt: stale,
          complete: true,
        },
      },
    }
    const setCalls: Array<{ key: string; value: any }> = []
    const fetches: string[] = []
    const harness = makeHarness({
      models: [
        { providerID: "opencode-go", id: "grok-4.7" },
        { providerID: "opencode-go", id: "kimi-k3" },
      ],
      get: async () => oldCache,
      set: (key, value) => {
        setCalls.push({ key, value })
        throw new Error("disk full")
      },
    })

    await withFetch(fixtureFetch(fetches), async () => {
      const cleanup = await plugin.setup(harness.ctx as never)
      await waitFor(() => setCalls.length > 0, "cache write attempt")
      await waitFor(() => harness.reloads >= 2, "cache + live reloads")

      assert.equal(setCalls[0].key, CACHE_KEY)
      const payload = setCalls[0].value
      assert.equal(payload.version, CACHE_VERSION)
      assert.equal(payload.providers["opencode-go"].providerID, "opencode-go")
      assert.equal(payload.providers["opencode-go"].source, GO_PAGE_URL)
      assert.equal(payload.providers["opencode-go"].complete, true)
      assert.ok(Array.isArray(payload.providers["opencode-go"].policies))
      assert.equal(typeof payload.providers["opencode-go"].fetchedAt, "string")

      const removed = harness.apply()
      assert.ok(removed.includes("opencode-go/grok-4.7"), "live 30d must override stale zero")
      assert.equal(removed.includes("opencode-go/kimi-k3"), false)
      await cleanup?.()
    })
  })
})

test("empty 200 responses do not replace last-known-good cache", async () => {
  await silently(async () => {
    const stale = new Date(Date.now() - 48 * 3_600_000).toISOString()
    const goodCache = {
      version: CACHE_VERSION,
      fetchedAt: stale,
      providers: {
        "opencode-go": {
          providerID: "opencode-go",
          policies: [
            {
              providerID: "opencode-go",
              modelID: "kimi-k3",
              name: "Kimi K3",
              retention: "zero",
              reason: "last known good",
              source: "live",
            },
            {
              providerID: "opencode-go",
              modelID: "grok-4.7",
              name: "Grok 4.7",
              retention: "30d",
              reason: "last known good",
              source: "live",
            },
          ],
          source: "test:cached",
          fetchedAt: stale,
          complete: true,
        },
      },
    }
    let fetches = 0
    const harness = makeHarness({
      models: [
        { providerID: "opencode-go", id: "kimi-k3" },
        { providerID: "opencode-go", id: "grok-4.7" },
      ],
      get: async () => goodCache,
    })
    const fakeFetch = (async () => {
      fetches++
      return new Response("<html><body>zero rows</body></html>")
    }) as typeof fetch

    await withFetch(fakeFetch, async () => {
      const cleanup = await plugin.setup(harness.ctx as never)
      await waitFor(() => fetches === 2, "empty refresh")
      await flush()
      assert.equal(harness.storageSets.length, 0, "empty parse must not be cached")
      const removed = harness.apply()
      assert.deepEqual(removed, ["opencode-go/grok-4.7"])
      await cleanup?.()
    })
  })
})

test("one failed page still applies the other provider independently", async () => {
  await silently(async () => {
    const harness = makeHarness({
      models: [
        { providerID: "opencode", id: "grok-4.7" },
        { providerID: "opencode", id: "gpt-5" },
        { providerID: "opencode-go", id: "grok-4.7" },
        { providerID: "opencode-go", id: "kimi-k3" },
      ],
    })
    const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.startsWith(GO_PAGE_URL)) return new Response(goHtml)
      if (url.startsWith(CONSOLE_PAGE_URL)) return new Response("down", { status: 503 })
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    await withFetch(fakeFetch, async () => {
      const cleanup = await plugin.setup(harness.ctx as never)
      await waitFor(() => harness.storageSets.length > 0, "partial cache write")
      const payload = harness.storageSets[0].value
      assert.equal(payload.providers["opencode-go"].complete, true)
      assert.equal(payload.providers["opencode"], undefined)

      const removed = harness.apply()
      assert.ok(removed.includes("opencode-go/grok-4.7"))
      assert.ok(removed.includes("opencode/gpt-5"))
      // Console page failed: its snapshot baseline keeps Console Grok zero.
      assert.equal(removed.includes("opencode/grok-4.7"), false)
      assert.equal(removed.includes("opencode-go/kimi-k3"), false)
      await cleanup?.()
    })
  })
})

test("refreshHours is finite/clamped and cleanup clears the timer", async () => {
  await silently(async () => {
    const timers = captureIntervals()
    try {
      const cases: Array<[input: unknown, expectedHours: number]> = [
        [undefined, 12],
        [12, 12],
        [720, 596],
        [596, 596],
        [Number.NaN, 12],
        [Number.POSITIVE_INFINITY, 12],
        ["abc", 12],
        [0, 12],
        [-5, 12],
        [0.5, 1],
      ]

      for (const [input, expectedHours] of cases) {
        const fakeFetch = (async () => new Response("<html></html>")) as typeof fetch
        await withFetch(fakeFetch, async () => {
          const harness = makeHarness({
            options: input === undefined ? {} : { refreshHours: input },
            models: [{ providerID: "opencode", id: "mystery-model" }],
          })
          const cleanup = await plugin.setup(harness.ctx as never)
          const timer = timers.records.at(-1)
          assert.ok(timer, `timer for ${String(input)}`)
          assert.equal(timer.delay, expectedHours * 3_600_000, `delay for ${String(input)}`)
          assert.ok(timer.delay > 0 && timer.delay <= 2_147_483_647)
          assert.deepEqual(harness.apply(), ["opencode/mystery-model"], "unknown is hidden by default")
          await cleanup?.()
          assert.equal(timer.cleared, true)
        })
      }
    } finally {
      timers.restore()
    }
  })
})

test("invalid showUnknown/providers/verifiedZdr warn and use safe fallbacks", async () => {
  const originalWarn = console.warn
  const originalLog = console.log
  const originalError = console.error
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  console.log = () => {}
  console.error = () => {}
  try {
    const fakeFetch = (async () => new Response("<html></html>")) as typeof fetch
    await withFetch(fakeFetch, async () => {
      const harness = makeHarness({
        options: {
          showUnknown: "true",
          providers: [""],
          verifiedZdr: [{ providerID: "opencode" }],
        },
        models: [
          { providerID: "opencode", id: "mystery-model" },
          { providerID: "openrouter", id: "mystery-model" },
        ],
      })
      const cleanup = await plugin.setup(harness.ctx as never)
      const removed = harness.apply()
      assert.deepEqual(removed, ["opencode/mystery-model"])
      assert.ok(warnings.some((warning) => warning.includes("showUnknown")))
      assert.ok(warnings.some((warning) => warning.includes("providers")))
      assert.ok(warnings.some((warning) => warning.includes("verifiedZdr")))
      await cleanup?.()
    })

    await withFetch(fakeFetch, async () => {
      const harness = makeHarness({
        options: { showUnknown: true },
        models: [{ providerID: "opencode", id: "mystery-model" }],
      })
      const cleanup = await plugin.setup(harness.ctx as never)
      assert.deepEqual(harness.apply(), [])
      await cleanup?.()
    })
  } finally {
    console.warn = originalWarn
    console.log = originalLog
    console.error = originalError
  }
})

test("slow fetch cannot overlap the next timer tick", async () => {
  await silently(async () => {
    const timers = captureIntervals()
    try {
      const pending: Array<{
        url: string
        resolve: (response: Response) => void
        reject: (error: unknown) => void
      }> = []
      const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        return new Promise<Response>((resolve, reject) => {
          const entry = { url, resolve, reject }
          pending.push(entry)
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          )
        })
      }) as typeof fetch

      await withFetch(fakeFetch, async () => {
        const harness = makeHarness()
        const cleanup = await plugin.setup(harness.ctx as never)
        await waitFor(() => pending.length === 2, "initial two page fetches")
        const timer = timers.records.at(-1)
        assert.ok(timer)
        timer.callback()
        timer.callback()
        await flush()
        assert.equal(pending.length, 2, "in-flight guard must skip overlapping ticks")

        for (const request of pending) {
          request.resolve(
            new Response(request.url.startsWith(GO_PAGE_URL) ? goHtml : modelsHtml),
          )
        }
        await waitFor(() => harness.reloads >= 1, "reload after live data")
        await cleanup?.()
      })
    } finally {
      timers.restore()
    }
  })
})

test("fresh cache reloads only when the policy fingerprint changes", async () => {
  await silently(async () => {
    const now = new Date().toISOString()
    const sameCache = snapshotCache(now)
    let fetches = 0
    const fakeFetch = (async () => {
      fetches++
      return new Response("<html></html>")
    }) as typeof fetch

    await withFetch(fakeFetch, async () => {
      const harness = makeHarness({ get: async () => sameCache })
      const cleanup = await plugin.setup(harness.ctx as never)
      await waitFor(() => harness.events.includes("storage.get"), "cache read")
      await flush()
      assert.equal(harness.reloads, 0, "identical cache must not reload models")
      assert.equal(fetches, 0, "fresh cache must not fetch")
      await cleanup?.()
    })

    const changed = snapshotCache(now)
    changed.providers["opencode-go"].policies = changed.providers["opencode-go"].policies.map(
      (policy: any) => (policy.modelID === "grok-4.7" ? { ...policy, retention: "zero" } : policy),
    )
    await withFetch(fakeFetch, async () => {
      const harness = makeHarness({ get: async () => changed })
      const cleanup = await plugin.setup(harness.ctx as never)
      await waitFor(() => harness.reloads >= 1, "fingerprint change reload")
      assert.equal(fetches, 0, "fresh cache must not fetch")
      await cleanup?.()
    })
  })
})
