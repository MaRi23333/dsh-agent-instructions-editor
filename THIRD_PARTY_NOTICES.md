# Third-Party Notices

This distribution (`dsh-agent-instructions-editor`) ships **no bundled third-party package code**.
Both build outputs were verified against the shipped bundles' `//#region` comments:

- `lib/index.js` — contains only this plugin's own source regions (`src/chain.ts`,
  `src/index.ts`). Its runtime imports are Node.js builtins plus two packages kept
  **external** and installed separately from npm: `@deepseek-ai/schemastery`
  (declared in `dependencies`) and `@deepseek-ai/cordis` (declared in
  `peerDependencies`, provided by the DeepSeek Harness host runtime). Neither is
  copied into this distribution, so neither is distributed here.
- `lib/client.js` — contains **no third-party package code**: the browser side loads
  React / React DOM via external `require("react")` from the host runtime, and the
  `rolldown:runtime` block is generic bundler-generated helper code, not a package.

Because no third-party package is vendored or inlined, the package licenses do not need to be reproduced here. The licenses of the externally installed packages
govern those packages as obtained from npm:

| Package | Role | License |
|---|---|---|
| `@deepseek-ai/schemastery` | runtime dependency | MIT |
| `@deepseek-ai/cordis` | peer dependency (host-provided) | MIT |

## Verification / 查证说明

- 检查方式：对发货 bundle 逐行提取 `//#region` 注释（`scripts` 构建后人工核对），
  而非依赖 lockfile 推断；两个 bundle 中除本插件源码与打包器通用运行时块外无任何
  `node_modules/` region。
- 开发期锁定的 `@deepseek-ai/*` 包（见 package.json devDependencies 与
  pnpm-workspace.yaml overrides）仅用于本地类型检查与测试，不进入发布产物。

## MIT community contribution

The dark-theme project dropdown fix from [PR #1](https://github.com/MaRi23333/dsh-agent-instructions-editor/pull/1) by @devil233-ui is included under the MIT terms in effect at contribution. The original notice is reproduced below.

MIT License

Copyright (c) 2025 dsh-agent-instructions-editor contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
