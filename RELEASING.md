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
3. On npmjs.com, open the new package → Publishing settings → connect the GitHub
   workflow (`MaRi23333/dsh-agent-instructions-editor` / `.github/workflows/publish.yml`)
   for Trusted Publishing.
4. **Do NOT create a normal GitHub Release for this first tag.** The workflow fires on
   every non-prerelease Release `published` event and rejects already-published
   versions — a regular Release for the manually published `v0.1.0` would fail the run
   (AIE-RELEASE-009). If a release page is wanted for v0.1.0, create it marked as
   **pre-release** (the workflow skips prereleases). From `v0.1.1` on, regular
   releases go through sections 1–3 and the workflow publishes automatically.

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
  git tag -a v0.1.0 -m "v0.1.0"
  git push origin main
  git push origin v0.1.0
  ```

- Do **not** use a lightweight tag (`git tag v0.1.0`) — the workflow rejects it.
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
