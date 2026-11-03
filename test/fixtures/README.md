# Test fixture provenance

These fixtures are repository-only test inputs. They are excluded from the npm
package by the `files` allowlist in `package.json`.

## `console-go.html`

| Field | Value |
| --- | --- |
| Source | https://opencode.ai/v2/docs/console/go |
| Section used | `#privacy` (Go catalog privacy table) plus model/ID tables |
| Captured | 2026-10-31 |
| Captured for | `test/retention.test.ts` parser tests |
| Host baseline | OpenCode 2.2.5 / `@opencode/plugin` 2.2.5 |

## `console-models.html`

| Field | Value |
| --- | --- |
| Source | https://opencode.ai/v2/docs/console/models |
| Section used | `#privacy` (Console privacy baseline and per-model exceptions) plus model/ID tables |
| Captured | 2026-10-31 |
| Captured for | `test/retention.test.ts` parser tests |
| Host baseline | OpenCode 2.2.5 / `@opencode/plugin` 2.2.5 |

The fixtures are public OpenCode documentation HTML only. They contain no API
keys, account data, or other secrets. Do not add captured pages that include
credentials or private account information.

### Re-capturing

```sh
curl -fsSL https://opencode.ai/v2/docs/console/go \
  -o test/fixtures/console-go.html
curl -fsSL https://opencode.ai/v2/docs/console/models \
  -o test/fixtures/console-models.html
npm test
```

Record the new capture date above. If a page layout change causes test
failures, update the parser expectations in `test/retention.test.ts` together
with the fixture so the provenance stays traceable.
