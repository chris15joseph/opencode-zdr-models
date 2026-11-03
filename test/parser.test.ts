/**
 * Adversarial parser/fetch tests for the zero-retention policy pipeline.
 *
 * These tests use the real documentation captures plus synthetic malformed
 * HTML. They are deliberately conservative: any value the parser does not
 * understand must fail closed rather than become zero.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  CONSOLE_PAGE_URL,
  GO_PAGE_URL,
  classifyRetentionCell,
  classifyTrainingCell,
  extractTables,
  fetchRetentionPolicies,
  parseConsolePrivacy,
  parseGoPrivacy,
  parseNameToIdMap,
  stripTags,
} from "../src/fetch.ts"
import {
  GO_POLICIES,
  isAllowed,
  resolveRetention,
  toPolicyMap,
  type ScopedPolicy,
} from "../src/retention.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const readFixture = (name: string) => readFileSync(join(fixtures, name), "utf8")
const goHtml = readFixture("console-go.html")
const modelsHtml = readFixture("console-models.html")
const FIXED_NOW = Date.parse("2026-11-02T12:00:00Z")

function byId(policies: readonly ScopedPolicy[], provider: string) {
  return toPolicyMap(policies).get(provider)
}

function endpointTable(rows: readonly (readonly [string, string])[]): string {
  return `<table><thead><tr><th>Model</th><th>Model ID</th><th>Endpoint</th></tr></thead><tbody>${rows
    .map(([name, id]) => `<tr><td>${name}</td><td>${id}</td><td>https://example.invalid</td></tr>`)
    .join("")}</tbody></table>`
}

function goPage(
  endpoints: readonly (readonly [string, string])[],
  rows: readonly (readonly [string, string, string])[],
  notes = "",
): string {
  return `<html><body>${endpointTable(endpoints)}<h2 id="privacy">Privacy</h2>
    <table><thead><tr><th>Model</th><th>Model training</th><th>Data retention</th></tr></thead>
    <tbody>${rows
      .map(([name, training, retention]) => `<tr><td>${name}</td><td>${training}</td><td>${retention}</td></tr>`)
      .join("")}</tbody></table>${notes}</body></html>`
}

function consolePage(
  endpoints: readonly (readonly [string, string])[],
  bullets: readonly string[],
  after = "",
): string {
  return `<html><body>${endpointTable(endpoints)}<h2 id="privacy">Privacy</h2>
    <p>All models are zero-retention with the following exceptions:</p>
    <ul>${bullets.map((bullet) => `<li>${bullet}</li>`).join("")}</ul>
    <h2 id="other">Other section</h2>${after}</body></html>`
}

// ---------------------------------------------------------------------------
// HTML extraction / entity handling
// ---------------------------------------------------------------------------

test("extractTables keeps nested tables inside the outer cell", () => {
  const html =
    "<table><tr><td>A</td><td>outer<table><tr><td>inner</td></tr></table></td></tr>" +
    "<tr><td>B</td><td>0 days</td></tr></table>"
  const tables = extractTables(html)
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0], [
    ["A", "outer inner"],
    ["B", "0 days"],
  ])
})

test("extractTables expands rowspan/colspan and multi-row headers", () => {
  const html =
    '<table><thead><tr><th rowspan="2">Model</th><th colspan="2">Policy</th></tr>' +
    "<tr><th>Model training</th><th>Data retention</th></tr></thead><tbody>" +
    "<tr><td>Kimi K3</td><td>Not used</td><td>0 days</td></tr></tbody></table>"
  assert.deepEqual(extractTables(html)[0], [
    ["Model", "Policy", "Policy"],
    ["Model", "Model training", "Data retention"],
    ["Kimi K3", "Not used", "0 days"],
  ])

  const rowspanHtml =
    '<table><tr><th>Model</th><th>Data retention</th></tr>' +
    '<tr><td rowspan="2">GPT A</td><td>0 days</td></tr><tr><td>30 days</td></tr></table>'
  assert.deepEqual(extractTables(rowspanHtml)[0], [
    ["Model", "Data retention"],
    ["GPT A", "0 days"],
    ["GPT A", "30 days"],
  ])
})

test("extractTables tolerates omitted closing tags and attributes containing >", () => {
  const unclosedCells =
    "<table><tr><th>Model<th>Data retention<tr><td>GPT A<td>0 days<tr><td>GPT B<td>30 days</table>"
  assert.deepEqual(extractTables(unclosedCells)[0], [
    ["Model", "Data retention"],
    ["GPT A", "0 days"],
    ["GPT B", "30 days"],
  ])

  const omittedRowClose =
    "<table><tr><th>Model</th><th>Data retention</th></tr>" +
    "<tr><td>A</td><td>0 days</td><tr><td>B</td><td>30 days</td></tr></table>"
  assert.deepEqual(extractTables(omittedRowClose)[0], [
    ["Model", "Data retention"],
    ["A", "0 days"],
    ["B", "30 days"],
  ])

  const unclosedTable =
    "<table><tr><th>Model</th><th>Data retention</th></tr><tr><td>GPT A</td><td>0 days</td>"
  assert.deepEqual(extractTables(unclosedTable)[0], [
    ["Model", "Data retention"],
    ["GPT A", "0 days"],
  ])

  const quotedAttribute = '<table><tr><td title="a>b">GPT A</td><td>0 days</td></tr></table>'
  assert.deepEqual(extractTables(quotedAttribute)[0], [["GPT A", "0 days"]])
})

test("stripTags decodes numeric/named entities exactly once", () => {
  assert.equal(stripTags("A&#x27;s &amp; B"), "A's & B")
  assert.equal(stripTags("A&#8212;B &mdash; C &rsquo;"), "A—B — C ’")
  assert.equal(stripTags("A&amp;lt;B"), "A&lt;B")
  assert.equal(stripTags("A&amp;amp;B"), "A&amp;B")
  assert.equal(stripTags("<span title=\"a>b\">GPT A</span>"), "GPT A")
  assert.equal(stripTags("a < b"), "a < b")
  assert.equal(stripTags("a <!-- hidden > text --> b"), "a b")
})

// ---------------------------------------------------------------------------
// Name -> ID mapping
// ---------------------------------------------------------------------------

test("parseNameToIdMap supports header variants and duplicate names", () => {
  const variant = extractTables(
    "<table><tr><th>Name</th><th>Slug</th></tr><tr><td>Kimi K3</td><td>kimi-k3</td></tr></table>",
  )
  assert.equal(parseNameToIdMap(variant).get("kimik3"), "kimi-k3")

  const duplicate = extractTables(
    "<table><tr><th>Model Name</th><th>Model ID (slug)</th></tr>" +
      "<tr><td>Duplicate Model</td><td>duplicate-one</td></tr></table>" +
      "<table><tr><th>Model</th><th>ID</th></tr>" +
      "<tr><td>Duplicate Model</td><td>duplicate-two</td></tr></table>",
  )
  const duplicateMap = parseNameToIdMap(duplicate)
  assert.equal(
    duplicateMap.get("duplicatemodel"),
    undefined,
    "ambiguous duplicate display names must not be guessed",
  )

  const duplicateIds = parseNameToIdMap(
    extractTables(
      "<table><tr><th>Model</th><th>ID</th></tr>" +
        "<tr><td>Kimi K3</td><td>kimi-k3</td></tr>" +
        "<tr><td>Kimi K3 Alias</td><td>kimi-k3</td></tr></table>",
    ),
  )
  assert.equal(duplicateIds.get("kimik3"), "kimi-k3")
  assert.equal(duplicateIds.get("kimik3alias"), "kimi-k3")

  const missingIdTable = extractTables(
    "<table><tr><th>Model</th><th>Input</th></tr><tr><td>Kimi K3</td><td>$1</td></tr></table>",
  )
  assert.equal(parseNameToIdMap(missingIdTable).size, 0)
})

test("parseGoPrivacy skips unmapped display names instead of fabricating IDs", () => {
  const html = goPage(
    [["Kimi K3", "kimi-k3"]],
    [
      ["Kimi K3", "Not used", "0 days"],
      ["Kimi K3 Pro", "Not used", "30 days"],
    ],
  )
  const policies = parseGoPrivacy(html, { now: FIXED_NOW })
  assert.deepEqual(
    policies.map((policy) => policy.modelID),
    ["kimi-k3"],
  )
  assert.equal(
    policies.some((policy) => policy.modelID.includes("kimik3pro")),
    false,
  )
})

test("parseGoPrivacy has no policies when the ID table is missing", () => {
  const html =
    "<html><body><table><tr><th>Model</th><th>Model training</th><th>Data retention</th>" +
    "</tr><tr><td>Kimi K3</td><td>Not used</td><td>0 days</td></tr></table></body></html>"
  assert.deepEqual(parseGoPrivacy(html, { now: FIXED_NOW }), [])
})

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("classifyRetentionCell: multi-value cells take the worst signal", () => {
  assert.equal(classifyRetentionCell("0 days"), "zero")
  assert.equal(classifyRetentionCell("0 days*"), "zero")
  assert.equal(classifyRetentionCell("0-day retention"), "zero")
  assert.equal(classifyRetentionCell("30 days"), "30d")
  assert.equal(classifyRetentionCell("0 days, 30 days"), "30d")
  assert.equal(classifyRetentionCell("0 days (Global), 30 days (other regions)"), "30d")
  assert.equal(classifyRetentionCell("14 days"), "unknown")
  assert.equal(classifyRetentionCell("0 days, 14 days"), "unknown")
  assert.equal(classifyRetentionCell("0 days, data may be used to improve the model"), "training")
})

test("classifyRetentionCell: negation never becomes zero", () => {
  for (const value of [
    "not zero",
    "not 0 days",
    "not a zero-retention policy",
    "does not offer zero",
    "does not offer zero data retention",
    "non-zero-retention",
    "no zero data retention",
    "zero-retention is not offered",
    "Not ZDR",
  ]) {
    assert.equal(classifyRetentionCell(value), "not-zdr", value)
  }
})

test("classifyTrainingCell recognises Yes* variants", () => {
  assert.equal(classifyTrainingCell("Yes"), "training")
  assert.equal(classifyTrainingCell("Yes*"), "training")
  assert.equal(classifyTrainingCell("Yes (opt-in)"), "training")
  assert.equal(classifyTrainingCell("Yes (limited)"), "training")
  assert.equal(classifyTrainingCell("No"), undefined)
  assert.equal(classifyTrainingCell("Not used"), undefined)
})

test("parseGoPrivacy: training dominates retention, including Yes*", () => {
  const html = goPage(
    [
      ["Mystery X", "mystery-x"],
      ["Opt In", "opt-in"],
      ["Limited", "limited"],
    ],
    [
      ["Mystery X", "Yes*", "0 days"],
      ["Opt In", "Yes (opt-in)", "0 days"],
      ["Limited", "Yes (limited)", "0 days"],
    ],
  )
  const map = byId(parseGoPrivacy(html, { now: FIXED_NOW }), "opencode-go")
  assert.ok(map)
  assert.equal(map.get("mystery-x")?.retention, "training")
  assert.equal(map.get("opt-in")?.retention, "training")
  assert.equal(map.get("limited")?.retention, "training")
  assert.match(map.get("mystery-x")?.reason ?? "", /training="Yes\*"/)
  assert.match(map.get("mystery-x")?.reason ?? "", /retention="0 days"/)
})

test("parseGoPrivacy: unknown day values and duplicate rows fail closed", () => {
  const html = goPage(
    [
      ["Kimi K3", "kimi-k3"],
      ["Future Model", "future-model"],
      ["Multi Day", "multi-day"],
    ],
    [
      ["Kimi K3", "Not used", "0 days"],
      ["Kimi K3", "Not used", "14 days"],
      ["Future Model", "Not used", "7 days"],
      ["Multi Day", "Not used", "0 days, 30 days"],
    ],
  )
  const policies = parseGoPrivacy(html, { now: FIXED_NOW })
  const map = byId(policies, "opencode-go")
  assert.ok(map)
  assert.equal(map.get("kimi-k3")?.retention, "unknown")
  assert.equal(map.get("future-model")?.retention, "unknown")
  assert.equal(map.get("multi-day")?.retention, "30d")
  assert.equal(
    policies.filter((policy) => policy.modelID === "kimi-k3").length,
    1,
    "duplicate (provider, modelID) rows must collapse to one policy",
  )
})

test("parseGoPrivacy: expired and unknown conditional zero fail closed", () => {
  const expired = parseGoPrivacy(readFixture("expired-footnote.html"), { now: FIXED_NOW })
  const expiredPolicy = expired.find((policy) => policy.modelID === "deepseek-v4.1-flash")
  assert.ok(expiredPolicy)
  assert.equal(expiredPolicy.retention, "unknown")
  assert.match(expiredPolicy.reason, /expired|validity/i)

  const noFootnote = goPage(
    [["DeepSeek V4.1 Flash", "deepseek-v4.1-flash"]],
    [["DeepSeek V4.1 Flash", "Not used", "0 days*"]],
  )
  const unknown = parseGoPrivacy(noFootnote, { now: FIXED_NOW }).find(
    (policy) => policy.modelID === "deepseek-v4.1-flash",
  )
  assert.equal(unknown?.retention, "unknown")
  assert.match(unknown?.reason ?? "", /validity window is unknown|footnote not found/i)

  const current = parseGoPrivacy(goHtml, { now: FIXED_NOW }).find(
    (policy) => policy.modelID === "deepseek-v4.1-flash",
  )
  assert.equal(current?.retention, "zero")
  assert.equal(current?.validUntil, "2026-11-30")
})

// ---------------------------------------------------------------------------
// Console parser
// ---------------------------------------------------------------------------

test("parseConsolePrivacy extracts the live exceptions, including Pulse", () => {
  const map = byId(parseConsolePrivacy(modelsHtml, { now: FIXED_NOW }), "opencode")
  assert.ok(map)
  assert.equal(map.get("pulse-alpha-free")?.retention, "training")
  assert.equal(map.get("big-pickle")?.retention, "training")
  assert.equal(map.get("flint-40b-free")?.retention, "training")
  assert.equal(map.get("beam-free")?.retention, "30d")
  assert.equal(map.get("family:gpt")?.retention, "30d")
  assert.equal(map.get("family:claude")?.retention, "30d")
  assert.equal(map.get("family:mistral")?.retention, "not-zdr")
})

test("mutation guard: Nemotron can never classify as zero", () => {
  const policies = parseConsolePrivacy(modelsHtml, { now: FIXED_NOW })
  const nemotrons = policies.filter((policy) => policy.modelID.startsWith("nemotron-"))
  assert.equal(nemotrons.length, 3)
  for (const policy of nemotrons) {
    assert.equal(policy.retention, "not-zdr")
    assert.notEqual(policy.retention, "zero")
  }

  const map = toPolicyMap(policies)
  const resolved = resolveRetention("opencode", "nemotron-3-ultra-free", map)
  assert.equal(resolved.retention, "not-zdr")
  assert.equal(isAllowed(resolved, false), false)
  assert.equal(isAllowed(resolved, true), false)
})

test("mutation guard: a live 14 days row cannot become zero", () => {
  const mutated = goHtml.replace(
    /(<td>Kimi K3<\/td><td>Not used<\/td><td>)0 days(<\/td>)/,
    "$114 days$2",
  )
  assert.notEqual(mutated, goHtml, "fixture mutation must apply")
  const policies = parseGoPrivacy(mutated, { now: FIXED_NOW })
  const kimi = policies.find((policy) => policy.modelID === "kimi-k3")
  assert.equal(kimi?.retention, "unknown")
  assert.notEqual(kimi?.retention, "zero")

  const snapshot = toPolicyMap(GO_POLICIES).get("opencode-go")
  const live = toPolicyMap(policies).get("opencode-go")
  assert.equal(snapshot?.get("kimi-k3")?.retention, "zero")
  assert.ok(live)
  const merged = new Map(snapshot)
  for (const [key, policy] of live) merged.set(key, policy)
  const resolved = resolveRetention("opencode-go", "kimi-k3", new Map([["opencode-go", merged]]))
  assert.equal(resolved.retention, "unknown")
  assert.equal(isAllowed(resolved, false), false)
})

test("parseConsolePrivacy respects the privacy section boundary", () => {
  const html = consolePage(
    [
      ["Kimi K3", "kimi-k3"],
      ["Evil Model", "evil-model"],
    ],
    ["Kimi K3: Requests follow a zero-retention policy."],
    '<ul><li>Evil Model: Collected data may be used to improve the model.</li></ul>',
  )
  const map = byId(parseConsolePrivacy(html, { now: FIXED_NOW }), "opencode")
  assert.ok(map)
  assert.equal(map.get("kimi-k3")?.retention, "zero")
  assert.equal(map.get("evil-model"), undefined, "later sections must not create policies")

  const wrapped = `<html><body>${endpointTable([["Kimi K3", "kimi-k3"]])}
    <section id="privacy"><h2>Privacy</h2><ul>
      <li>Kimi K3: Requests follow a zero-retention policy.</li>
    </ul></section><h2>Other</h2>
    <ul><li>Kimi K3: Requests are retained for 30 days.</li></ul></body></html>`
  const wrappedMap = byId(parseConsolePrivacy(wrapped, { now: FIXED_NOW }), "opencode")
  assert.equal(
    wrappedMap?.get("kimi-k3")?.retention,
    "zero",
    "id on a wrapping section must still bound the privacy block",
  )
})

test("parseConsolePrivacy ignores colons in URLs/times and creates no junk IDs", () => {
  const html = consolePage(
    [["Kimi K3", "kimi-k3"]],
    [
      "See https://example.com/policy: Kimi K3 has zero-retention.",
      "Peak hours are 01:00-04:00: Kimi K3 has zero-retention.",
      "Kimi K3: This provider does not offer zero-retention; data is kept for 30 days.",
    ],
  )
  const policies = parseConsolePrivacy(html, { now: FIXED_NOW })
  assert.equal(policies.length, 1)
  assert.equal(policies[0].modelID, "kimi-k3")
  assert.equal(policies[0].retention, "not-zdr")
})

test("parseConsolePrivacy negation, multi-value and unclassified bullets fail closed", () => {
  const html = consolePage(
    [
      ["Not Zero", "not-zero"],
      ["Non Zero", "non-zero"],
      ["No Zero", "no-zero"],
      ["Multi Day", "multi-day"],
      ["Mystery Model", "mystery-model"],
    ],
    [
      "Not Zero: This endpoint does not offer zero-retention; data is kept for 30 days.",
      "Non Zero: Requests are non-zero-retention and retained indefinitely.",
      "No Zero: There is no zero data retention option.",
      "Multi Day: Requests are retained for 0 days in one region and 30 days in another region.",
      "Mystery Model: Some new policy wording that is not understood.",
    ],
  )
  const policies = parseConsolePrivacy(html, { now: FIXED_NOW })
  const map = byId(policies, "opencode")
  assert.ok(map)
  assert.equal(map.get("not-zero")?.retention, "not-zdr")
  assert.equal(map.get("non-zero")?.retention, "not-zdr")
  assert.equal(map.get("no-zero")?.retention, "not-zdr")
  assert.equal(map.get("multi-day")?.retention, "30d")
  assert.equal(map.get("mystery-model")?.retention, "unknown")
  assert.match(map.get("mystery-model")?.reason ?? "", /fail-closed/)
})

test("parseConsolePrivacy makes API-family bullets meaningful without junk IDs", () => {
  const html = consolePage(
    [],
    [
      "Mistral APIs: Prompts and other inputs are not used for training. Data is retained in accordance with Mistral's Data Retention Policy.",
      "Mistral endpoints: Data is retained under the provider policy.",
      "OpenAI APIs: Requests are retained for 30 days.",
    ],
  )
  const policies = parseConsolePrivacy(html, { now: FIXED_NOW })
  const map = byId(policies, "opencode")
  assert.ok(map)
  assert.equal(map.get("family:mistral")?.retention, "not-zdr")
  assert.equal(map.get("family:gpt")?.retention, "30d")
  assert.equal(
    policies.some((policy) => /mistralapis|mistralendpoints|openai/iu.test(policy.modelID)),
    false,
    "family bullets must not become junk model IDs",
  )
})

// ---------------------------------------------------------------------------
// Fetch resilience
// ---------------------------------------------------------------------------

function liveFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input)
  if (url.startsWith(GO_PAGE_URL)) return Promise.resolve(new Response(goHtml))
  if (url.startsWith(CONSOLE_PAGE_URL)) return Promise.resolve(new Response(modelsHtml))
  return Promise.reject(new Error(`unexpected fetch: ${url}`))
}

test("fetchRetentionPolicies returns per-provider live data", async () => {
  const result = await fetchRetentionPolicies(liveFetch as typeof fetch)
  assert.equal(result.complete, true)
  assert.deepEqual(Object.keys(result.providers).sort(), ["opencode", "opencode-go"])
  assert.deepEqual(result.sources.sort(), [CONSOLE_PAGE_URL, GO_PAGE_URL].sort())

  const go = result.providers["opencode-go"]
  const consoleProvider = result.providers["opencode"]
  assert.equal(go.complete, true)
  assert.equal(consoleProvider.complete, true)
  assert.ok(Number.isFinite(Date.parse(go.fetchedAt)))
  assert.ok(Number.isFinite(Date.parse(consoleProvider.fetchedAt)))

  const goMap = toPolicyMap(go.policies).get("opencode-go")
  const consoleMap = toPolicyMap(consoleProvider.policies).get("opencode")
  assert.equal(goMap?.get("kimi-k3")?.retention, "zero")
  assert.equal(goMap?.get("muse-spark-1.3-contributor")?.retention, "training")
  assert.equal(consoleMap?.get("pulse-alpha-free")?.retention, "training")
  assert.equal(consoleMap?.get("nemotron-3-ultra-free")?.retention, "not-zdr")
  assert.equal(consoleMap?.get("family:mistral")?.retention, "not-zdr")
})

test("one page failure still returns the other page's policies", async () => {
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.startsWith(GO_PAGE_URL)) return new Response(goHtml)
    return new Response("service unavailable", { status: 503 })
  }
  const result = await fetchRetentionPolicies(fakeFetch as typeof fetch)
  assert.equal(result.complete, false)
  assert.deepEqual(result.sources, [GO_PAGE_URL])
  assert.equal(result.providers["opencode-go"].complete, true)
  assert.ok(result.providers["opencode-go"].policies.length > 0)
  assert.equal(result.providers["opencode"].complete, false)
  assert.match(result.providers["opencode"].error ?? "", /503/)
  assert.deepEqual(result.providers["opencode"].policies, [])
})

test("empty and malformed 200 responses are incomplete, never cache-worthy", async () => {
  const empty = await fetchRetentionPolicies(
    (async () => new Response("<html><body>no tables here</body></html>")) as typeof fetch,
  )
  assert.equal(empty.complete, false)
  assert.deepEqual(empty.sources, [])
  for (const provider of Object.values(empty.providers)) {
    assert.equal(provider.complete, false)
    assert.deepEqual(provider.policies, [])
    assert.match(provider.error ?? "", /zero policies/)
  }

  const malformed = await fetchRetentionPolicies(
    (async () => new Response("<table><tr><td>unterminated")) as typeof fetch,
  )
  assert.equal(malformed.complete, false)
  for (const provider of Object.values(malformed.providers)) {
    assert.equal(provider.complete, false)
    assert.deepEqual(provider.policies, [])
  }
})

test("partial parse keeps the successful page and marks the empty page incomplete", async () => {
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.startsWith(GO_PAGE_URL)) return new Response("<html></html>")
    return new Response(modelsHtml)
  }
  const result = await fetchRetentionPolicies(fakeFetch as typeof fetch)
  assert.equal(result.complete, false)
  assert.deepEqual(result.sources, [CONSOLE_PAGE_URL])
  assert.equal(result.providers["opencode-go"].complete, false)
  assert.equal(result.providers["opencode"].complete, true)
  assert.equal(
    toPolicyMap(result.providers["opencode"].policies).get("opencode")?.get("pulse-alpha-free")
      ?.retention,
    "training",
  )
})

test("fetchRetentionPolicies de-duplicates by provider/model with worst-signal merge", async () => {
  const duplicated = goHtml.replace(
    "<tr><td>Kimi K3</td><td>Not used</td><td>0 days</td></tr>",
    "<tr><td>Kimi K3</td><td>Not used</td><td>0 days</td></tr>" +
      "<tr><td>Kimi K3</td><td>Not used</td><td>14 days</td></tr>",
  )
  assert.notEqual(duplicated, goHtml)
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.startsWith(GO_PAGE_URL)) return new Response(duplicated)
    return new Response(modelsHtml)
  }
  const result = await fetchRetentionPolicies(fakeFetch as typeof fetch)
  const kimi = result.providers["opencode-go"].policies.filter(
    (policy) => policy.modelID === "kimi-k3",
  )
  assert.equal(kimi.length, 1)
  assert.equal(kimi[0].retention, "unknown")
})

test("per-attempt timeout and external abort are bounded even if fetch ignores signals", async () => {
  const hanging = (() => new Promise<Response>(() => {})) as typeof fetch

  const timeoutStarted = Date.now()
  const timedOut = await fetchRetentionPolicies(hanging, 25)
  const timeoutElapsed = Date.now() - timeoutStarted
  assert.ok(timeoutElapsed < 1000, `timeout took ${timeoutElapsed}ms`)
  assert.equal(timedOut.complete, false)
  for (const provider of Object.values(timedOut.providers)) {
    assert.equal(provider.complete, false)
    assert.match(provider.error ?? "", /timed out/i)
  }

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  const abortStarted = Date.now()
  const aborted = await fetchRetentionPolicies(hanging, 5_000, controller.signal)
  const abortElapsed = Date.now() - abortStarted
  assert.ok(abortElapsed < 1000, `abort took ${abortElapsed}ms`)
  assert.equal(aborted.complete, false)
  for (const provider of Object.values(aborted.providers)) {
    assert.equal(provider.complete, false)
    assert.match(provider.error ?? "", /abort/i)
  }
})

test("a hanging page does not discard a successful page before the deadline", async () => {
  const fakeFetch = (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.startsWith(GO_PAGE_URL)) return Promise.resolve(new Response(goHtml))
    return new Promise<Response>(() => {})
  }
  const started = Date.now()
  const result = await fetchRetentionPolicies(fakeFetch as typeof fetch, 25)
  assert.ok(Date.now() - started < 1000)
  assert.equal(result.complete, false)
  assert.equal(result.providers["opencode-go"].complete, true)
  assert.ok(result.providers["opencode-go"].policies.length > 0)
  assert.equal(result.providers["opencode"].complete, false)
  assert.match(result.providers["opencode"].error ?? "", /timed out/i)
})
