# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Before opening a PR

- Use Node.js 20 or newer.
- Run `npm ci`, `npm run typecheck`, and `npm test`.
- Keep the change focused. Update `CHANGELOG.md` when behavior changes.
- Do not commit secrets, credentials, `node_modules/`, tarballs, or coverage
  output.

## Branching

`main` is protected. Create a topic branch and open a pull request instead of
pushing directly:

```sh
git checkout -b fix/short-description
```

The owner can bypass protection for release work; everyone else merges through
a pull request.

## Release

Releases are manual and documented in [`RELEASE.md`](RELEASE.md). CI never
publishes to npm.
