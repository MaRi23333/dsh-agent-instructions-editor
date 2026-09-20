# dsh-agent-instructions-editor

**中文 | [English](./README.en.md)**

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-agent-instructions-editor — DeepSeek Harness 个性化指令编辑器插件" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/MaRi23333/dsh-agent-instructions-editor/ci.yml?style=flat-square&label=CI" alt="CI" />
  <img src="https://img.shields.io/github/license/MaRi23333/dsh-agent-instructions-editor?style=flat-square" alt="License: MIT" />
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--rc.1-4d6bfe?style=flat-square" alt="DeepSeek Harness 0.1.2-rc.1" />
</p>

> **English:** dsh-agent-instructions-editor adds a 个性化指令 (Personalization)
> settings page to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
> Web GUI for editing the harness workspace instruction files — the user-global
> `~/.dsh/AGENTS.md`, project-chain `AGENTS.md`/`CLAUDE.md` files, and
> `AGENTS.local.md`/`CLAUDE.local.md` overlays — in the spirit of Codex's
> personalization settings. See [README.en.md](./README.en.md) for the full English version.

## 简介

DeepSeek Harness 的个性化指令编辑插件：在 Web 设置页里直接编辑指令文件体系（对标 Codex 的「个性化」设置），由全局编辑器 + 项目链浏览器 + 覆盖层组成，带字节预算显示与「新会话生效」提示。

- **全局指令**：常驻编辑器，读写 `~/.dsh/AGENTS.md`，显示字节预算（默认 65,536）。
- **项目指令**（默认折叠）：项目选择器（自动发现：工作区注册表 + 最近会话目录；也可手动粘贴路径）→ 按「项目根 → 工作目录」逐层展示每层的 4 个候选槽位（AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md），存在即可点击编辑，不存在可新建。
- **与加载器相同的发现规则**：项目链发现、按目录内容去重（⧉ 徽标）、字节合计与预算条，遵循 `@deepseek-ai/dsh-agent-instructions` 的同一套规则。
- **受控的写入**：文件名白名单 + realpath 项目根包含校验 + mtime 冲突检测（409 → 重新加载或覆盖）+ 临时文件原子替换；同一 dsh web 进程内对同一文件的写入按队列串行化，使用旧修改时间的普通保存会收到 409 提示。
- **生效提示**：保存后建议新建会话。编辑器不会直接替换已有会话中的指令；已有会话何时重新读取由宿主加载器决定。

## 界面预览

![个性化指令设置页：全局指令编辑器、字节预算与项目指令链](./assets/readme/settings.png)

全局指令和项目指令可在同一设置页查看与编辑。截图中的界面语言为中文。

## 安装

用与所装宿主配套的 DSH CLI 从 npm 安装（推荐）：

```sh
dsh plugin --profile web add dsh-agent-instructions-editor@latest
```

然后**重启 dsh web**（停止当前进程，再运行 `dsh web`）并刷新页面。npm 安装不可用时，可改为从 GitHub 固定 tag 安装：

```sh
dsh plugin --profile web add github:MaRi23333/dsh-agent-instructions-editor#v0.1.2
```

两种方式都在重启 dsh web 后生效。

**从本地目录或 GitHub 安装切换到 npm**：使用上面带 `@latest` 的命令，明确请求 npm 上的版本。不要省略 `@latest`，以免旧安装被判断为已存在而跳过更新。完成后重启 dsh web。

环境要求：Node.js 22+、pnpm，以及与所装宿主匹配的 DSH CLI。无需本地构建：npm 包与 GitHub 仓库都附带 `lib/` 构建产物。

## 安全模型与已知限制

- 所有路由校验 Host 头必须为 loopback 字面量（`127.x.x.x` / `localhost` / `[::1]`，任意端口）——封死 DNS rebinding；POST 额外要求 JSON content-type 与严格同源 Origin（无 Origin 的本机脚本客户端不受影响）。
- 写路径：文件名白名单（4 个候选）+ 目录 realpath 必须落在已注册项目的「项目根→工作目录」祖先链内 + mtime 冲突栅栏（409）+ 临时文件原子替换。同一进程内对同一目标的写入经内存队列串行化，mtime 栅栏在队列内复检；跨进程没有文件锁——外部编辑器等其他进程同时保存同一文件时，栅栏复检与 rename 之间仍有极小竞态窗口，理论上可能静默丢失一次外部更新（与常规编辑器一致）。本机恶意进程与本用户同信任级别（可直接改磁盘文件），不在防御边界内。
- 指令文件本身是 symlink 时读取会跟随目标（与官方加载器同暴露面）；写入通过 rename 替换 symlink 本身，不会写穿目标。
- 编辑器按部署预置的加载器默认值工作（markers=`[.git]`、候选 4 件套、预算 65,536）；若用户修改 dsh-base 的 agent-instructions 配置（自定义 markers/候选/预算），编辑器展示会随之漂移。
- UI 文案当前为硬编码中文（locale 字典已注册，供后续接入 `t()`）。

## 架构

- **Host 半区**（`src/index.ts`）：自有 HTTP 路由 `/agent-instructions/api/{projects,chain,file}`（标准 `api.settings.*` wire 是白名单制，第三方命名空间不可用）；手动项目注册表存放在 `agent-instructions-editor` 设置命名空间。
- **Client 半区**（`src/client/`）：`settings.section` 槽位贡献设置页；纯 textarea 编辑器（零额外依赖）。
- **发现逻辑**（`src/chain.ts`）：按指令加载器的规则逐条复刻（marker 上溯、祖先链、候选探测、目录内 sha1(trim) 去重），纯 Node 可单测。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run test      # 发现、写入与编辑状态单测
pnpm run build     # tsdown：lib/index.js（host）+ lib/client.js（browser）
pnpm run smoke     # smoke-host.mjs + smoke-client.mjs
pnpm run check:pack
```

- 开发依赖锁定 DSH `0.1.2-rc.1`。`pnpm-workspace.yaml` 的 overrides 出于两个原因全量精确钉版：
  1. pnpm 11.21.0 会把 `^0.1.2-rc.1` 这类带预发布下界的 caret 范围错误展开为 `>=0.1.2 <0.2.0-0`（排除了 0.1.2-rc.1 自身），导致 NO_MATCHING_VERSION；
  2. `@deepseek-ai/dsh-client-runtime` / `@deepseek-ai/dsh-host-apiproxy` 自 0.1.2 起被内联重构、停止单独发版，钉在最后的 `0.1.1-rc.2`。
- 这些依赖仅用于类型检查与测试，不进入发布产物（见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)）。

## License

[MIT](./LICENSE)。本发布产物不内联任何第三方代码，说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

本插件是独立社区项目，与 DeepSeek 无任何隶属或背书关系；`DeepSeek Harness` 名称仅用于标明兼容平台。
