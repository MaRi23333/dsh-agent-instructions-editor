# Releasing

Regular releases are published to npm automatically by `.github/workflows/publish.yml`
when a GitHub Release is **published** (OIDC Trusted Publishing, no npm token involved).

## 0. First release (package does not exist on npm yet)

npm's Trusted Publishing requires the package to **already exist** (see the
[npm-trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)) —
the first publish cannot be performed by the OIDC workflow. One-time bootstrap:

1. Finish every check in section 1 on the exact commit that will become the release,
   then tag and push it as in section 2.
2. From that commit's working tree, run `npm publish --ignore-scripts --access public`
   **manually** (authorized maintainer only). Run `pnpm run check:pack` first — the
   published content must match the whitelist.
3. After the package exists and the repository is public, configure Trusted Publishing
   from an authorized maintainer's interactive terminal (npm 11.15.0 or newer).
   Preview the exact binding, then complete npm's browser 2FA for the actual command:

   ```sh
   npm trust github dsh-agent-instructions-editor --repo MaRi23333/dsh-agent-instructions-editor --file publish.yml --allow-publish --dry-run --json --registry=https://registry.npmjs.org/
   npm trust github dsh-agent-instructions-editor --repo MaRi23333/dsh-agent-instructions-editor --file publish.yml --allow-publish --registry=https://registry.npmjs.org/
   ```

   No GitHub Actions environment is used. The workflow file is `publish.yml`, not
   its full repository path. Use npm's website Publishing settings as a fallback
   if the CLI binding is unavailable. Never store tokens or 2FA codes in this repository.
4. **Do NOT create a normal GitHub Release for this first tag.** The workflow fires on
   every non-prerelease Release `published` event and rejects already-published
   versions — a regular Release for whichever tag was actually published manually
   would fail the run (AIE-RELEASE-009). If a release page is wanted for that bootstrap
   tag, create it marked as **pre-release** (the workflow skips prereleases). Later,
   higher-version releases go through sections 1–3 and the workflow publishes
   automatically after Trusted Publishing is connected.

The existing `v0.1.0` and `v0.1.1` tags are private-test history and must never get
normal GitHub Releases. Before any regular release, confirm its version is newer
than npm's current `latest`. The workflow rejects duplicate versions but does not
prevent publishing an older, previously unpublished version and moving `latest`
backwards.

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

After the first bootstrap (section 0), do not run `npm publish` yourself for a normal
release — it races the workflow or fails with "version already exists". After the run
goes green, verify on the registry
(`npm view dsh-agent-instructions-editor version dist-tags.latest`).
