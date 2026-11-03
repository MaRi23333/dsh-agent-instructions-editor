# Releasing

Regular releases are published to npm automatically by `.github/workflows/publish.yml`
when a GitHub Release is **published** (OIDC Trusted Publishing, no npm token involved).

## Release history and prerequisites

The one-time package bootstrap is complete. Do not repeat first-publish or
Trusted Publisher setup during a regular release. If the binding needs repair,
an authorized maintainer should inspect the current npm settings separately;
never store tokens or 2FA codes in the repository.

The existing `v0.1.0` and `v0.1.1` tags are private-test history and must not get
normal GitHub Releases. Before a release, confirm that its version is newer than
npm `latest` and has not already been published. The workflow rejects duplicate
versions but cannot prevent every accidental dist-tag rollback.

## 1. Pre-release checks

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run smoke
pnpm run check:pack
```

## 2. Version and tag

- Bump `package.json` `"version"` first and commit it (together with the rebuilt `lib/`).
- Create an **annotated** tag whose name is exactly `v${version}`:

  ```sh
  version=$(node -p "require('./package.json').version")
  git tag -a "v$version" -m "v$version"
  git push origin main
  git push origin "v$version"
  ```

- The commands above use a POSIX shell. Do **not** use a lightweight tag — the
  workflow rejects it. Never move an existing pushed tag; use a new patch version.
- The tag must point at the commit the release is built from, and the tag name must
  equal `v${package.json version}`; the workflow verifies both.

## 3. Create the GitHub Release

Create the Release from the pushed annotated tag. On `published`, the workflow runs:
frozen install → typecheck → tests → build → committed-lib consistency → smoke →
package whitelist → npm publish via OIDC (with SLSA provenance).

## 4. Do not publish manually (regular releases)

Do not run `npm publish` yourself for a normal
release — it races the workflow or fails with "version already exists". After the run
goes green, verify on the registry
(`npm view dsh-agent-instructions-editor version dist-tags.latest`).
