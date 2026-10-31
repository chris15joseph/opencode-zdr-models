# opencode-zero-retention-models

OpenCode plugin that filters `/models` down to models whose published
**data-retention policy is 0 days** (zero data retention). Models that retain
requests, log them for safety/improvement, or train on them are hidden from the
model list and cannot be selected accidentally.

```
/models        (before: 38 models)          (after: 24 models)
  ✗ GPT-6 Luna            30 days
  ✗ Grok 4.7              30 days
  ✗ Claude Haiku 5.5      30 days
  ✗ Beam Free             30 days (safety)
  ✗ Muse Spark 1.3 …      Not ZDR, trains on request data
  ✗ Nemotron 3.5 …        logged for security/improvement
  ✗ Big Pickle / Flint …  may train; Flint retains 30 days
  ✓ Kimi K3               0 days
  ✓ GLM-5.3-Flash         0 days
  ✓ DeepSeek V4.1 Flash   0 days
  …
```

## Data is fetched automatically before each session

Retention policies change over time, so the plugin re-downloads and parses the
published privacy tables **every time OpenCode loads it — i.e. before a coding
session starts**:

| Source | Content |
| --- | --- |
| <https://opencode.ai/v2/docs/console/go#privacy> | Per-model **Model training** / **Data retention** table for the OpenCode Go catalog |
| <https://opencode.ai/v2/docs/console/models#privacy> | Zero-retention baseline plus per-model and per-API exceptions for the OpenCode Console catalog |

Parsed entries are merged over a bundled snapshot (captured 2026-10-31) which
also covers models the pages no longer list. The result is cached in plugin
storage and refreshed periodically while the session is open (default every
12 h), so a policy published mid-day is picked up without restarting.

## Policy model

| Status | Examples | Listed? |
| --- | --- | --- |
| `zero` — retention is 0 days | Kimi K3, GLM-5.3, Gemini 4 Argon, Qwen3.8 Max, DeepSeek V4.*, MiniMax M3, MiMo-V2.6, LongCat-2.0, Step 5 Preview, Hy3/Hy4, Mistral Large 4, Jev 1.13 | ✓ |
| `30d` — requests retained 30 days | GPT-* (OpenAI APIs), Claude-* (Anthropic APIs), Grok-* (xAI), Claude Haiku 5.5, Beam Free | ✗ |
| `not-zdr` — not zero-data-retention / logs use | Muse Spark * Contributor, Iceman Contributor Free, Nemotron * Free | ✗ |
| `training` — may train on request data | Big Pickle, Flint 40B Free, MiMo-V2.6-Flash Free | ✗ |
| `unknown` — no published policy | anything else | ✗ (strict by default) |

Local providers (Ollama, LM Studio, llama.cpp, …) always pass: request data
never leaves the machine.

## Install

Local plugin directory (auto-loads from `.opencode/plugins/`), or reference it
from `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/path/to/opencode-zero-retention-models",
    {
      "package": "/path/to/opencode-zero-retention-models",
      "options": {
        "showUnknown": false,
        "refreshHours": 12,
      },
    },
  ],
}
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `showUnknown` | `false` | Also list models with no published policy (unknown is not "0 days") |
| `refreshHours` | `12` | Cache TTL / refresh interval for the live privacy tables |

## How it works

The plugin registers a model transform (`ctx.model.transform`) that removes
every model whose resolved policy is not `zero` from the active model
collection. That is the same list `/models` renders and the same list sessions
pick models from, so hidden models are hidden everywhere.

## Development

```sh
node --test test/   # parser tests run against real documentation HTML fixtures
```

`src/retention.ts` contains the policy types, family rules and offline
snapshot; `src/fetch.ts` the live documentation table parser; `src/index.ts`
the plugin wiring.
