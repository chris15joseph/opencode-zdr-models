/**
 * Privacy-table parsers for the Console and Go documentation.
 *
 * Policies are provider-scoped: Go rows become `opencode-go` and Console
 * bullets become `opencode`. Display names are mapped through the published
 * endpoints table; an ID is never fabricated from a name.
 */

import { extractTables, stripTags } from "./html.ts"
import {
  type Retention,
  type ScopedPolicy,
  policyExpiry,
  toPolicyMap,
  worstRetention,
} from "./retention.ts"

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
  const nameHeaders = new Set(["model", "modelname", "name", "displayname", "display"])
  const idHeaders = new Set(["modelid", "id", "slug", "modelslug", "modelidslug"])
  for (const rows of tables) {
    for (let headerIndex = 0; headerIndex < Math.min(rows.length, 5); headerIndex++) {
      const header = rows[headerIndex]?.map(nameKey) ?? []
      const nameIdx = header.findIndex((cell) => nameHeaders.has(cell))
      const idIdx = header.findIndex((cell) => idHeaders.has(cell))
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

export function dedupePolicies(policies: readonly ScopedPolicy[]): ScopedPolicy[] {
  return [...toPolicyMap(policies).values()].flatMap((provider) => [...provider.values()])
}

/**
 * Affirmative training signals. Negated phrases ("not used for training") are
 * explicitly excluded so a privacy baseline is not misread as training.
 */
function hasTrainingSignal(text: string): boolean {
  const value = text.toLowerCase()
  if (
    /\bnot\s+(?:be\s+)?used\s+(?:to\s+)?(?:improve|train)|\bnot\s+used\s+for\s+(?:model\s+)?(?:training|improvement)|\bno\s+training\b/.test(
      value,
    )
  ) {
    return false
  }
  return (
    /\b(?:may|can|might|will)\s+(?:be\s+)?(?:retained\s+(?:and\s+)?)?(?:be\s+)?used\s+(?:to\s+)?(?:improve|train)\b/.test(
      value,
    ) ||
    /\bused\s+to\s+(?:improve|train)\b/.test(value) ||
    /\bused\s+for\s+(?:model\s+)?(?:training|improvement)\b/.test(value) ||
    /\bpermission\s+to\s+use\s+your\s+prompts\b[\s\S]{0,120}\b(?:train|improve)\b/.test(value) ||
    /\btrain\s+(?:future|our|the)\s+models?\b/.test(value)
  )
}

/**
 * Classify a "Data retention" table cell.
 *
 * Every recognized signal is considered and the most restrictive wins:
 * `training` > `not-zdr`/`unknown` > `30d` > `zero`. A multi-value cell such as
 * "0 days, 30 days" therefore becomes `30d`, and an unrecognized day count
 * (7/14/60 days) fails closed as `unknown`.
 */
export function classifyRetentionCell(cell: string): Retention | undefined {
  const text = stripTags(cell).toLowerCase()
  if (!text) return undefined

  if (hasTrainingSignal(text)) return "training"

  // Negation must be checked before any positive "zero" match.
  if (
    /\bnot\s+(?:an?\s+)?(?:0\s*[- ]?\s*days?|zero)(?:[- ](?:data[- ])?retention)?\b|\b(?:no|never|without)\s+(?:an?\s+)?(?:0\s*[- ]?\s*days?|zero)(?:[- ](?:data[- ])?retention)?\b|\bnon[- ]?zero\b|\bnot\s+zdr\b|\bzero[- ](?:data[- ])?retention\s+(?:is\s+)?not\b|\bdoes(?:n't| not)\s+(?:offer|provide|support)\s+(?:zero|0\s*[- ]?(?:days?|retention))\b/.test(
      text,
    )
  ) {
    return "not-zdr"
  }

  const dayValues = [...text.matchAll(/(\d+)\s*[- ]?\s*(?:days?|d)\b/g)].map((match) =>
    Number(match[1]),
  )
  if (dayValues.length > 0) {
    // A day count we do not model is not safe to round down to 30d.
    if (dayValues.some((value) => value !== 0 && value !== 30)) return "unknown"
    return Math.max(...dayValues) === 0 ? "zero" : "30d"
  }

  if (/\bzero[- ](?:data[- ])?retention\b|\bzero\s+days?\b/.test(text)) return "zero"
  if (/\bnot\s+zdr\b/.test(text)) return "not-zdr"
  if (/retained|retention|logged|trial|\blog\b|not used for training|limited use|abuse monitoring/.test(text)) {
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

function conditionalFromFootnote(
  html: string,
  name: string,
  cell: string,
): { validUntil?: string; conditions?: string } {
  if (!cell.includes("*")) return {}
  const plain = stripTags(html)
  const lowerPlain = plain.toLowerCase()
  const candidates = [
    name,
    name.replace(/\s*\(.*?\)\s*/g, "").trim(),
    name.split(/\s+/)[0] ?? name,
  ].filter((candidate) => candidate.length > 0)
  let index = -1
  for (const candidate of candidates) {
    index = lowerPlain.indexOf(`${candidate.toLowerCase()}:`)
    if (index >= 0) break
  }
  if (index < 0) return { conditions: "conditional zero; footnote not found" }
  const snippet = plain.slice(index, index + 500)
  const dateMatch = snippet.match(/valid through\s+([A-Za-z]+ \d{1,2}, \d{4})/i)
  const conditions = snippet.split(/(?<=\.)\s+/)[0]?.slice(0, 300) ?? snippet.slice(0, 300)
  if (!dateMatch) return { conditions: `${conditions} (validity window not found)` }
  const parsed = Date.parse(dateMatch[1])
  return {
    conditions,
    // Keep the published date-only form so the resolver can treat it as
    // "valid through the end of that day".
    validUntil: Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : undefined,
  }
}

export interface ParseOptions {
  /** Injectable clock for deterministic conditional-footnote tests. */
  now?: number
}

/**
 * Parse the Go privacy table: "Model | Model training | Data retention".
 * Training dominates retention. Names are converted to model IDs through the
 * endpoints table; rows without a mapping are skipped rather than guessed.
 */
export function parseGoPrivacy(html: string, options: ParseOptions = {}): ScopedPolicy[] {
  const tables = extractTables(html)
  const nameToId = parseNameToIdMap(tables)
  const policies: ScopedPolicy[] = []
  const now = options.now ?? Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

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
        if (!name || /^(?:model|modelname|name)$/.test(nameKey(name))) continue
        const trainingRaw = trainingIdx >= 0 ? (row[trainingIdx] ?? "").trim() : ""
        const retentionRaw = (row[retentionIdx] ?? "").trim()
        if (!trainingRaw && !retentionRaw) continue

        const id = toID(name, nameToId)
        if (!id) continue

        const training = classifyTrainingCell(trainingRaw)
        const retention = classifyRetentionCell(retentionRaw)
        // Training is a known fact and dominates any retention cell, including
        // an unclassified one. Unknown retention alone still fails closed.
        let final: Retention =
          training === "training" ? "training" : (worstRetention(training, retention) ?? "unknown")
        const conditional = conditionalFromFootnote(html, name, retentionRaw)
        if (final === "zero" && retentionRaw.includes("*")) {
          const validUntil = conditional.validUntil
          const expiry = validUntil ? policyExpiry(validUntil) : Number.NaN
          if (!Number.isFinite(expiry) || expiry < now) {
            // A conditional zero without a current validity window is not safe
            // to treat as unconditional.
            final = "unknown"
          }
        }
        const reasonParts = [
          `Go privacy table (live ${today}): training="${trainingRaw || "?"}", retention="${retentionRaw || "?"}"`,
        ]
        if (conditional.conditions) reasonParts.push(conditional.conditions)
        if (training && training !== retention) reasonParts.push("training dominates retention")
        if (final === "unknown" && retentionRaw.includes("*")) {
          reasonParts.push("conditional zero is expired or its validity window is unknown; fail-closed")
        } else if (final === "unknown") {
          reasonParts.push("value could not be classified; fail-closed")
        }

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
  if (hasTrainingSignal(text)) return "training"

  const classified = classifyRetentionCell(text)
  if (classified) return classified

  // The Mistral bullet only says data is retained under Mistral's policy; it
  // never promises ZDR, so the family default is not-zdr.
  if (family === "mistral") return "not-zdr"
  return "unknown"
}

function looksLikeModelSubject(subject: string): boolean {
  if (subject.length === 0 || subject.length > 80) return false
  if (/https?:|\/|\?|@/.test(subject)) return false
  if (/^\d{1,2}:\d{2}/.test(subject)) return false
  if (/^(for|learn|see|note|read|visit|by|with|during|peak)\b/i.test(subject)) return false
  return /^[A-Za-z0-9][A-Za-z0-9 .,'()&+_-]*$/.test(subject)
}

/** Bound the Console privacy block at `id="privacy"` and the next `<h2>`. */
function privacySection(html: string): string {
  const idMatch = /\bid\s*=\s*["']privacy["']/i.exec(html)
  let afterStart: string
  if (idMatch) {
    afterStart = html.slice(idMatch.index)
    // The id may sit on the heading itself or on a wrapping `<section>`.
    // For a wrapper, skip its first heading before looking for the next one.
    const firstH2 = afterStart.search(/<h2\b/i)
    if (firstH2 >= 0 && !afterStart.slice(0, firstH2).includes("<")) {
      const headingClose = afterStart.indexOf("</h2", firstH2)
      if (headingClose >= 0) {
        const headingEnd = afterStart.indexOf(">", headingClose)
        if (headingEnd >= 0) afterStart = afterStart.slice(headingEnd + 1)
      }
    }
  } else {
    const heading = /<h2\b[^>]*>\s*(?:Data\s+)?Privacy(?:\s+and\s+[^<]*)?\s*<\/h2>/i.exec(html)
    if (!heading) return ""
    afterStart = html.slice(heading.index + heading[0].length)
  }
  let section = afterStart
  const nextHeading = afterStart.search(/<h2\b/i)
  if (nextHeading >= 0) section = afterStart.slice(0, nextHeading)
  const boundary = section.search(/<\/(?:article|aside|footer|main)>/i)
  if (boundary >= 0) section = section.slice(0, boundary)
  return section
}

/** Extract `<li>` bodies, tolerating a missing `</li>` (legal HTML). */
function listItems(section: string): string[] {
  const items: string[] = []
  const pattern = /<li\b[^>]*>([\s\S]*?)(?:<\/li\s*>|(?=<li\b)|(?=<\/ul\s*>)|$)/gi
  for (const match of section.matchAll(pattern)) {
    if (match[1] !== undefined) items.push(stripTags(match[1]))
  }
  return items
}

/**
 * Parse the Console privacy section exception bullets.
 *
 * The section is bounded at `id="privacy"` and the next `<h2>`, so bullets in
 * later documentation sections cannot create fake policies. API-family bullets
 * become provider-scoped family policies; unclassified model bullets become
 * `unknown` (fail closed) instead of being silently dropped.
 */
export function parseConsolePrivacy(html: string, options: ParseOptions = {}): ScopedPolicy[] {
  const tables = extractTables(html)
  const nameToId = parseNameToIdMap(tables)
  const policies: ScopedPolicy[] = []
  const now = options.now ?? Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  const section = privacySection(html)
  const bullets = listItems(section)

  for (const bullet of bullets) {
    const sep = bullet.indexOf(":")
    if (sep <= 0) continue
    const subject = bullet.slice(0, sep).trim()
    const rest = bullet.slice(sep + 1).trim()

    const apiFamily = subject.match(/^(OpenAI|Anthropic|Mistral)\s+(?:APIs?|endpoints?)\b/i)
    if (apiFamily) {
      const familyName = apiFamily[1].toLowerCase()
      const family = API_FAMILIES[familyName]
      if (!family) continue
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
