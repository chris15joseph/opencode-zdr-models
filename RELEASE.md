# Release checklist — `opencode-zero-retention-models`

**Status: 1.0.0 is prepared but not yet published.** The npm publish is pending
a 2FA one-time password; npm rejected the first attempt with `E403: Two-factor
authentication ... required to publish packages`. Publishing requires explicit
approval from the repository owner (Christopher Joseph). CI in this repository
never publishes; there is no publish workflow and no npm token configured.

## Supported runtime

- OpenCode 2.2.5 (`@opencode/plugin` pinned to exactly `2.2.5`).
- Node.js `>=20` for development, tests, and CI. CI runs Node 20, 22, 24, and
  26.
- The package entry is raw TypeScript (`exports["."] = "./src/index.ts"`). The
  OpenCode 2.2.x plugin host transpiles it. Plain Node cannot import the
  installed package from `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`);
  Bun and the OpenCode host can. The CI smoke job imports a copy of the
  installed payload outside `node_modules` to validate the module graph.

## Versioning and tags

- Follow SemVer: `MAJOR.MINOR.PATCH`.
- `1.0.0` is the first release. Its npm publication is pending 2FA.
- Tag releases as annotated tags: `vX.Y.Z` (for example `v1.0.0`).
- The tag must match `package.json` `version` exactly. Never move or re-point a
  published tag.
- Tag only after the full checklist below passes on the commit being released.
- Do not tag or publish from a dirty working tree.

## Release checklist

### Pre-release gates

- [ ] Working tree clean (`git status --short` empty) and the release commit is
      on `main`.
- [ ] `npm ci` succeeds from the committed `package-lock.json`.
- [ ] `npm run typecheck` exits 0. Do not release while it fails.
- [ ] `npm test` passes on Node 20, 22, 24, and 26.
- [ ] CI matrix is green, including the `pack + install smoke` job.
- [ ] `npm pack --dry-run` contains only `package.json`, `README.md`,
      `LICENSE`, and `src/`. Tests, fixtures, lockfiles, and archives must not
      be shipped.
- [ ] `npm audit --omit=dev` has been re-run and the result is recorded below.
- [ ] `CHANGELOG.md` has an entry for the version with the release date.
- [ ] README claims match code and live behavior.
- [ ] No secrets, `node_modules/`, `*.tgz`, or coverage output are tracked.
- [ ] Explicit publish approval has been recorded by the repository owner.

### Tag and publish (manual, after approval)

1. Confirm `CHANGELOG.md` has the release date for this version.
2. Commit the release notes.
3. Create the annotated tag:
   `git tag -a vX.Y.Z -m "vX.Y.Z"`
4. Run the full gate once more on the tagged commit.
5. Publish only with explicit approval:
   `npm publish --access public`
   `prepublishOnly` runs `npm run typecheck && npm test`, so a failing gate
   blocks the publish.
6. Push the tag and create the GitHub release from `CHANGELOG.md`.
7. Never publish from CI or from an unapproved local shell.

## Dependency audit (2026-11-02)

Command: `npm audit --omit=dev` (also `npm audit` for the full tree).

```text
24 moderate severity vulnerabilities
0 high, 0 critical, 0 low, 0 info
```

The install tree is 273 packages (about 201 MB on disk) because
`@opencode/plugin@2.2.5` pulls `@opencode/client`, `@opencode/schema`,
`@opencode/util`, `effect`, and, through `@opencode/util`, the npm
publishing/sigstore stack (`pacote`, `sigstore`, `tuf-js`, `@tufjs/models`,
`make-fetch-happen`, `cacache`, `glob`, `minimatch`, `npm-packlist`, and
related packages). The advisories are transitive and moderate (denial of
service / glob/minimatch and sigstore/TUF paths); most report "no fix
available" under the pinned 2.2.5 tree.

**These advisories are not fixed by this change.** They are documented as a
host-provided runtime risk: the plugin uses only `Plugin.define` from
`@opencode/plugin`, and the actual OpenCode host provides the plugin runtime.
The dependency is exact-pinned and the lockfile makes the tree reproducible.
`npm audit fix` was not run because it would change the pinned tree without a
compatibility test. Re-run `npm audit --omit=dev` at every release and revisit
when a newer `@opencode/plugin` release updates the transitive stack.

## Cross-repo duplication decision (2026-11-02)

The small cache/TTL/fetch/interval helpers stay **duplicated** between
`opencode-zero-retention-models` and `opencode-model-pricing` for 1.0.0.

Rationale:

- The duplicated surface is small (cache freshness check, storage get/set,
  fetch fallback, interval setup and cleanup).
- The two plugins have different failure semantics (policy-page completeness
  vs. per-source AA degradation), so premature unification would either leak
  one plugin's policy into the other or add options the other does not need.
- A shared package would add a third versioned artifact, another publish/tag
  path, and another supply-chain surface for a few dozen lines.
- Revisit extraction only if a **third** plugin appears, or if the helpers grow
  past roughly 100 lines or start to diverge in behavior. Until then, keep the
  implementations side-by-side and review both repositories together.

## Shared cross-repo review checklist

Use this for every change to either plugin:

- [ ] `package.json`: exact `@opencode/plugin` pin (`2.2.5`),
      `engines.node >= 20`, `repository`, `author`, `homepage`, `bugs`,
      `publishConfig.access = public`, and a `files` allowlist.
- [ ] `package-lock.json` committed; CI uses `npm ci`; no `node_modules/`,
      `*.tgz`, or coverage output tracked.
- [ ] `tsconfig.json`: `strict`, `noEmit`, `module`/`moduleResolution`
      `NodeNext`, `allowImportingTsExtensions`, `types: ["node"]`,
      `skipLibCheck`; includes `src` and `test`.
- [ ] Scripts: `typecheck` (`tsc --noEmit`), `test` (`node --test test/`), and
      `prepublishOnly` (`npm run typecheck && npm test`).
- [ ] CI: Node 20/22/24/26 matrix, `npm ci`, typecheck, tests,
      `npm pack --dry-run`, and a packed-install smoke job. **No publish job.**
- [ ] `LICENSE` (MIT, 2026), `CHANGELOG.md`, this `RELEASE.md`, and fixture
      provenance under `test/fixtures/README.md`.
- [ ] `NOTICE` for third-party data where required (none in this repository;
      policy fixtures are public OpenCode documentation and are not shipped).
- [ ] `npm audit --omit=dev` recorded; advisories documented, never silently
      claimed as fixed.
- [ ] Tarball contains only `package.json`, `README.md`, `LICENSE`, and `src/`;
      tests/fixtures are excluded.
- [ ] README refresh/caching/install/provider-scope claims match behavior.
- [ ] Version, changelog, and `vX.Y.Z` tag agree; publish approval recorded.
