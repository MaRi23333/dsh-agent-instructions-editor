# 更新记录 / Changelog

## 0.2.3（2026-10-13）

- 修复深色主题下「个性化指令」项目切换下拉展开后未选中项白底白字、难以阅读的问题。
- Fix unreadable white-on-white unselected options in the Personalization Instructions project select popup under dark theme.
- 将项目 `<select>` 背景从 `transparent` 改为不透明平台 token `var(--dsw-alias-bg-layer-2)`；指令发现、编辑、保存及字节预算行为不变。 / Set the project `<select>` background to the opaque platform token `var(--dsw-alias-bg-layer-2)` instead of `transparent`. Instruction discovery, editing, saving, and byte-budget behavior are unchanged.

## 0.2.2（2026-10-04）

- 插件列表和详情页新增中英文名称与简介，随 DeepSeek Harness 界面语言切换。
- Added English and Chinese names and descriptions for the DeepSeek Harness plugin list and detail page.
- 本次仅修改插件元数据；指令发现、编辑和保存逻辑未变。 / This release changes metadata only; instruction discovery, editing, and saving are unchanged.
