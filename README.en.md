# dsh-agent-instructions-editor

**[中文](./README.md) | English**

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-agent-instructions-editor — a personalization editor plugin for DeepSeek Harness" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/MaRi23333/dsh-agent-instructions-editor/ci.yml?style=flat-square&label=CI" alt="CI" />
  <img src="https://img.shields.io/github/license/MaRi23333/dsh-agent-instructions-editor?style=flat-square" alt="License: MIT" />
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--rc.1-4d6bfe?style=flat-square" alt="DeepSeek Harness 0.1.2-rc.1" />
</p>

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds a
Personalization settings page (个性化指令) to the Web GUI for editing the harness workspace
instruction files, in the spirit of Codex's personalization settings:

- the user-global `~/.dsh/AGENTS.md`,
- project-chain `AGENTS.md` / `CLAUDE.md` files discovered the same way the harness
  instruction loader discovers them, and
- `AGENTS.local.md` / `CLAUDE.local.md` overlays.

## Features

- **Global instructions**: a persistent editor for `~/.dsh/AGENTS.md` with a byte-budget
  display (default 65,536).
- **Project instructions** (collapsed by default): a project picker (auto-discovered from
  the workspace registry + recent session directories; manual paths accepted too) that
  renders each level of the "project root → working directory" chain with its 4 candidate
  slots (AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md) — click to edit an
  existing file or create a missing one.
- **Loader-exact behavior display**: chain discovery, per-directory content dedup
  (⧉ badge), byte totals and budget bar all mirror the real rules of
  `@deepseek-ai/dsh-agent-instructions`.
- **Safe writes**: filename whitelist + realpath project-root containment + mtime
  conflict detection (409 → reload or force-overwrite) + temp-file atomic rename.
- **Honest hints**: the instruction loader has no file watcher — saved content is
  guaranteed for new sessions; already-open sessions sync after their next successful
  file operation.

## Install

The plugin is currently in private testing and has not been published to npm. Download it with a GitHub account that has access to the repository:

1. Sign in to GitHub, open [MaRi23333/dsh-agent-instructions-editor](https://github.com/MaRi23333/dsh-agent-instructions-editor), select **Code → Download ZIP**, and extract it locally. Alternatively, sign in to GitHub CLI with an authorized account and run `gh repo clone MaRi23333/dsh-agent-instructions-editor`.
2. Replace the path below with the absolute path to the extracted or cloned plugin directory (containing `package.json` and `lib/`), keep the quotes, and run:

```sh
npx @deepseek-ai/dsh plugin --profile web add "file:/absolute/path/to/dsh-agent-instructions-editor" --ignore-scripts
```

3. **Restart dsh web** (stop the current process, then run `dsh web`) and refresh the page.

On Windows, an example path is `"file:C:/Plugins/dsh-agent-instructions-editor-main"`. Keep the `file:` prefix so the installer also installs runtime dependencies; a plain directory path is treated as a local development link. Node.js 22+, pnpm, and a DSH CLI matching the installed host are required.

The repository includes the `lib/` build artifacts; no development dependency installation or build is needed. `--ignore-scripts` uses those existing artifacts.

Package-name installation instructions will be provided after publication to npm.

## Security model and known limitations

- Every route validates that the Host header is a loopback literal (`127.x.x.x`,
  `localhost`, `[::1]` — any port), closing off DNS rebinding; POST additionally
  requires a JSON content-type and a strict same-origin Origin (local script clients
  without an Origin header are unaffected).
- Write path: filename whitelist (4 candidates) + directory realpath must fall inside a
  registered project's "project root → working directory" ancestor chain + mtime
  conflict fence (409) + atomic temp-file rename. A malicious local process runs at the
  same trust level as this user (it could edit the files directly) and is not within the
  threat model.
- Reads follow symlinks (same exposure as the official loader); writes replace the
  symlink itself via rename and never write through to the target.
- Under extreme concurrency there is a microsecond stat→rename window where an update
  could in theory be silently lost (no file lock — same as ordinary editors).
- The editor works with the loader defaults preset by the deployment (markers=`[.git]`,
  4 candidates, 65,536-byte budget); if you change dsh-base's agent-instructions
  configuration, the editor's display drifts accordingly.
- UI copy is currently hardcoded Chinese (a locale dictionary is registered for future
  `t()` integration).

## Architecture

- **Host half** (`src/index.ts`): its own HTTP routes `/agent-instructions/api/{projects,chain,file}`
  (the standard `api.settings.*` wire is allow-listed and unavailable to third-party
  namespaces); the manual-project registry lives in the `agent-instructions-editor`
  settings namespace.
- **Client half** (`src/client/`): contributes the settings page via the
  `settings.section` slot; plain textarea editor (zero extra dependencies).
- **Discovery** (`src/chain.ts`): mirrors the instruction loader rule by rule (marker
  walk-up, ancestor chain, candidate probing, per-directory sha1(trim) dedup) — pure
  Node, unit-testable.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test      # tsx --test tests/chain.test.ts (discovery logic)
pnpm run build     # tsdown: lib/index.js (host) + lib/client.js (browser)
pnpm run smoke     # smoke-host.mjs + smoke-client.mjs
pnpm run check:pack
```

- Dev dependencies are pinned to DSH `0.1.2-rc.1` (matching the running host). The
  exhaustive exact-version overrides in `pnpm-workspace.yaml` exist because:
  1. pnpm 11.21.0 mis-expands caret ranges with prerelease lower bounds
     (`^0.1.2-rc.1` → `>=0.1.2 <0.2.0-0`, which excludes 0.1.2-rc.1 itself), causing
     NO_MATCHING_VERSION; and
  2. `@deepseek-ai/dsh-client-runtime` / `@deepseek-ai/dsh-host-apiproxy` stopped being
     published at `0.1.1-rc.2` (inlined into the CLI from 0.1.2 on).
- These dependencies are used for typechecking and tests only; none of it ships in the
  published artifact (see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)).

## License

[MIT](./LICENSE). The published artifact bundles no third-party code — see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

This plugin is an independent community project, not affiliated with or endorsed by
DeepSeek; the `DeepSeek Harness` name is used solely to indicate platform compatibility.
