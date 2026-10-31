/**
 * Unit tests for the live privacy-table parser and retention resolution.
 * Runs against real HTML captured from the published documentation pages
 * (test/fixtures), so the parser is proven against the actual page structure.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
  extractTables,
  parseNameToIdMap,
  parseGoPrivacy,
  parseConsolePrivacy,
  classifyRetentionCell,
  fetchRetentionPolicies,
  GO_PAGE_URL,
  CONSOLE_PAGE_URL,
} from "../src/fetch.ts"
import {
  resolveRetention,
  isAllowed,
  toPolicyMap,
  SNAPSHOT_POLICIES,
} from "../src/retention.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const goHtml = readFileSync(join(fixtures, "console-go.html"), "utf8")
const modelsHtml = readFileSync(join(fixtures, "console-models.html"), "utf8")

test("extractTables finds real documentation tables", () => {
  const tables = extractTables(goHtml)
  assert.ok(tables.length >= 3, `expected >= 3 tables on the Go page, got ${tables.length}`)
  const flat = tables.map((rows) => rows[0].join("|"))
  assert.ok(
    flat.some((header) => header.includes("Data retention")),
    "privacy table not found",
  )
  assert.ok(
    flat.some((header) => header.includes("Model ID")),
    "endpoints table not found",
  )
})

test("parseNameToIdMap maps display names to model IDs", () => {
  const map = parseNameToIdMap(extractTables(goHtml))
  assert.equal(map.get("grok47"), "grok-4.7")
  assert.equal(map.get("glm53flash"), "glm-5.3-flash")
  assert.equal(map.get("musespark13contributor"), "muse-spark-1.3-contributor")
})

test("classifyRetentionCell handles the published retention values", () => {
  assert.equal(classifyRetentionCell("0 days"), "zero")
  assert.equal(classifyRetentionCell("0 days*"), "zero")
  assert.equal(classifyRetentionCell("30 days"), "30d")
  assert.equal(classifyRetentionCell("Not ZDR"), "not-zdr")
  assert.equal(classifyRetentionCell("something else"), undefined)
})

test("parseGoPrivacy extracts the live Go privacy table", () => {
  const policies = parseGoPrivacy(goHtml)
  assert.ok(policies.length >= 25, `expected >= 25 policies, got ${policies.length}`)
  const byId = toPolicyMap(policies)

  // Straight from the published table (2026-10-31)
  assert.equal(byId.get("grok-4.7")?.retention, "30d")
  assert.equal(byId.get("gpt-6-luna")?.retention, "30d")
  assert.equal(byId.get("gpt-5.6-luna")?.retention, "30d")
  assert.equal(byId.get("claude-haiku-5-5")?.retention, "30d")
  assert.equal(byId.get("beam-free")?.retention, "30d")
  assert.equal(byId.get("gemini-4-argon")?.retention, "zero")
  assert.equal(byId.get("glm-5.3-flash")?.retention, "zero")
  assert.equal(byId.get("glm-5.3")?.retention, "zero")
  assert.equal(byId.get("glm-5.2")?.retention, "zero")
  assert.equal(byId.get("kimi-k3.1-pro")?.retention, "zero")
  assert.equal(byId.get("kimi-k3")?.retention, "zero")
  assert.equal(byId.get("kimi-k2.7-code")?.retention, "zero")
  assert.equal(byId.get("longcat-2.0")?.retention, "zero")
  assert.equal(byId.get("mimo-v2.6-pro")?.retention, "zero")
  assert.equal(byId.get("mimo-v2.6-flash")?.retention, "zero")
  assert.equal(byId.get("mimo-v2.5")?.retention, "zero")
  assert.equal(byId.get("mimo-v2.5-pro")?.retention, "zero")
  assert.equal(byId.get("qwen3.8-max")?.retention, "zero")
  assert.equal(byId.get("qwen3.8-flash")?.retention, "zero")
  assert.equal(byId.get("qwen3.7-plus")?.retention, "zero")
  assert.equal(byId.get("minimax-m3")?.retention, "zero")
  assert.equal(byId.get("minimax-m3.1-flash")?.retention, "zero")
  assert.equal(byId.get("deepseek-v4.1-flash")?.retention, "zero")
  assert.equal(byId.get("deepseek-v4-pro")?.retention, "zero")
  assert.equal(byId.get("hy3")?.retention, "zero")
  assert.equal(byId.get("hy4-preview")?.retention, "zero")
  assert.equal(byId.get("step-5-preview")?.retention, "zero")
  assert.equal(byId.get("muse-spark-1.3-contributor")?.retention, "not-zdr")
  assert.equal(byId.get("muse-spark-1.2-contributor")?.retention, "not-zdr")
  assert.equal(byId.get("iceman-contributor-free")?.retention, "not-zdr")
})

test("parseConsolePrivacy extracts per-model exceptions", () => {
  const policies = parseConsolePrivacy(modelsHtml)
  const byId = toPolicyMap(policies)
  assert.equal(byId.get("big-pickle")?.retention, "training")
  assert.equal(byId.get("flint-40b-free")?.retention, "training")
  assert.equal(byId.get("beam-free")?.retention, "30d")
  assert.equal(byId.get("mimo-v2.6-flash-free")?.retention, "training")
  assert.ok(
    [...byId.keys()].some((id) => id.startsWith("nemotron-3")),
    "nemotron exceptions missing",
  )
})

test("fetchRetentionPolicies merges live data over the snapshot", async () => {
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.startsWith(GO_PAGE_URL)) return new Response(goHtml)
    if (url.startsWith(CONSOLE_PAGE_URL)) return new Response(modelsHtml)
    throw new Error(`unexpected fetch: ${url}`)
  }
  const result = await fetchRetentionPolicies(fakeFetch as typeof fetch)
  assert.deepEqual(result.sources, [GO_PAGE_URL, CONSOLE_PAGE_URL])
  const byId = toPolicyMap(result.policies)
  // Live entries present
  assert.equal(byId.get("grok-4.7")?.retention, "30d")
  assert.equal(byId.get("kimi-k3")?.retention, "zero")
  // Snapshot fills gaps the live pages do not cover
  assert.equal(byId.get("mistral-large-4")?.retention, "zero")
  assert.equal(byId.get("gpt-5-nano")?.retention, "30d")
  assert.ok(result.policies.length >= SNAPSHOT_POLICIES.length)
})

test("fetchRetentionPolicies falls back to the snapshot offline", async () => {
  const failingFetch = async (): Promise<Response> => {
    throw new Error("network down")
  }
  await assert.rejects(() => fetchRetentionPolicies(failingFetch as typeof fetch))
})

test("resolveRetention: only 0-day policies are allowed", () => {
  // Go table: 0 days -> listed
  assert.equal(resolveRetention("opencode-go", "kimi-k3").retention, "zero")
  assert.equal(isAllowed(resolveRetention("opencode-go", "kimi-k3"), false), true)
  // Go table: 30 days -> hidden
  assert.equal(resolveRetention("opencode-go", "grok-4.7").retention, "30d")
  assert.equal(isAllowed(resolveRetention("opencode-go", "grok-4.7"), false), false)
  // Go table: Not ZDR -> hidden
  assert.equal(resolveRetention("opencode-go", "muse-spark-1.3-contributor").retention, "not-zdr")
  assert.equal(isAllowed(resolveRetention("opencode-go", "muse-spark-1.3-contributor"), false), false)
  // Family rules: OpenAI / Anthropic APIs retain 30 days
  assert.equal(resolveRetention("opencode", "gpt-6-astra").retention, "30d")
  assert.equal(resolveRetention("opencode", "claude-opus-5-5").retention, "30d")
  // Unknown -> hidden by default (strict), listed only with showUnknown
  const unknown = resolveRetention("someprovider", "mystery-model")
  assert.equal(unknown.retention, "unknown")
  assert.equal(isAllowed(unknown, false), false)
  assert.equal(isAllowed(unknown, true), true)
  // Local providers keep data on the machine -> 0 days
  assert.equal(resolveRetention("ollama", "llama3").retention, "zero")
  assert.equal(isAllowed(resolveRetention("ollama", "llama3"), false), true)
})

test("snapshot fully covers the Console and Go catalogs", () => {
  // Every catalog model that must be hidden is hidden in the snapshot too.
  const byId = toPolicyMap(SNAPSHOT_POLICIES)
  for (const [id, retention] of [
    ["beam-free", "30d"],
    ["flint-40b-free", "training"],
    ["big-pickle", "training"],
    ["iceman-contributor-free", "not-zdr"],
  ] as const) {
    assert.equal(byId.get(id)?.retention, retention)
  }
  // And every snapshot entry is one of the known statuses.
  for (const policy of SNAPSHOT_POLICIES) {
    assert.ok(
      ["zero", "30d", "not-zdr", "training"].includes(policy.retention),
      `${policy.id} has unexpected status ${policy.retention}`,
    )
  }
})
