/**
 * Policy-core regression tests for the zero-retention filter.
 *
 * These tests deliberately do not assert the old flat-ID behaviour. They cover
 * the privacy contract: provider scope, Mistral fail-closed defaults, training
 * precedence, live-over-snapshot authority, negation, snapshot age/validity,
 * Console/Go separation, local-provider aliases, and cache/merge safety.
 *
 * Fixtures are read-only inputs captured from the published docs. Parser
 * hardening fixtures are owned by WS2; small inline documents here exercise
 * policy semantics only.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
  classifyRetentionCell,
  classifyTrainingCell,
  parseGoPrivacy,
  parseConsolePrivacy,
  fetchRetentionPolicies,
  GO_PAGE_URL,
  CONSOLE_PAGE_URL,
} from "../src/fetch.ts"
import {
  CONSOLE_POLICIES,
  GO_POLICIES,
  LOCAL_PROVIDERS,
  SNAPSHOT_CAPTURED_AT,
  SNAPSHOT_MAX_AGE_DAYS,
  isAllowed,
  resolveRetention,
  snapshotIsFresh,
  snapshotPolicyMap,
  toPolicyMap,
} from "../src/retention.ts"
import {
  CACHE_MAX_AGE_MS,
  CACHE_VERSION,
  buildActivePolicyMap,
  clampRefreshHours,
  mergeProviderData,
  parseCachedPayload,
  validateOptions,
} from "../src/index.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const goHtml = readFileSync(join(fixtures, "console-go.html"), "utf8")
const modelsHtml = readFileSync(join(fixtures, "console-models.html"), "utf8")

const FRESH = Date.parse("2026-11-02T12:00:00Z")
const STALE = Date.parse("2026-12-05T12:00:00Z")

function table(headers: string[], rows: string[][]): string {
  return `<table><thead><tr>${headers
    .map((header) => `<th>${header}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`
}

/** Build a minimal Go docs page with an endpoints table and a privacy table. */
function goDoc(rows: Array<[name: string, id: string, training: string, retention: string]>): string {
  return (
    table(
      ["Model", "Model ID"],
      rows.map(([name, id]) => [name, id]),
    ) +
    table(
      ["Model", "Model training", "Data retention"],
      rows.map(([name, , training, retention]) => [name, training, retention]),
    )
  )
}

/** Build a minimal Console docs page with an endpoints table and privacy bullets. */
function consoleDoc(bullets: string[], models: Array<[name: string, id: string]>): string {
  return (
    table(["Model", "Model ID"], models) +
    `<h2 id="privacy">Privacy</h2><ul>${bullets
      .map((bullet) => `<li>${bullet}</li>`)
      .join("")}</ul><h2 id="next">Next section</h2><ul><li>Ignored: not in privacy.</li></ul>`
  )
}

function cachedProvider(
  providerID: string,
  policies: ReturnType<typeof parseGoPrivacy>,
  fetchedAt: string,
  complete = true,
) {
  return { providerID, policies, source: `test:${providerID}`, fetchedAt, complete }
}

test("Mistral defaults to not-zdr and is hidden; no zero snapshot/rule", () => {
  const mistral = resolveRetention("opencode", "mistral-large-4")
  assert.equal(mistral.retention, "not-zdr")
  assert.equal(mistral.scoped, true)
  assert.equal(isAllowed(mistral, false), false)
  assert.equal(isAllowed(mistral, true), false)

  // Family rule covers future IDs, still fail-closed.
  const future = resolveRetention("opencode", "mistral-medium-3")
  assert.equal(future.retention, "not-zdr")
  assert.equal(isAllowed(future, false), false)

  // No snapshot or family rule may certify Mistral as zero.
  assert.equal(
    CONSOLE_POLICIES.some((policy) => /^mistral/i.test(policy.modelID) && policy.retention === "zero"),
    false,
  )
  assert.equal(
    GO_POLICIES.some((policy) => /^mistral/i.test(policy.modelID) && policy.retention === "zero"),
    false,
  )

  // The live Console Mistral bullet is parsed as a not-zdr family exception.
  const consoleMap = toPolicyMap(parseConsolePrivacy(modelsHtml))
  assert.equal(consoleMap.get("opencode")?.get("family:mistral")?.retention, "not-zdr")

  // verifiedZdr is a user attestation only; it is scoped, not automatic.
  const attested = resolveRetention("opencode", "mistral-large-4", undefined, {
    verifiedZdr: [{ providerID: "opencode", modelID: "mistral-large-4" }],
  })
  assert.equal(attested.retention, "zero")
  assert.equal(isAllowed(attested, false), true)
  assert.equal(resolveRetention("opencode", "mistral-large-4").retention, "not-zdr")
})

test("training dominates retention, including Yes* variants and unknown retention", () => {
  const doc = goDoc([
    ["Danger Model", "danger-model", "Yes", "0 days"],
    ["Danger Optin", "danger-optin", "Yes (opt-in)", "0 days"],
    ["Danger Star", "danger-star", "Yes*", "0 days"],
    ["Danger Limited", "danger-limited", "Yes (limited)", "0 days"],
    ["Mystery Model", "mystery-model", "Yes", "14 days"],
    ["Safe Model", "safe-model", "Not used", "0 days"],
  ])
  const go = toPolicyMap(parseGoPrivacy(doc)).get("opencode-go")
  for (const id of ["danger-model", "danger-optin", "danger-star", "danger-limited", "mystery-model"]) {
    assert.equal(go?.get(id)?.retention, "training", `${id} must be training`)
    assert.equal(isAllowed(resolveRetention("opencode-go", id, toPolicyMap(parseGoPrivacy(doc))), false), false)
  }
  assert.equal(go?.get("safe-model")?.retention, "zero")

  for (const value of ["Yes", "Yes*", "Yes (opt-in)", "Yes (limited)", "yes - opt in"]) {
    assert.equal(classifyTrainingCell(value), "training", value)
  }
  assert.equal(classifyTrainingCell("Not used"), undefined)
})

test("unclassified live retention is unknown and never falls back to a snapshot zero", () => {
  const live = parseGoPrivacy(goDoc([["Kimi K3", "kimi-k3", "Not used", "14 days"]]))
  assert.equal(live.length, 1)
  assert.equal(live[0].retention, "unknown")

  const active = buildActivePolicyMap(
    { "opencode-go": cachedProvider("opencode-go", live, new Date(FRESH).toISOString()) },
    snapshotPolicyMap(),
  )
  const resolved = resolveRetention("opencode-go", "kimi-k3", active, { now: FRESH })
  assert.equal(resolved.retention, "unknown")
  assert.equal(resolved.scoped, true)
  assert.equal(isAllowed(resolved, false), false)
  assert.equal(isAllowed(resolved, true), true)
})

test("negated zero-retention wording is never classified as zero", () => {
  const negations = [
    "not zero-retention",
    "does not offer zero-retention",
    "does not provide 0 days",
    "non-zero",
    "no zero data retention",
    "Not ZDR",
  ]
  for (const text of negations) {
    assert.equal(classifyRetentionCell(text), "not-zdr", text)
  }
  assert.equal(classifyRetentionCell("zero-retention"), "zero")
  assert.equal(classifyRetentionCell("Zero data retention policy"), "zero")
  assert.equal(classifyRetentionCell("0 days"), "zero")
  assert.equal(classifyRetentionCell("30 days"), "30d")
  assert.equal(classifyRetentionCell("0 days, 30 days"), "30d")

  const doc = consoleDoc(
    ["Bad Model: This endpoint does not offer zero-retention; data is kept for 30 days."],
    [["Bad Model", "bad-model"]],
  )
  const consoleMap = toPolicyMap(parseConsolePrivacy(doc))
  assert.equal(consoleMap.get("opencode")?.get("bad-model")?.retention, "not-zdr")
})

test("policies are provider-scoped: openrouter untouched, opencode-go zero", () => {
  const openrouter = resolveRetention("openrouter", "kimi-k3")
  assert.equal(openrouter.scoped, false)
  assert.equal(openrouter.retention, "unknown")
  assert.equal(isAllowed(openrouter, false), true)

  const go = resolveRetention("opencode-go", "kimi-k3")
  assert.equal(go.scoped, true)
  assert.equal(go.retention, "zero")
  assert.equal(isAllowed(go, false), true)

  // Explicitly configuring a provider makes it scoped, but never imports
  // OpenCode's policy from another provider.
  const scopedOpenRouter = resolveRetention("openrouter", "mystery-model", undefined, {
    providers: ["openrouter"],
  })
  assert.equal(scopedOpenRouter.scoped, true)
  assert.equal(scopedOpenRouter.retention, "unknown")
  assert.equal(isAllowed(scopedOpenRouter, false), false)

  // The same Mistral ID is only a Console policy, never leaked to OpenRouter.
  assert.equal(isAllowed(resolveRetention("openrouter", "mistral-large-4"), false), true)
})

test("Console Grok/Muse baseline is zero while Go keeps its own values", () => {
  const snapshot = snapshotPolicyMap()
  assert.equal(resolveRetention("opencode", "grok-4.7", snapshot, { now: FRESH }).retention, "zero")
  assert.equal(resolveRetention("opencode", "muse-spark-1.3", snapshot, { now: FRESH }).retention, "zero")
  assert.equal(resolveRetention("opencode", "muse-wonder-1.0", snapshot, { now: FRESH }).retention, "zero")

  assert.equal(resolveRetention("opencode-go", "grok-4.7", snapshot, { now: FRESH }).retention, "30d")
  assert.equal(
    resolveRetention("opencode-go", "muse-spark-1.3-contributor", snapshot, { now: FRESH }).retention,
    "not-zdr",
  )
  assert.equal(resolveRetention("opencode-go", "grok-4.7", snapshot, { now: FRESH }).policy?.source, "snapshot")
  assert.equal(isAllowed(resolveRetention("opencode-go", "grok-4.7", snapshot, { now: FRESH }), false), false)
})

test("Pulse Alpha Free is training, including the 'retained and used' bullet", () => {
  const pulse = resolveRetention("opencode", "pulse-alpha-free")
  assert.equal(pulse.retention, "training")
  assert.equal(isAllowed(pulse, false), false)
  assert.equal(isAllowed(pulse, true), false)

  const parsed = parseConsolePrivacy(
    consoleDoc(
      [
        "Pulse Alpha Free: During its free period, collected data may be retained and used to improve the model.",
      ],
      [["Pulse Alpha Free", "pulse-alpha-free"]],
    ),
  )
  const consoleMap = toPolicyMap(parsed)
  assert.equal(consoleMap.get("opencode")?.get("pulse-alpha-free")?.retention, "training")
})

test("snapshot age and validUntil conditions fail closed for stale zero policies", () => {
  const snapshot = snapshotPolicyMap()
  assert.equal(snapshotIsFresh(FRESH), true)
  assert.equal(snapshotIsFresh(STALE), false)
  assert.equal(SNAPSHOT_MAX_AGE_DAYS, 30)
  assert.equal(Date.parse(SNAPSHOT_CAPTURED_AT) < FRESH, true)

  assert.equal(resolveRetention("opencode-go", "kimi-k3", snapshot, { now: FRESH }).retention, "zero")
  const staleZero = resolveRetention("opencode-go", "kimi-k3", snapshot, { now: STALE })
  assert.equal(staleZero.retention, "unknown")
  assert.equal(isAllowed(staleZero, false), false)

  const expiring = toPolicyMap([
    {
      providerID: "opencode",
      modelID: "expiring-model",
      name: "Expiring Model",
      retention: "zero",
      reason: "test conditional zero",
      source: "snapshot",
      validUntil: "2026-11-01",
    },
  ])
  assert.equal(resolveRetention("opencode", "expiring-model", expiring, { now: FRESH }).retention, "unknown")

  const valid = toPolicyMap([
    {
      providerID: "opencode",
      modelID: "valid-model",
      name: "Valid Model",
      retention: "zero",
      reason: "test conditional zero",
      source: "snapshot",
      validUntil: "2026-12-01",
    },
  ])
  assert.equal(resolveRetention("opencode", "valid-model", valid, { now: FRESH }).retention, "zero")

  // Staleness only invalidates a permissive zero; a stale 30d/not-zdr stays hidden.
  assert.equal(resolveRetention("opencode", "gpt-5", snapshot, { now: STALE }).retention, "30d")
})

test("local providers are an explicit alias allowlist, not arbitrary 'local' names", () => {
  for (const provider of ["ollama", "ollama_local", "lm_studio", "lm-studio", "lmstudio", "vllm", "llama.cpp", "llama_cpp"]) {
    assert.equal(LOCAL_PROVIDERS.has(provider), true, provider)
    const resolved = resolveRetention(provider, "llama3", undefined, { providers: [provider] })
    assert.equal(resolved.scoped, false, provider)
    assert.equal(isAllowed(resolved, false), true, provider)
  }

  for (const provider of ["local", "local-gateway"]) {
    assert.equal(LOCAL_PROVIDERS.has(provider), false, provider)
    const resolved = resolveRetention(provider, "llama3", undefined, { providers: [provider] })
    assert.equal(resolved.scoped, true, provider)
    assert.equal(resolved.retention, "unknown", provider)
    assert.equal(isAllowed(resolved, false), false, provider)
  }
})

test("showUnknown only widens scoped unknown models", () => {
  const unknown = resolveRetention("opencode", "never-published")
  assert.equal(unknown.scoped, true)
  assert.equal(unknown.retention, "unknown")
  assert.equal(isAllowed(unknown, false), false)
  assert.equal(isAllowed(unknown, true), true)

  const outOfScope = resolveRetention("openrouter", "never-published")
  assert.equal(isAllowed(outOfScope, false), true)

  assert.equal(isAllowed(resolveRetention("opencode", "pulse-alpha-free"), true), false)
  assert.equal(isAllowed(resolveRetention("opencode", "gpt-5"), true), false)
  assert.equal(isAllowed(resolveRetention("opencode-go", "grok-4.7"), true), false)
})

test("partial page failure applies the successful provider and keeps the other snapshot", async () => {
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.startsWith(GO_PAGE_URL)) return new Response(goHtml)
    if (url.startsWith(CONSOLE_PAGE_URL)) return new Response("down", { status: 503 })
    throw new Error(`unexpected fetch: ${url}`)
  }
  const result = await fetchRetentionPolicies(fakeFetch as typeof fetch)
  assert.equal(result.providers["opencode-go"].complete, true)
  assert.equal(result.providers["opencode"].complete, false)
  assert.deepEqual(result.sources, [GO_PAGE_URL])
  assert.equal(result.complete, false)

  const active = buildActivePolicyMap(result.providers, snapshotPolicyMap())
  assert.equal(resolveRetention("opencode-go", "kimi-k3", active, { now: FRESH }).retention, "zero")
  assert.equal(resolveRetention("opencode-go", "grok-4.7", active, { now: FRESH }).retention, "30d")
  // Console page failed, so its snapshot baseline still applies.
  assert.equal(resolveRetention("opencode", "grok-4.7", active, { now: FRESH }).retention, "zero")
  assert.equal(resolveRetention("opencode", "gpt-5", active, { now: FRESH }).retention, "30d")
})

test("empty/incomplete fetches never replace last-known-good provider data", async () => {
  const fakeFetch = async (): Promise<Response> => new Response("<html><body>no tables</body></html>")
  const result = await fetchRetentionPolicies(fakeFetch as typeof fetch)
  for (const provider of Object.values(result.providers)) {
    assert.equal(provider.complete, false)
    assert.deepEqual(provider.policies, [])
  }

  const now = new Date(FRESH).toISOString()
  const good = cachedProvider(
    "opencode-go",
    parseGoPrivacy(goDoc([["Kimi K3", "kimi-k3", "Not used", "0 days"]])),
    now,
  )
  const before = { "opencode-go": good }
  const afterIncomplete = mergeProviderData(before, result.providers)
  assert.deepEqual(afterIncomplete["opencode-go"], good)

  const emptyButComplete = {
    "opencode-go": { ...result.providers["opencode-go"], complete: true, policies: [] },
  }
  const afterCompleteEmpty = mergeProviderData(before, emptyButComplete)
  assert.deepEqual(afterCompleteEmpty["opencode-go"], good)

  // An incomplete cached provider cannot erase its snapshot either.
  const active = buildActivePolicyMap(
    { "opencode-go": { ...good, complete: false, policies: [] } },
    snapshotPolicyMap(),
  )
  assert.equal(resolveRetention("opencode-go", "kimi-k3", active, { now: FRESH }).retention, "zero")
})

test("cache payload validation rejects future/stale/corrupt data and keeps valid providers", () => {
  const fetchedAt = new Date(FRESH - 3_600_000).toISOString()
  const policy = {
    providerID: "opencode-go",
    modelID: "kimi-k3",
    name: "Kimi K3",
    retention: "zero" as const,
    reason: "test live policy",
    source: "live" as const,
  }
  const provider = {
    providerID: "opencode-go",
    policies: [policy],
    source: GO_PAGE_URL,
    fetchedAt,
    complete: true,
  }
  const payload = {
    version: CACHE_VERSION,
    providers: { "opencode-go": provider },
    fetchedAt,
  }

  assert.equal(parseCachedPayload(payload, FRESH)?.providers["opencode-go"].complete, true)
  assert.equal(parseCachedPayload(null, FRESH), undefined)
  assert.equal(parseCachedPayload(42, FRESH), undefined)
  assert.equal(parseCachedPayload("corrupt", FRESH), undefined)
  assert.equal(parseCachedPayload({ ...payload, version: 1 }, FRESH), undefined)
  assert.equal(parseCachedPayload({ ...payload, providers: null }, FRESH), undefined)
  assert.equal(parseCachedPayload({ ...payload, fetchedAt: "not-a-date" }, FRESH), undefined)

  // Any future timestamp is rejected, not accepted as "fresh forever".
  const futureTop = new Date(FRESH + 60_000).toISOString()
  assert.equal(parseCachedPayload({ ...payload, fetchedAt: futureTop }, FRESH), undefined)
  const futureProvider = { ...provider, fetchedAt: futureTop }
  assert.equal(parseCachedPayload({ ...payload, providers: { "opencode-go": futureProvider } }, FRESH), undefined)

  const tooOld = new Date(FRESH - CACHE_MAX_AGE_MS - 1).toISOString()
  assert.equal(parseCachedPayload({ ...payload, fetchedAt: tooOld }, FRESH), undefined)
  const oldProvider = { ...provider, fetchedAt: tooOld }
  assert.equal(parseCachedPayload({ ...payload, providers: { "opencode-go": oldProvider } }, FRESH), undefined)

  // A corrupt/stale provider entry is skipped; a valid sibling survives.
  const mixed = {
    ...payload,
    providers: {
      "opencode-go": provider,
      opencode: { ...provider, providerID: "opencode", fetchedAt: futureTop },
    },
  }
  const parsed = parseCachedPayload(mixed, FRESH)
  assert.equal(parsed?.providers["opencode-go"].complete, true)
  assert.equal(parsed?.providers.opencode, undefined)

  // Provider/model identity must match; cache data cannot smuggle another provider.
  const mismatched = {
    ...payload,
    providers: { "opencode-go": { ...provider, providerID: "opencode" } },
  }
  assert.equal(parseCachedPayload(mismatched, FRESH), undefined)
})

test("option validation clamps refreshHours and validates providers/verifiedZdr", () => {
  assert.equal(clampRefreshHours(undefined), 12)
  assert.equal(clampRefreshHours(Number.NaN), 12)
  assert.equal(clampRefreshHours(Number.POSITIVE_INFINITY), 12)
  assert.equal(clampRefreshHours("abc"), 12)
  assert.equal(clampRefreshHours(0), 12)
  assert.equal(clampRefreshHours(-5), 12)
  assert.equal(clampRefreshHours(0.5), 1)
  assert.equal(clampRefreshHours(1), 1)
  assert.equal(clampRefreshHours(12), 12)
  assert.equal(clampRefreshHours(596), 596)
  assert.equal(clampRefreshHours(720), 596)

  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    const validated = validateOptions({
      showUnknown: "true",
      refreshHours: "abc",
      providers: ["OpenCode", " opencode-go ", "opencode"],
      verifiedZdr: [{ providerID: "opencode", modelID: " mistral-large-4 " }, { providerID: "opencode" }],
    })
    assert.equal(validated.showUnknown, false)
    assert.equal(validated.refreshHours, 12)
    assert.deepEqual(validated.providers, ["opencode", "opencode-go"])
    assert.deepEqual(validated.verifiedZdr, [{ providerID: "opencode", modelID: "mistral-large-4" }])
    assert.ok(warnings.some((warning) => warning.includes("showUnknown")))
    assert.ok(warnings.some((warning) => warning.includes("refreshHours")))
    assert.ok(warnings.some((warning) => warning.includes("verifiedZdr")))
  } finally {
    console.warn = originalWarn
  }

  const defaults = validateOptions(undefined)
  assert.deepEqual(defaults.providers, ["opencode", "opencode-go"])
  assert.equal(defaults.showUnknown, false)
  assert.equal(defaults.refreshHours, 12)

  const originalWarnForProviders = console.warn
  console.warn = () => {}
  try {
    const invalidProviders = validateOptions({ providers: ["", 5] })
    assert.deepEqual(invalidProviders.providers, ["opencode", "opencode-go"])
  } finally {
    console.warn = originalWarnForProviders
  }
})
