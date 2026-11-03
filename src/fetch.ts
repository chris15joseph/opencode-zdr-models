/**
 * Live data pipeline for retention policies.
 *
 * Fetches and parses the published privacy tables:
 *
 * - https://opencode.ai/v2/docs/console/go#privacy
 *   Go catalog: "Model | Model training | Data retention" table.
 * - https://opencode.ai/v2/docs/console/models#privacy
 *   Console catalog: privacy baseline plus per-model exception bullets.
 *
 * Both pages also publish a "Model | Model ID | ..." endpoints table which is
 * used to map display names to stable model IDs. Names are never fabricated
 * into IDs when the endpoints table has no mapping.
 *
 * The two pages are fetched independently (Promise.allSettled), so one page
 * failing does not discard the other page's successful data. Each provider
 * result reports `complete`; an empty parse is not complete and must not
 * replace a previous cache entry.
 */

import {
  type Retention,
  type ScopedPolicy,
  toPolicyMap,
  worstRetention,
} from "./retention.ts"

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

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

interface Tag {
  name: string
  closing: boolean
  start: number
  end: number
}

/** Read the next `<...>` tag, respecting quoted attributes. */
function readTag(html: string, start: number): Tag | undefined {
  if (html[start] !== "<") return undefined
  let quote: string | undefined
  let i = start + 1
  for (; i < html.length; i++) {
    const ch = html[i]
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ">") break
  }
  if (i >= html.length) return undefined
  const body = html.slice(start + 1, i).trim()
  const closing = body.startsWith("/")
  const name = body.replace(/^\//, "").match(/^[a-zA-Z0-9:-]+/)?.[0]?.toLowerCase() ?? ""
  return { name, closing, start, end: i + 1 }
}

/** Find the matching `</table>` for an opening table tag. */
function matchingTableEnd(html: string, contentStart: number): { start: number; end: number } {
  let depth = 1
  let i = contentStart
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt < 0) break
    const tag = readTag(html, lt)
    if (!tag) {
      i = lt + 1
      continue
    }
    if (tag.name === "table") {
      depth += tag.closing ? -1 : 1
      if (depth === 0) return { start: tag.start, end: tag.end }
    }
    i = tag.end
  }
  return { start: html.length, end: html.length }
}

interface Cell {
  html: string
  rowspan: number
  colspan: number
}

function parseCellAttributes(tagText: string): { rowspan: number; colspan: number } {
  const span = (name: string) => {
    const match = tagText.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i"))
    const value = match ? Number(match[1]) : 1
    return Number.isFinite(value) && value > 0 ? Math.min(value, 100) : 1
  }
  return { rowspan: span("rowspan"), colspan: span("colspan") }
}

/** Find the end of a cell, ignoring nested tables and nested cells. */
function findCellEnd(html: string, contentStart: number): { contentEnd: number; end: number } {
  let cellDepth = 1
  let tableDepth = 0
  let i = contentStart
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt < 0) break
    const tag = readTag(html, lt)
    if (!tag) {
      i = lt + 1
      continue
    }
    if (tag.name === "table") tableDepth += tag.closing ? -1 : 1
    if (tableDepth === 0 && (tag.name === "td" || tag.name === "th")) {
      cellDepth += tag.closing ? -1 : 1
      if (cellDepth === 0) return { contentEnd: tag.start, end: tag.end }
    }
    i = tag.end
  }
  return { contentEnd: html.length, end: html.length }
}

function parseCells(rowHtml: string): Cell[] {
  const cells: Cell[] = []
  let i = 0
  while (i < rowHtml.length) {
    const lt = rowHtml.indexOf("<", i)
    if (lt < 0) break
    const tag = readTag(rowHtml, lt)
    if (!tag) {
      i = lt + 1
      continue
    }
    if (!tag.closing && (tag.name === "td" || tag.name === "th")) {
      const opening = rowHtml.slice(tag.start, tag.end)
      const { contentEnd, end } = findCellEnd(rowHtml, tag.end)
      const { rowspan, colspan } = parseCellAttributes(opening)
      cells.push({ html: rowHtml.slice(tag.end, contentEnd), rowspan, colspan })
      i = end
      continue
    }
    i = tag.end
  }
  return cells
}

/** Parse a `<tr>` at depth 0 into cells, expanding rowspan/colspan. */
function parseTableRows(inner: string): string[][] {
  const occupied = new Map<string, string>()
  let rowIndex = 0
  let i = 0
  while (i < inner.length) {
    const lt = inner.indexOf("<", i)
    if (lt < 0) break
    const tag = readTag(inner, lt)
    if (!tag) {
      i = lt + 1
      continue
    }
    if (tag.name === "tr" && !tag.closing) {
      // Find this row's matching </tr> at table depth 0.
      let depth = 1
      let j = tag.end
      let rowEnd = inner.length
      while (j < inner.length) {
        const next = inner.indexOf("<", j)
        if (next < 0) break
        const rowTag = readTag(inner, next)
        if (!rowTag) {
          j = next + 1
          continue
        }
        if (rowTag.name === "table") depth += rowTag.closing ? -1 : 1
        if (depth === 1 && rowTag.name === "tr" && rowTag.closing) {
          rowEnd = rowTag.start
          j = rowTag.end
          break
        }
        j = rowTag.end
      }
      const cells = parseCells(inner.slice(tag.end, rowEnd))
      let col = 0
      for (const cell of cells) {
        col = 0
        while (occupied.has(`${rowIndex},${col}`)) col++
        const text = stripTags(cell.html)
        for (let r = rowIndex; r < rowIndex + cell.rowspan; r++) {
          for (let c = col; c < col + cell.colspan; c++) {
            occupied.set(`${r},${c}`, text)
          }
        }
      }
      rowIndex++
      i = j
      continue
    }
    if (tag.name === "table") {
      // Skip nested table content; it is not part of the outer grid.
      const close = matchingTableEnd(inner, tag.end)
      i = close.end
      continue
    }
    i = tag.end
  }

  let maxRow = -1
  for (const key of occupied.keys()) {
    const row = Number(key.slice(0, key.indexOf(",")))
    if (row > maxRow) maxRow = row
  }
  const rows: string[][] = []
  for (let r = 0; r <= maxRow; r++) {
    const row: string[] = []
    for (let c = 0; ; c++) {
      const value = occupied.get(`${r},${c}`)
      if (value === undefined) break
      row.push(value)
    }
    rows.push(row)
  }
  return rows
}

/** Extract every top-level `<table>` from HTML as a matrix of cell texts. */
export function extractTables(html: string): string[][][] {
  const clean = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
  const tables: string[][][] = []
  let i = 0
  while (i < clean.length) {
    const lt = clean.indexOf("<", i)
    if (lt < 0) break
    const tag = readTag(clean, lt)
    if (!tag) {
      i = lt + 1
      continue
    }
    if (tag.name === "table" && !tag.closing) {
      const close = matchingTableEnd(clean, tag.end)
      const rows = parseTableRows(clean.slice(tag.end, close.start))
      if (rows.length > 0) tables.push(rows)
      i = close.end
      continue
    }
    i = tag.end
  }
  return tables
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
}

/**
 * Decode entities in a single pass. Single-pass decoding is deliberate:
 * `&amp;lt;` becomes `&lt;`, not `<`, avoiding double-decoding.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1]?.toLowerCase() === "x"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
      return whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Strip tags (respecting quoted attributes), decode entities, collapse space. */
export function stripTags(html: string): string {
  let out = ""
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt < 0) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)
    const tag = readTag(html, lt)
    if (!tag) {
      out += "<"
      i = lt + 1
      continue
    }
    // Block-level tags act as separators so adjacent cells do not merge words.
    if (/^(br|hr|p|div|li|tr|td|th|h[1-6]|section|article)$/.test(tag.name)) out += " "
    i = tag.end
  }
  return decodeEntities(out).replace(/\s+/g, " ").trim()
}

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

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
  const ambiguous = new Set<string>()
  for (const rows of tables) {
    for (let headerIndex = 0; headerIndex < Math.min(rows.length, 5); headerIndex++) {
      const header = rows[headerIndex]?.map(nameKey) ?? []
      const nameIdx = header.findIndex((cell) => cell === "model" || cell === "modelname")
      const idIdx = header.findIndex((cell) => cell === "modelid" || cell === "id")
      if (nameIdx < 0 || idIdx < 0 || nameIdx === idIdx) continue
      for (const row of rows.slice(headerIndex + 1)) {
        const name = row[nameIdx]?.trim()
        const id = row[idIdx]?.trim().toLowerCase()
        if (!name || !id) continue
        if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(id) || id.includes("http")) continue
        const key = nameKey(name)
        if (!key) continue
        const existing = map.get(key)
        if (existing && existing !== id) {
          // A duplicate display name with two IDs is unsafe to guess. Drop it
          // so rows that depend on the mapping are skipped rather than
          // silently assigned to the wrong model.
          ambiguous.add(key)
          map.delete(key)
          continue
        }
        if (!ambiguous.has(key)) map.set(key, id)
      }
      break
    }
  }
  return map
}

function toID(name: string, nameToId: Map<string, string>): string | undefined {
  return nameToId.get(nameKey(name))
}

function dedupePolicies(policies: readonly ScopedPolicy[]): ScopedPolicy[] {
  return [...toPolicyMap(policies).values()].flatMap((provider) => [...provider.values()])
}

/** Classify a "Data retention" table cell. Multiple signals take the worst. */
export function classifyRetentionCell(cell: string): Retention | undefined {
  const text = stripTags(cell).toLowerCase()
  if (!text) return undefined

  // Negation must be checked before any positive "zero" match.
  if (
    /\bnot\s+zdr\b|\bnon[- ]zero\b|\bnot\s+zero\b|\bno\s+zero\b|\bdoes(?:n't| not)\s+(?:offer|provide)\s+(?:zero|0)\b|\bzero[- ](?:data[- ])?retention\s+(?:is\s+)?not\b/.test(
      text,
    )
  ) {
    return "not-zdr"
  }

  const dayValues = [...text.matchAll(/(\d+)\s*(?:days?|d)\b/g)].map((match) => Number(match[1]))
  if (dayValues.length > 0) {
    const worstDays = Math.max(...dayValues)
    if (worstDays === 0) return "zero"
    if (worstDays === 30) return "30d"
    // A published value we do not model (7/14/60 days) fails closed.
    return "unknown"
  }

  if (/\bzero[- ](?:data[- ])?retention\b/.test(text)) return "zero"
  if (/\bnot\s+zdr\b/.test(text)) return "not-zdr"
  if (/retained|retention|logged|trial|\blog\b|not used for training/.test(text)) {
    return "not-zdr"
  }
  return undefined
}

/** Classify a "Model training" table cell. Any `Yes*` variant dominates. */
export function classifyTrainingCell(cell: string): Retention | undefined {
  const text = stripTags(cell).toLowerCase().trim()
  if (!text) return undefined
  if (/^yes\b/.test(text)) return "training"
  if (/^(?:true|used|opt[- ]in)\b/.test(text)) return "training"
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function conditionalFromFootnote(
  html: string,
  name: string,
  cell: string,
): { validUntil?: string; conditions?: string } {
  if (!cell.includes("*")) return {}
  const plain = stripTags(html)
  const family = name.split(/\s+/)[0] ?? name
  const index = plain.toLowerCase().indexOf(`${family.toLowerCase()}:`)
  if (index < 0) return { conditions: "conditional zero; footnote not found" }
  const snippet = plain.slice(index, index + 500)
  const dateMatch = snippet.match(/valid through ([A-Z][a-z]+ \d{1,2}, \d{4})/i)
  const conditions = snippet.split(/(?<=\.)\s+/)[0]?.slice(0, 300) ?? snippet.slice(0, 300)
  if (!dateMatch) return { conditions: `${conditions} (validity window not found)` }
  const parsed = Date.parse(dateMatch[1])
  return {
    conditions,
    validUntil: Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined,
  }
}

/**
 * Parse the Go privacy table: "Model | Model training | Data retention".
 * Training dominates retention. Names are converted to model IDs through the
 * endpoints table; rows without a mapping are skipped rather than guessed.
 */
export function parseGoPrivacy(html: string): ScopedPolicy[] {
  const tables = extractTables(html)
  const nameToId = parseNameToIdMap(tables)
  const policies: ScopedPolicy[] = []
  const today = new Date().toISOString().slice(0, 10)

  for (const rows of tables) {
    for (let headerIndex = 0; headerIndex < Math.min(rows.length, 5); headerIndex++) {
      const header = rows[headerIndex]?.map(nameKey) ?? []
      const modelIdx = header.findIndex((cell) => cell === "model")
      const trainingIdx = header.findIndex(
        (cell) => cell === "modeltraining" || cell === "training",
      )
      const retentionIdx = header.findIndex(
        (cell) => cell === "dataretention" || cell === "retention",
      )
      if (modelIdx < 0 || retentionIdx < 0) continue

      for (const row of rows.slice(headerIndex + 1)) {
        const name = row[modelIdx]?.trim()
        if (!name || nameKey(name) === "model") continue
        const trainingRaw = trainingIdx >= 0 ? (row[trainingIdx] ?? "").trim() : ""
        const retentionRaw = (row[retentionIdx] ?? "").trim()
        if (!trainingRaw && !retentionRaw) continue

        const id = toID(name, nameToId)
        if (!id) continue

        const training = classifyTrainingCell(trainingRaw)
        const retention = classifyRetentionCell(retentionRaw)
        let final = worstRetention(training, retention) ?? "unknown"
        const conditional = conditionalFromFootnote(html, name, retentionRaw)
        if (final === "zero" && retentionRaw.includes("*") && !conditional.validUntil) {
          // A conditional zero without a parsed validity window is not safe to
          // treat as unconditional.
          final = "unknown"
        }
        const reasonParts = [
          `Go privacy table (live ${today}): training="${trainingRaw || "?"}", retention="${retentionRaw || "?"}"`,
        ]
        if (conditional.conditions) reasonParts.push(conditional.conditions)
        if (training && training !== retention) reasonParts.push("training dominates retention")
        if (final === "unknown") reasonParts.push("value could not be classified; fail-closed")

        policies.push({
          providerID: "opencode-go",
          modelID: id,
          name,
          retention: final,
          reason: reasonParts.join("; "),
          source: "live",
          validUntil: conditional.validUntil,
          conditions: conditional.conditions,
        })
      }
      break
    }
  }
  return dedupePolicies(policies)
}

const API_FAMILIES: Record<string, string> = {
  openai: "gpt",
  anthropic: "claude",
  mistral: "mistral",
}

function consoleRetention(text: string, family?: string): Retention {
  // Training is the strongest signal and can appear alongside "0 days".
  if (
    /may be (?:retained and )?used to (?:improve|train)|\bused to (?:improve|train)\b|\btrain (?:future|our|the) model\b/i.test(
      text,
    )
  ) {
    return "training"
  }
  // Negation before positive zero matching.
  if (
    /\bnot\s+zdr\b|\bnot\s+zero\b|\bnon[- ]zero\b|\bno\s+zero\b|\bdoes(?:n't| not)\s+(?:offer|provide)\s+(?:zero|0)\b|\bzero[- ](?:data[- ])?retention\s+(?:is\s+)?not\b/i.test(
      text,
    )
  ) {
    return "not-zdr"
  }
  if (/\bretained (?:for|up to) 30 days\b|\bretains it for 30 days\b|\bretained for 30 days for safety\b/i.test(text)) {
    return "30d"
  }
  if (/\bzero[- ](?:data[- ])?retention\b|\b0\s*days?\b/i.test(text)) return "zero"
  if (/\btrial use only\b|\blogged for security\b|\bnot used for training\b|\bdata (?:is )?retained\b/i.test(text)) {
    return "not-zdr"
  }
  if (family === "mistral") return "not-zdr"
  return "unknown"
}

function looksLikeModelSubject(subject: string): boolean {
  if (subject.length === 0 || subject.length > 80) return false
  if (/https?:|\/|\?|@/.test(subject)) return false
  if (/^\d{1,2}:\d{2}/.test(subject)) return false
  if (/^(for|learn|see|note|read|visit|by|with|during)\b/i.test(subject)) return false
  return /^[A-Za-z0-9][A-Za-z0-9 .,'()&+_-]*$/.test(subject)
}

/**
 * Parse the Console privacy section exception bullets.
 *
 * The section is bounded at `id="privacy"` and the next `<h2>`, so bullets in
 * later documentation sections cannot create fake policies. API-family bullets
 * become provider-scoped family policies; unclassified model bullets become
 * `unknown` (fail closed) instead of being silently dropped.
 */
export function parseConsolePrivacy(html: string): ScopedPolicy[] {
  const tables = extractTables(html)
  const nameToId = parseNameToIdMap(tables)
  const policies: ScopedPolicy[] = []
  const today = new Date().toISOString().slice(0, 10)

  const privacyStart = html.search(/\bid\s*=\s*["']privacy["']/i)
  if (privacyStart < 0) return policies
  const afterStart = html.slice(privacyStart)
  let section = afterStart
  const nextHeading = afterStart.search(/<h2\b/i)
  if (nextHeading >= 0) section = afterStart.slice(0, nextHeading)
  const boundary = section.search(/<\/(?:article|aside|footer|main)>/i)
  if (boundary >= 0) section = section.slice(0, boundary)

  const bullets = [...section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((match) =>
    stripTags(match[1]),
  )

  for (const bullet of bullets) {
    const sep = bullet.indexOf(":")
    if (sep <= 0) continue
    const subject = bullet.slice(0, sep).trim()
    const rest = bullet.slice(sep + 1).trim()

    const apiFamily = subject.match(/^(OpenAI|Anthropic|Mistral)\s+APIs?$/i)
    if (apiFamily) {
      const familyName = apiFamily[1].toLowerCase()
      const family = API_FAMILIES[familyName]
      const retention = consoleRetention(rest, family)
      policies.push({
        providerID: "opencode",
        modelID: "*",
        family,
        name: subject,
        retention,
        reason: `Console privacy section (live ${today}): "${rest.slice(0, 200)}"`,
        source: "live",
      })
      continue
    }

    if (!looksLikeModelSubject(subject)) continue
    const id = toID(subject, nameToId)
    // Never fabricate an ID from the display name. Without the endpoints
    // table mapping we cannot safely apply a live policy to a catalog ID.
    if (!id) continue

    const retention = consoleRetention(rest)
    policies.push({
      providerID: "opencode",
      modelID: id,
      name: subject,
      retention,
      reason: `Console privacy section (live ${today}): "${rest.slice(0, 200)}"${retention === "unknown" ? "; bullet could not be classified, fail-closed" : ""}`,
      source: "live",
    })
  }
  return dedupePolicies(policies)
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

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
    PAGES.map(async (page): Promise<ProviderFetchResult> => {
      const fetchedAt = new Date().toISOString()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onAbort = () => controller.abort()
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        const response = await fetchImpl(page.url, { signal: controller.signal })
        if (!response.ok) throw new Error(`${page.url} returned ${response.status}`)
        const html = await response.text()
        const policies = page.parse(html)
        return {
          providerID: page.providerID,
          policies,
          source: page.url,
          fetchedAt,
          complete: policies.length > 0,
          ...(policies.length === 0 ? { error: "page parsed zero policies" } : {}),
        }
      } catch (error) {
        return {
          providerID: page.providerID,
          policies: [],
          source: page.url,
          fetchedAt,
          complete: false,
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
    }),
  )

  const providers: Record<string, ProviderFetchResult> = {}
  for (const item of settled) {
    if (item.status === "fulfilled") {
      providers[item.value.providerID] = item.value
    }
  }
  const sources = Object.values(providers)
    .filter((provider) => provider.complete)
    .map((provider) => provider.source)
  return {
    providers,
    sources,
    fetchedAt: new Date().toISOString(),
    complete: Object.values(providers).every((provider) => provider.complete),
  }
}
