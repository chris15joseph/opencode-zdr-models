/**
 * Live data pipeline for retention policies.
 *
 * Fetches and parses the published privacy tables every time OpenCode loads
 * the plugin (before a coding session starts), because these policies can
 * change at any time:
 *
 * - https://opencode.ai/v2/docs/console/go#privacy
 *   Go catalog: "Model | Model training | Data retention" table.
 * - https://opencode.ai/v2/docs/console/models#privacy
 *   Console catalog: privacy baseline plus per-model exception bullets.
 *
 * Both pages also publish a "Model | Model ID | ..." endpoints table which is
 * used to map display names to stable model IDs.
 */

import {
  type Retention,
  type RetentionPolicy,
  SNAPSHOT_BY_ID,
  toPolicyMap,
} from "./retention.ts"

export const GO_PAGE_URL = "https://opencode.ai/v2/docs/console/go"
export const CONSOLE_PAGE_URL = "https://opencode.ai/v2/docs/console/models"

export interface FetchResult {
  policies: RetentionPolicy[]
  sources: string[]
  fetchedAt: string
}

/** Extract every <table> from HTML as a matrix of stripped cell texts. */
export function extractTables(html: string): string[][][] {
  const tables: string[][][] = []
  for (const tableMatch of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows: string[][] = []
    for (const rowMatch of tableMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells: string[] = []
      for (const cellMatch of rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        cells.push(stripTags(cellMatch[1]))
      }
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length > 0) tables.push(rows)
  }
  return tables
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim()
}

/** Normalize a display name into a comparison key ("GLM-5.3-Flash" == "GLM 5.3 Flash"). */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]/g, "")
}

/** Build display-name -> model-ID map from a "Model | Model ID | ..." table. */
export function parseNameToIdMap(tables: string[][][]): Map<string, string> {
  const map = new Map<string, string>()
  for (const rows of tables) {
    const header = rows[0]?.map(nameKey) ?? []
    const nameIdx = header.findIndex((cell) => cell === "model")
    const idIdx = header.findIndex((cell) => cell === "modelid")
    if (nameIdx < 0 || idIdx < 0) continue
    for (const row of rows.slice(1)) {
      const name = row[nameIdx]
      const id = row[idIdx]
      if (name && id) map.set(nameKey(name), id.trim().toLowerCase())
    }
  }
  return map
}

function toID(name: string, nameToId: Map<string, string>): string {
  return nameToId.get(nameKey(name)) ?? nameKey(name)
}

/** Classify a "Data retention" table cell. */
export function classifyRetentionCell(cell: string): Retention | undefined {
  const text = cell.toLowerCase()
  if (/^0\s*days?/.test(text)) return "zero"
  if (/30\s*days?/.test(text)) return "30d"
  if (/not\s*zdr/.test(text)) return "not-zdr"
  return undefined
}

/** Classify a "Model training" table cell. */
export function classifyTrainingCell(cell: string): Retention | undefined {
  const text = cell.toLowerCase()
  if (text === "yes") return "not-zdr"
  return undefined
}

/**
 * Parse the Go privacy table: "Model | Model training | Data retention".
 * Names are converted to model IDs through the endpoints table on the page.
 */
export function parseGoPrivacy(html: string): RetentionPolicy[] {
  const tables = extractTables(html)
  const nameToId = parseNameToIdMap(tables)
  const policies: RetentionPolicy[] = []
  for (const rows of tables) {
    const header = rows[0]?.map(nameKey) ?? []
    const modelIdx = header.findIndex((cell) => cell === "model")
    const trainingIdx = header.findIndex((cell) => cell === "modeltraining")
    const retentionIdx = header.findIndex((cell) => cell === "dataretention")
    if (modelIdx < 0 || retentionIdx < 0) continue
    for (const row of rows.slice(1)) {
      const name = row[modelIdx]
      if (!name) continue
      const training = trainingIdx >= 0 ? classifyTrainingCell(row[trainingIdx] ?? "") : undefined
      const retention = classifyRetentionCell(row[retentionIdx] ?? "") ?? training
      if (!retention) continue
      policies.push({
        id: toID(name, nameToId),
        name,
        retention,
        reason: `Go privacy table (live ${new Date().toISOString().slice(0, 10)}): training=${row[trainingIdx] ?? "?"}, retention=${row[retentionIdx] ?? "?"}`,
      })
    }
  }
  return policies
}

/**
 * Parse the Console privacy section exception bullets, e.g.
 *   "OpenAI APIs: Requests are retained for 30 days in accordance with ..."
 *   "Big Pickle: During its free period, collected data may be used to ..."
 * Falls back to keyword classification; unclassified bullets are skipped and
 * covered by the bundled snapshot instead.
 */
export function parseConsolePrivacy(html: string): RetentionPolicy[] {
  const tables = extractTables(html)
  const nameToId = parseNameToIdMap(tables)
  const policies: RetentionPolicy[] = []

  const section = html.split(/id="privacy"/i)[1] ?? html.split(/<h2[^>]*>\s*Privacy\s*<\/h2>/i)[1] ?? ""
  const bullets = [...section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1]))

  for (const bullet of bullets) {
    const sep = bullet.indexOf(":")
    if (sep < 0) continue
    const subject = bullet.slice(0, sep).trim()
    // API-family bullets ("OpenAI APIs:", "Anthropic APIs:", "Mistral APIs:")
    // are covered by the static FAMILY_RULES in retention.ts.
    if (/^openai apis?$|^anthropic apis?$|^mistral apis?$/i.test(subject)) continue
    const rest = bullet.slice(sep + 1)
    const text = rest.toLowerCase()

    let retention: Retention | undefined
    if (/zero[- ]retention/.test(text) && !/retained for 30 days/.test(text)) retention = "zero"
    else if (/may be used to (improve|train)/.test(text)) retention = "training"
    else if (/retained for 30 days|retains it for 30 days|retained up to 30 days/.test(text)) retention = "30d"
    else if (/trial use only|logged for security/.test(text)) retention = "not-zdr"
    else if (/zero[- ]data[- ]retention/.test(text)) retention = "zero"
    if (!retention) continue

    const id = toID(subject, nameToId)
    policies.push({
      id: /^openai apis?$|anthropic apis?$|mistral apis?$/i.test(subject) ? subject : id,
      name: subject,
      retention,
      reason: `Console privacy section (live ${new Date().toISOString().slice(0, 10)}): "${rest.slice(0, 120)}"`,
    })
  }
  return policies
}

/**
 * Fetch the current policies from both documentation pages and merge them over
 * the bundled snapshot. Live entries always win for the IDs they cover.
 */
export async function fetchRetentionPolicies(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<FetchResult> {
  const sources: string[] = []
  const live: RetentionPolicy[] = []

  for (const url of [GO_PAGE_URL, CONSOLE_PAGE_URL]) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`${url} returned ${response.status}`)
      const html = await response.text()
      const parsed =
        url === GO_PAGE_URL ? parseGoPrivacy(html) : parseConsolePrivacy(html)
      if (parsed.length > 0) {
        live.push(...parsed)
        sources.push(url)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // Live entries override the snapshot; snapshot fills any gaps.
  const merged = toPolicyMap(live)
  const policies = [...live]
  for (const [id, policy] of SNAPSHOT_BY_ID) {
    if (!merged.has(id)) policies.push(policy)
  }
  return { policies, sources, fetchedAt: new Date().toISOString() }
}
