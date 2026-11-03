# Changelog

All notable changes to `opencode-zero-retention-models` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - Unreleased

Initial public release. This entry stays **Unreleased** until the checklist in
`RELEASE.md` is complete. Publishing requires explicit approval.

### Added

- Provider-scoped retention policies for `opencode` (Console) and
  `opencode-go`; other providers are left untouched by default.
- Optional `verifiedZdr` user attestation for models where the user has a
  confirmed zero-retention/opt-out agreement.
- Bundled Console and Go snapshots with separate policy tables and snapshot
  age/footnote handling.
- CI matrix on Node 20, 22, 24, and 26 with `npm ci`, typecheck, unit tests,
  `npm pack --dry-run`, and a packed-install smoke job.
- MIT `LICENSE` (2026), `CHANGELOG.md`, `RELEASE.md`, fixture provenance, and
  package metadata (`repository`, `author`, `homepage`, `bugs`,
  `publishConfig`, `keywords`).
- Pinned `@opencode/plugin@2.2.5`, committed `package-lock.json`, and
  `engines.node >= 20`.

### Fixed

- Mistral defaults to `not-zdr`; it is hidden unless the user explicitly
  attests to a verified ZDR arrangement.
- Training now dominates retention: `training=Yes`, `Yes*`, and opt-in variants
  hide the model even when the retention cell says `0 days`.
- Live policy data is authoritative per model ID: an unclassified live row
  becomes `unknown` instead of falling back to a stale snapshot `zero`.
- Negated retention text (`not zero`, `non-zero`, `does not offer zero`) no
  longer resolves to `zero`.
- The model transform is registered before network/storage work; storage and
  cache failures cannot leave the model list unfiltered.
- Corrupt or empty cached policies are rejected without discarding valid data;
  a partial docs-page failure keeps the successful page.
- Parser hardening for nested tables, row/column spans, entities, duplicate
  names, multi-value cells, section boundaries, and `Yes*` training cells.
- Package release hygiene: exact dependency pin, lockfile, strict typecheck
  config, LICENSE, CI, audit documentation, and fixture provenance.
- README refresh/caching, provider-scope, Mistral, and install claims are
  aligned with the actual behavior.

### Security

- `npm audit --omit=dev` reports 24 moderate advisories in the transitive
  `@opencode/plugin@2.2.5` install tree (publishing/sigstore/glob/minimatch
  paths). They are documented as host-provided runtime risk in `RELEASE.md`
  and are **not** claimed as fixed.
