/**
 * Minimal HTML table reader.
 *
 * The published docs are not guaranteed to be well-formed: cells and rows may
 * omit closing tags, tables may nest, and attributes may contain ">". This
 * reader is deliberately small and tolerant rather than a general HTML parser.
 */

interface Tag {
  name: string
  closing: boolean
  start: number
  end: number
}

/** Read the next `<...>` tag, respecting quoted attributes and comments. */
function readTag(html: string, start: number): Tag | undefined {
  if (html[start] !== "<") return undefined
  const next = html[start + 1]
  // A bare "<" (for example "a < b") is text, not an opening tag.
  if (!next || !/[a-zA-Z/!?]/.test(next)) return undefined
  if (html.startsWith("<!--", start)) {
    const close = html.indexOf("-->", start + 4)
    return {
      name: "!--",
      closing: false,
      start,
      end: close < 0 ? html.length : close + 3,
    }
  }
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
    const match = tagText.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']?(\\d+)`, "i"))
    const value = match ? Number(match[1]) : 1
    return Number.isFinite(value) && value > 0 ? Math.min(value, 100) : 1
  }
  return { rowspan: span("rowspan"), colspan: span("colspan") }
}

/**
 * Find the end of a cell, ignoring nested tables and nested cells.
 *
 * Missing `</td>`/`</th>` are legal HTML: the next cell opening tag implicitly
 * closes the current one, so return its start without consuming it.
 */
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
    if (!tag.name) {
      i = tag.end
      continue
    }
    if (tag.name === "table") {
      tableDepth += tag.closing ? -1 : 1
      if (tableDepth < 0) return { contentEnd: tag.start, end: tag.start }
      i = tag.end
      continue
    }
    if (tableDepth === 0 && (tag.name === "td" || tag.name === "th")) {
      if (!tag.closing) {
        if (cellDepth === 1) {
          // The next cell starts here; do not consume its opening tag.
          return { contentEnd: tag.start, end: tag.start }
        }
        cellDepth++
      } else {
        cellDepth--
        if (cellDepth === 0) return { contentEnd: tag.start, end: tag.end }
      }
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
      // Find this row's end at table depth 1. Missing `</tr>` is legal HTML:
      // the next `<tr>` opening implicitly closes the current row.
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
        if (!rowTag.name) {
          j = rowTag.end
          continue
        }
        if (rowTag.name === "table") {
          depth += rowTag.closing ? -1 : 1
          if (depth <= 0) {
            rowEnd = rowTag.start
            j = rowTag.start
            break
          }
          j = rowTag.end
          continue
        }
        if (depth === 1 && rowTag.name === "tr") {
          rowEnd = rowTag.start
          // Consume an explicit close; leave an implicit next row to be
          // parsed by the outer loop.
          j = rowTag.closing ? rowTag.end : rowTag.start
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
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  cent: "¢",
  sect: "§",
  deg: "°",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
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
    // Comments are not text content.
    if (tag.name === "!--") {
      out += " "
      i = tag.end
      continue
    }
    // Block-level tags act as separators so adjacent cells do not merge words.
    if (
      tag.name === "" ||
      /^(br|hr|p|div|li|tr|td|th|thead|tbody|tfoot|caption|h[1-6]|section|article|ul|ol|dl|dt|dd|blockquote|pre|table)$/.test(
        tag.name,
      )
    ) {
      out += " "
    }
    i = tag.end
  }
  return decodeEntities(out).replace(/\s+/g, " ").trim()
}
