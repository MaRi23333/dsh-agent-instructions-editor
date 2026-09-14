/**
 * Locale dictionaries for the agent-instructions-editor settings section.
 * The namespace merge into `LocaleNamespaceMap` is what makes the slot-level
 * `locale` seat and the typed `t` prop work.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'agent-instructions-editor': LocaleKey
  }
}

export type LocaleKey =
  | 'title'
  | 'subtitle'
  | 'globalTitle'
  | 'projectsTitle'
  | 'save'
  | 'saved'
  | 'revert'
  | 'conflict'
  | 'reloadFromDisk'
  | 'overwrite'
  | 'newSessionHint'
  | 'rulesHint'

export const zh: Record<LocaleKey, string> = {
  title: '个性化指令',
  subtitle: '编辑 DeepSeek Harness 的工作区指令文件（AGENTS.md 体系）。',
  globalTitle: '全局指令',
  projectsTitle: '项目指令',
  save: '保存',
  saved: '已保存',
  revert: '还原',
  conflict: '文件已被外部修改',
  reloadFromDisk: '从磁盘重新加载',
  overwrite: '用当前内容覆盖',
  newSessionHint: '保存后新会话保证生效；已开启的会话会在下一次文件操作后自动同步。',
  rulesHint: '加载规则：全局 → 项目根 → 子目录，越具体的越优先；全部内容共享字节预算。',
}

export const en: Record<LocaleKey, string> = {
  title: 'Personalization',
  subtitle: 'Edit the DeepSeek Harness workspace instruction files (the AGENTS.md family).',
  globalTitle: 'Global instructions',
  projectsTitle: 'Project instructions',
  save: 'Save',
  saved: 'Saved',
  revert: 'Revert',
  conflict: 'File changed on disk',
  reloadFromDisk: 'Reload from disk',
  overwrite: 'Overwrite with my version',
  newSessionHint: 'New sessions are guaranteed to pick this up; open sessions sync on their next file operation.',
  rulesHint: 'Loading order: global → project root → subdirectories; more specific wins. Everything shares one byte budget.',
}
