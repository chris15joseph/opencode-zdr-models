# Parser fixtures

These are unmodified HTML captures of the public OpenCode documentation pages,
used by `test/parser.test.ts` and `test/retention.test.ts` to exercise the live
parsers against the real page structure (tables, headings, links and entities).

| File | Source URL | Captured (UTC) |
| --- | --- | --- |
| `console-go.html` | https://opencode.ai/v2/docs/console/go | 2026-11-02 |
| `console-models.html` | https://opencode.ai/v2/docs/console/models | 2026-11-02 |

Notes:

- The captures include the OpenCode Go privacy table ("Model / Model training /
  Data retention") and the Console privacy exception bullets.
- The live Console page gained the `Pulse Alpha Free` training exception after
  the previous fixture was captured; the refreshed capture includes it.
- Refresh a fixture only from the URLs above and update the capture date in the
  same commit. Do not hand-edit the HTML: parser tests should fail when the
  published structure changes, prompting a deliberate parser/snapshot review.

Refresh commands:

```sh
curl -fsSL https://opencode.ai/v2/docs/console/go -o test/fixtures/console-go.html
curl -fsSL https://opencode.ai/v2/docs/console/models -o test/fixtures/console-models.html
```
