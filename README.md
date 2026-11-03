# opencode-zero-retention-models

OpenCode plugin that filters the model list to models whose published data
retention is **0 days (zero data retention)**. By default it filters only the
two OpenCode catalogs: `opencode` (Console) and `opencode-go` (Go). Other
providers are left untouched.

For scoped providers, models that retain requests, log them, train on them, or
have no usable policy are removed from the list. `unknown` is hidden unless
`showUnknown: true`.

```
/models (illustrative)
  ✗ GPT-6 Luna                  30 days
  ✗ Claude Haiku 5.5            30 days
  ✗ Beam Free                   30 days (safety)
  ✗ Mistral Large 4             not ZDR; retained under Mistral's policy
  ✗ Muse Spark 1.3 Contributor  not ZDR; trains on request data
  ✗ Nemotron 3.5 …              logged for security/improvement
  ✗ Big Pickle / Flint …        may train; Flint retains 30 days
  ✓ Kimi K3                     0 days
  ✓ GLM-5.3-Flash               0 days
  ✓ DeepSeek V4.1 Flash         0 days*
  …
```

## Provider scope

`providers` defaults to `["opencode", "opencode-go"]`. OpenRouter, local
runtimes, and custom gateways are **not filtered at all** by default; their
models pass through the transform untouched.

`providers` sets the complete list of provider IDs to filter. It replaces the
default list rather than appending to it, so include `opencode` and
`opencode-go` if you still want those filtered. Adding a provider opts it into
filtering. Only the Console and Go documentation pages are fetched, so a newly
scoped non-local provider has no published policy in this plugin; its models
resolve `unknown` and are hidden unless `showUnknown: true` or a matching
`verifiedZdr` entry allows one.

Local providers are detected with an explicit runtime allowlist:
`ollama`, `ollama-local`, `ollama_local`, `lmstudio`, `lm-studio`,
`lm_studio`, `llamacpp`, `llama.cpp`, `llama_cpp`, `vllm`, `mlx`, `localai`,
`jan`, and `koboldcpp`. When they are in scope they are left untouched because
request data is assumed to stay on the machine. This is an assumption about the
endpoint, not a guarantee. `local` and `local-gateway` are deliberately **not**
assumed local because they can point at remote URLs; if you add them to
`providers`, they are filtered like any other provider.

## Refresh and caching

Fetched on plugin load subject to a 12 h cache; refreshed every `refreshHours`
(default 12 h) while OpenCode is running; falls back to the last valid
cache/snapshot when offline.

- The model transform is registered immediately with the bundled snapshot,
  before any storage or network await, so the first model list is already
  filtered. Cache hydration and refresh run in the background.
- On load, a valid cache is applied. If it is younger than `refreshHours`, no
  network request is made; otherwise both privacy pages are fetched. Cached
  data older than 30 days is ignored.
- The refresh timer fires every `refreshHours` while OpenCode is running.
  Fetches cannot overlap, and cleanup aborts in-flight work.
- Both pages are fetched independently. A failure or empty parse on one page
  keeps the other page's data and does not replace a last-known-good cache. If
  everything is unavailable, the plugin keeps using the last valid cache or
  the bundled snapshot.
- The model list is reloaded only when the policy set changes.

| Source | Content |
| --- | --- |
| <https://opencode.ai/v2/docs/console/go#privacy> | Per-model **Model training** / **Data retention** table for the OpenCode Go catalog |
| <https://opencode.ai/v2/docs/console/models#privacy> | Zero-retention baseline plus per-model and per-API exceptions for the OpenCode Console catalog |

The Console page publishes a baseline plus exceptions; the Go page publishes an
exhaustive table. Live data is authoritative per model ID: an unclassified live
value becomes `unknown` rather than falling back to a snapshot `zero`.

### Snapshot age and conditional zeros

The bundled fallback snapshot was captured **2026-10-31**. A snapshot `zero` is
trusted for at most 30 days after capture and becomes `unknown` (hidden)
afterwards. Stale restrictive statuses (`30d`, `not-zdr`, `training`) still
hide the model.

Conditional zeros that carry a validity window are trusted only while it holds.
In the Go catalog, `deepseek-v4.1-flash` and `deepseek-v4-pro` are `0 days*` only
in the Global region and with a ZDR agreement valid through **2026-11-30**; an
expired or unparseable window becomes `unknown` (hidden). The plugin enforces
the published date but cannot verify your region or agreement.

## Policy model

| Status | Examples | Listed? |
| --- | --- | --- |
| `zero` — retention is 0 days | Kimi K3, GLM-5.3, Gemini 4 Argon, Qwen3.8 Max, DeepSeek V4.*, MiniMax M3, MiMo-V2.6, LongCat-2.0, Step 5 Preview, Hy3/Hy4, Jev 1.13 | ✓ |
| `30d` — requests retained 30 days | GPT-* (OpenAI API exception), Claude-* (Anthropic API exception), Go Grok-* and Claude Haiku 5.5, Beam Free | ✗ |
| `not-zdr` — not zero-data-retention / logs use | Mistral Large 4 (Console exception), Muse * Contributor, Iceman Contributor Free, Nemotron * Free | ✗ |
| `training` — may train on request data | Big Pickle, Pulse Alpha Free, Flint 40B Free, MiMo-V2.6-Flash Free | ✗ |
| `unknown` — no published/usable policy | anything else on a scoped provider | ✗ (strict by default) |

Training dominates retention: a row with `training=Yes` (including `Yes*` and
opt-in variants) is hidden even when the retention cell says `0 days`.

**Mistral is `not-zdr` by default.** The live OpenCode Console privacy section
says:

> Mistral APIs: Prompts and other inputs are not used for training. Data is
> retained in accordance with Mistral's Data Retention Policy.

Mistral ZDR is opt-in and paid and requires a ZDR/opt-out agreement. The plugin
does not infer it from a docs link or account state. If you have a confirmed,
current agreement, attest that specific model with `verifiedZdr` (below);
otherwise Mistral models stay hidden.

### `verifiedZdr`

`verifiedZdr` is a **user attestation list**, not auto-detection:

```jsonc
"verifiedZdr": [
  { "providerID": "opencode", "modelID": "mistral-large-4" }
]
```

Each entry marks that exact provider/model pair as `zero`. Matching is
case-insensitive and ignores surrounding whitespace. It only applies to
providers in `providers` and is not used for local providers or providers left
out of scope. It does not create a family-wide rule: list every model covered by
the agreement. Only use this for a model covered by a current, verified
ZDR/opt-out agreement; nothing validates the entry against provider docs or your
account.

## Install

Use one of the forms below. The local path forms point at a checkout; the npm
form installs from a registry.

Local directory, no options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-zero-retention-models"]
}
```

Local directory with options (object form; do not also list the bare path):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-zero-retention-models",
      "options": {
        "showUnknown": false,
        "refreshHours": 12,
        "providers": ["opencode", "opencode-go"],
        "verifiedZdr": [
          { "providerID": "opencode", "modelID": "mistral-large-4" }
        ]
      }
    }
  ]
}
```

NPM package form (when installing from a registry):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-zero-retention-models",
      "options": { "refreshHours": 12 }
    }
  ]
}
```

The package ships raw TypeScript: the entry is `src/index.ts`, and OpenCode
2.2.x transpiles it at load. No build step is required. Node.js **>=20** is
required for development and tests. Plain `node` cannot import the installed
package directly from `node_modules`; the OpenCode host and Bun can.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `showUnknown` | `false` | Boolean only. Also list scoped models with `unknown` status. It never widens `30d`, `not-zdr`, or `training`, and out-of-scope/local models already pass untouched. |
| `refreshHours` | `12` | Finite number with effective range `1..596`. Fractional values between 0 and 1 are raised to 1, values above 596 are clamped, and zero/negative/non-finite values use `12`. Cache TTL and in-session refresh interval. |
| `providers` | `["opencode", "opencode-go"]` | Complete list of provider IDs to filter; replaces the default. IDs are trimmed, lowercased, and de-duplicated. Adding a provider opts it in; unknown non-local models there are hidden unless `showUnknown` or `verifiedZdr` applies. |
| `verifiedZdr` | `[]` | User-attested `{ providerID, modelID }` pairs for a current ZDR/opt-out agreement. Exact model IDs only, never auto-detected, and only for in-scope non-local providers. |

Invalid option shapes are ignored with a warning and safe fallbacks:
`showUnknown` must be a boolean; `refreshHours` must be a finite positive
number; `providers` must be a non-empty string array; invalid `verifiedZdr`
entries are dropped.

## How it works

The plugin registers a model transform that removes every scoped model whose
resolved policy is not `zero`, except that `unknown` is kept when
`showUnknown: true`. Scoped-out and local models pass through untouched. That
is the collection `/models` renders and sessions pick models from.

Removing a model from the list does **not** clear an already-selected default or
session model. Such a selection may persist until you change it; the plugin does
not edit your config or session selection.

## Development

```sh
npm ci
npm run typecheck
npm test
```

CI runs these on Node 20, 22, 24, and 26, plus `npm pack` and a packed-install
smoke job. Parser fixtures and their capture dates are documented in
`test/fixtures/README.md`.

`src/retention.ts` contains the policy types, provider scope, local allowlist,
and offline snapshot; `src/fetch.ts` the live documentation table parser;
`src/index.ts` the plugin wiring.
