# Test fixture provenance

These fixtures are repository-only test inputs. They are excluded from the npm
package by the `files` allowlist in `package.json`.

| File | Source URL | Captured (UTC) | Used by |
| --- | --- | --- | --- |
| `console-go.html` | https://opencode.ai/v2/docs/console/go | 2026-11-02 | `test/parser.test.ts`, `test/retention.test.ts` |
| `console-models.html` | https://opencode.ai/v2/docs/console/models | 2026-11-02 | `test/parser.test.ts`, `test/retention.test.ts` |
| `expired-footnote.html` | Derived from `console-go.html` (synthetic expired ZDR footnote) | 2026-11-02 | `test/parser.test.ts` |

Notes:

- The captures include the OpenCode Go privacy table ("Model / Model training /
  Data retention"), the Console privacy exception bullets, and the model/ID
  endpoint tables used to map display names to stable IDs.
- The live Console page gained the `Pulse Alpha Free` training exception after
  the previous fixture was captured; the refreshed capture includes it.
- The live Go footnote now says the DeepSeek ZDR agreement is valid through
  November 30, 2026.
- `expired-footnote.html` is a deliberately altered copy used to prove that an
  expired conditional `0 days*` policy fails closed. It is not a live capture.
- The fixtures are public OpenCode documentation HTML only. They contain no API
  keys, account data, or other secrets. Do not add captured pages that include
  credentials or private account information.
- Refresh a fixture only from the URLs above and update the capture date in the
  same commit. Do not hand-edit the live captures: parser tests should fail when
  the published structure changes, prompting a deliberate parser/snapshot
  review.

Host baseline: OpenCode 2.2.5 / `@opencode/plugin` 2.2.5.

## Re-capturing

```sh
curl -fsSL https://opencode.ai/v2/docs/console/go \
  -o test/fixtures/console-go.html
curl -fsSL https://opencode.ai/v2/docs/console/models \
  -o test/fixtures/console-models.html
npm test
```

Record the new capture date above. If a page layout change causes test
failures, update the parser expectations in `test/parser.test.ts` and
`test/retention.test.ts` together with the fixture so the provenance stays
traceable.
