/**
 * The 个性化指令 settings section: a global-file editor (always visible) and
 * a collapsed-by-default project area (selector → loader-exact chain → chips
 * → one inline editor at a time). All writes fence on the server's mtime;
 * conflicts offer reload-from-disk vs. overwrite-with-mine.
 */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ChainView, FileSlotView, FileWriteResult, ProjectsView } from './index.tsx'
import { chainResultMayLand, classifyGlobalRead, mergeFreshContent, mergeSaveSuccess, responseIsCurrent } from './editState.ts'
import type { GlobalReadState } from './editState.ts'
import { SectionIcon } from './icon.tsx'

export interface InstructionsSectionInjected {
  readProjects: () => Promise<ProjectsView>
  writeProjects: (
    write: { op: 'add'; dir: string } | { op: 'remove'; id: string },
    expectedRevision?: number,
  ) => Promise<{ ok: true; view: ProjectsView } | { ok: false; conflict?: boolean; message?: string }>
  readChain: (dir: string) => Promise<ChainView>
  readFile: (scope: 'global' | 'project', dir: string | undefined, name: string) => Promise<{
    exists: boolean
    displayPath: string
    content: string
    bytes: number
    mtimeMs?: number
  }>
  writeFile: (write: {
    scope: 'global' | 'project'
    dir?: string
    name: string
    content: string
    expectedMtimeMs?: number | null
  }) => Promise<FileWriteResult>
  pickDirectory: () => Promise<string | null>
  subscribeRefresh: (fn: () => void) => () => void
}

export type InstructionsSectionProps = PropsRuntime<'settings.section'> & InjectFace<InstructionsSectionInjected>

const encoder = new TextEncoder()
const bytesOf = (text: string): number => encoder.encode(text).length

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

const OPEN_KEY = 'aie.projects.open'
const SELECTED_KEY = 'aie.selected.dir'

// ── styles (theme-neutral: rgba grays work on light and dark) ───────────────

// ── typography（可读性分层：中文长文 vs 短技术值）───────────────────────────
// 正文字段（AGENTS.md 指令正文等长中文文本）——可读性关键：跟随界面字体，放弃等宽
const proseStyle = {
  fontFamily: 'inherit',
  fontSize: 13.5,
  lineHeight: 1.6,
} as const

// 技术/短字段（路径、字节读数、文件名等短英文值）——保留等宽，字号加大（原先 12/12.5 的等宽小字是看不清的主因）
const monoStyle = {
  fontFamily: 'Consolas, Menlo, monospace',
  fontSize: 13,
  lineHeight: 1.5,
} as const

// 标签与说明文字
const labelStyle = { fontSize: 13, opacity: 0.75 } as const

const S = {
  root: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 } as React.CSSProperties,
  heading: { fontSize: 15, fontWeight: 600, margin: 0 } as React.CSSProperties,
  sub: { ...labelStyle, margin: 0 } as React.CSSProperties,
  card: {
    border: '1px solid rgba(128,128,128,0.35)',
    borderRadius: 8,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  } as React.CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as React.CSSProperties,
  path: { ...monoStyle, opacity: 0.65 } as React.CSSProperties,
  textarea: {
    width: '100%',
    minHeight: 170,
    boxSizing: 'border-box',
    ...proseStyle,
    padding: 8,
    border: '1px solid rgba(128,128,128,0.4)',
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    resize: 'vertical',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  } as React.CSSProperties,
  button: {
    padding: '4px 12px',
    fontSize: 13,
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  } as React.CSSProperties,
  primary: {
    padding: '4px 14px',
    fontSize: 13,
    borderRadius: 6,
    border: '1px solid transparent',
    background: 'rgba(59,130,246,0.9)',
    color: '#fff',
    cursor: 'pointer',
  } as React.CSSProperties,
  danger: {
    padding: '4px 12px',
    fontSize: 13,
    borderRadius: 6,
    border: '1px solid rgba(220,38,38,0.55)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  } as React.CSSProperties,
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 9px',
    // 文件名/字节读数是短技术值 → 等宽（读数与大小时不打表）
    ...monoStyle,
    fontSize: 12.5,
    lineHeight: 1.4,
    borderRadius: 999,
    border: '1px solid rgba(128,128,128,0.45)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  } as React.CSSProperties,
  chipNew: {
    borderStyle: 'dashed',
    opacity: 0.7,
  } as React.CSSProperties,
  barOuter: {
    height: 6,
    borderRadius: 3,
    background: 'rgba(128,128,128,0.25)',
    overflow: 'hidden',
    flex: 1,
    minWidth: 120,
  } as React.CSSProperties,
  barInner: { height: '100%', borderRadius: 3 } as React.CSSProperties,
  hint: { fontSize: 12.5, opacity: 0.65, margin: 0 } as React.CSSProperties,
  banner: {
    fontSize: 13,
    padding: '6px 10px',
    borderRadius: 6,
    background: 'rgba(217,119,6,0.14)',
    border: '1px solid rgba(217,119,6,0.45)',
  } as React.CSSProperties,
  ok: {
    fontSize: 13,
    padding: '6px 10px',
    borderRadius: 6,
    background: 'rgba(22,163,74,0.12)',
    border: '1px solid rgba(22,163,74,0.4)',
  } as React.CSSProperties,
  error: {
    fontSize: 13,
    padding: '6px 10px',
    borderRadius: 6,
    background: 'rgba(220,38,38,0.12)',
    border: '1px solid rgba(220,38,38,0.45)',
  } as React.CSSProperties,
  select: {
    fontSize: 13,
    padding: '3px 6px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'transparent',
    color: 'inherit',
    maxWidth: 420,
  } as React.CSSProperties,
  input: {
    ...monoStyle,
    padding: '3px 8px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'transparent',
    color: 'inherit',
    flex: 1,
    minWidth: 220,
  } as React.CSSProperties,
}

function byteColor(ratio: number): string {
  if (ratio >= 1) return 'rgba(220,38,38,0.85)'
  if (ratio >= 0.7) return 'rgba(217,119,6,0.85)'
  return 'rgba(22,163,74,0.75)'
}

// ── component ───────────────────────────────────────────────────────────────

interface GlobalEditor {
  displayPath: string
  exists: boolean
  content: string
  draft: string
  mtimeMs: number | null
  bytes: number
  conflict: boolean
  /** AIE-BUDGET-003: set when the initial read could not produce a body. */
  readFailed?: GlobalReadState
  readErrorMessage?: string
}

interface EditingState {
  dir: string
  name: string
  displayPath: string
  exists: boolean
  content: string
  draft: string
  mtimeMs: number | null
  conflict: boolean
}

export function InstructionsSection(props: InstructionsSectionProps): React.ReactElement {
  const { readProjects, writeProjects, readChain, readFile, writeFile, pickDirectory, subscribeRefresh } = props

  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const [projects, setProjects] = useState<ProjectsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [open, setOpen] = useState<boolean>(() => window.localStorage.getItem(OPEN_KEY) === '1')
  const [selectedDir, setSelectedDir] = useState<string | null>(() => window.localStorage.getItem(SELECTED_KEY))
  const [chain, setChain] = useState<ChainView | null>(null)
  const [manualDir, setManualDir] = useState('')
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [global_, setGlobal] = useState<GlobalEditor | null>(null)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const busyRef = useRef(false)
  const editingBusyRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  // Monotonic request generation for the per-file editor: bumping it (open,
  // reload, project switch) invalidates every in-flight read so a late
  // response can never land in a newer editor session (AIE-UI-002).
  const editingReqRef = useRef(0)
  // Same discipline for the chain/budget view (AIE-BUDGET-003 r3): only the
  // newest loadChain response may land.
  const chainReqRef = useRef(0)
  // Latest selection, mirrored for async completions: an async callback must
  // refresh the project selected *now*, not the one captured when the
  // request was issued (AIE-BUDGET-003 r3 — stale closure).
  const selectionRef = useRef({ open: false, selectedDir: null as string | null })
  useEffect(() => {
    selectionRef.current = { open, selectedDir }
  }, [open, selectedDir])
  // Latest global draft as typed; lets the post-save flash report honestly
  // when the user kept typing while the request was in flight (AIE-UI-001).
  const globalDraftRef = useRef('')

  const say = (kind: 'ok' | 'error', text: string): void => { setFlash({ kind, text }) }

  const showFlash = (next: { kind: 'ok' | 'error'; text: string } | null): void => { setFlash(next) }

  // ── data loading ──────────────────────────────────────────────────────
  /**
   * AIE-BUDGET-003: the budget bar's chain view folds in the global file's
   * loader-relevant bytes, so whenever the global file may have changed on
   * disk (save, reload, external edit + re-read) the current chain view must
   * be re-read or the bar shows stale numbers. Reads the CURRENT selection
   * from the mirror — never the closure captured when the async operation
   * was issued — and loadChain's generation guard drops the response if the
   * user has since switched projects or collapsed the section.
   */
  const refreshBudget = (): void => {
    const current = selectionRef.current
    if (current.open && current.selectedDir !== null) void loadChain(current.selectedDir)
  }

  const loadGlobal = async (): Promise<void> => {
    try {
      const file = await readFile('global', undefined, 'AGENTS.md')
      if (!aliveRef.current) return
      globalDraftRef.current = file.content
      setGlobal({
        displayPath: file.displayPath,
        exists: file.exists,
        content: file.content,
        draft: file.content,
        mtimeMs: file.exists && file.mtimeMs !== undefined ? file.mtimeMs : null,
        bytes: file.bytes,
        conflict: false,
        readFailed: undefined,
        readErrorMessage: undefined,
      })
      refreshBudget()
    } catch (error) {
      // AIE-BUDGET-003: a failed read is a distinct editor state — most
      // importantly `file-too-large`, where the over-limit fact stands even
      // though no body was read (the loader skips such files anyway).
      if (!aliveRef.current) return
      const code = error instanceof Error ? (error as { code?: string }).code : undefined
      const readState = classifyGlobalRead(code)
      setGlobal({
        displayPath: '~/.dsh/AGENTS.md',
        exists: readState === 'too-large',
        content: '',
        draft: '',
        mtimeMs: null,
        bytes: 0,
        conflict: false,
        readFailed: readState,
        readErrorMessage: String(error),
      })
    }
  }

  const loadProjects = async (keepSelection: boolean): Promise<void> => {
    try {
      const view = await readProjects()
      if (!aliveRef.current) return
      setProjects(view)
      setLoadError(null)
      const usable = view.projects.filter((entry) => !entry.missing)
      const currentStillUsable = keepSelection && selectedDir !== null
        && usable.some((entry) => (entry.realpath ?? entry.dir) === selectedDir)
      if (!currentStillUsable) {
        const first = usable[0]?.realpath ?? usable[0]?.dir ?? null
        setSelectedDir(first)
        if (first !== null) window.localStorage.setItem(SELECTED_KEY, first)
        else window.localStorage.removeItem(SELECTED_KEY)
      }
    } catch (error) {
      if (aliveRef.current) setLoadError(String(error))
    }
  }

  /** A push that arrived while busy is re-run here instead of being lost. */
  const flushPendingRefresh = (): void => {
    if (!pendingRefreshRef.current) return
    pendingRefreshRef.current = false
    void loadProjects(true)
  }

  const loadChain = async (dir: string): Promise<void> => {
    // AIE-BUDGET-003 r4: a chain response lands only when ALL hold — the
    // component is alive, no newer chain request was issued, the section is
    // still open, and the response is for the project the user is STILL
    // looking at. Generation alone is not enough: a stale async callback
    // (e.g. a project-file save completing after a project switch) can issue
    // the newest request for an old directory.
    const request = ++chainReqRef.current
    try {
      const view = await readChain(dir)
      const current = selectionRef.current
      const lands = chainResultMayLand({
        alive: aliveRef.current,
        requestIsNewest: responseIsCurrent(chainReqRef.current, request),
        open: current.open,
        selectedDir: current.selectedDir,
        requestedDir: dir,
      })
      if (!lands) return
      setChain(view)
    } catch (error) {
      if (!aliveRef.current || !responseIsCurrent(chainReqRef.current, request)) return
      say('error', String(error))
    }
  }

  useEffect(() => {
    void loadProjects(false)
    void loadGlobal()
    const off = subscribeRefresh(() => {
      if (busyRef.current || editingBusyRef.current) {
        pendingRefreshRef.current = true
        return
      }
      void loadProjects(true)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (open && selectedDir !== null) void loadChain(selectedDir)
    else {
      // AIE-BUDGET-003 r3: clearing the view also invalidates any in-flight
      // chain read so a late response cannot repopulate a collapsed section.
      ++chainReqRef.current
      setChain(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedDir])

  const toggleOpen = (): void => {
    setOpen((previous) => {
      window.localStorage.setItem(OPEN_KEY, previous ? '0' : '1')
      return !previous
    })
  }

  // ── global editor actions ─────────────────────────────────────────────
  const saveGlobal = async (force: boolean): Promise<void> => {
    if (global_ === null || busyRef.current) return
    busyRef.current = true
    try {
      let mtimeMs = global_.mtimeMs
      if (force) {
        const fresh = await readFile('global', undefined, 'AGENTS.md')
        mtimeMs = fresh.exists && fresh.mtimeMs !== undefined ? fresh.mtimeMs : null
      }
      // AIE-UI-001: send this exact snapshot; the success handler commits
      // only it, so input typed during the flight stays dirty.
      const snapshot = global_.draft
      const result = await writeFile({
        scope: 'global',
        name: 'AGENTS.md',
        content: snapshot,
        expectedMtimeMs: mtimeMs,
      })
      if (!aliveRef.current) return
      if (result.ok) {
        setGlobal((previous) => previous === null ? previous : {
          ...mergeSaveSuccess(previous, snapshot, result),
          bytes: result.bytes,
        })
        refreshBudget()
        const diverged = globalDraftRef.current !== snapshot
        showFlash({ kind: 'ok', text: diverged
          ? '已保存，但保存期间你又有新的输入尚未写入磁盘——请再次保存。'
          : '全局指令已保存。新会话保证生效；已开启的会话会在下一次文件操作后自动同步。' })
      } else if (result.conflict) {
        setGlobal((previous) => previous === null ? previous : { ...previous, conflict: true })
      } else {
        say('error', result.message ?? '保存失败')
      }
    } finally {
      busyRef.current = false
      flushPendingRefresh()
    }
  }

  // ── project actions ───────────────────────────────────────────────────
  const addProject = async (dir: string): Promise<void> => {
    if (projects === null || busyRef.current) return
    const trimmed = dir.trim()
    if (trimmed === '' || !(trimmed.startsWith('\\') || trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed))) {
      say('error', '请提供绝对路径（如 E:\\path\\to\\project）。')
      return
    }
    busyRef.current = true
    try {
      const result = await writeProjects({ op: 'add', dir: trimmed }, projects.revision)
      if (!aliveRef.current) return
      if (result.ok) {
        setProjects(result.view)
        setManualDir('')
        const added = result.view.projects.find((entry) => entry.source === 'manual'
          && (entry.realpath ?? entry.dir).toLowerCase() === trimmed.toLowerCase())
        const target = added?.realpath ?? added?.dir
        if (target !== undefined) {
          setSelectedDir(target)
          window.localStorage.setItem(SELECTED_KEY, target)
          setOpen(true)
          window.localStorage.setItem(OPEN_KEY, '1')
        }
        showFlash({ kind: 'ok', text: '项目已添加。' })
      } else if (result.conflict) {
        say('error', '项目列表已被其他窗口修改，请重试。')
        void loadProjects(true)
      } else {
        say('error', result.message ?? '添加失败')
      }
    } finally {
      busyRef.current = false
      flushPendingRefresh()
    }
  }

  const removeProject = async (id: string, label: string): Promise<void> => {
    if (projects === null || busyRef.current) return
    if (!window.confirm(`从列表移除项目「${label}」？\n（只从编辑器列表移除，不会删除任何文件）`)) return
    busyRef.current = true
    try {
      const result = await writeProjects({ op: 'remove', id }, projects.revision)
      if (!aliveRef.current) return
      if (result.ok) {
        setProjects(result.view)
        showFlash({ kind: 'ok', text: '已移除。' })
      } else if (result.conflict) {
        say('error', '项目列表已被其他窗口修改，请重试。')
        void loadProjects(true)
      } else {
        say('error', result.message ?? '移除失败')
      }
    } finally {
      busyRef.current = false
      flushPendingRefresh()
    }
  }

  // ── file editor actions ───────────────────────────────────────────────
  const openEditor = async (dir: string, slot: FileSlotView): Promise<void> => {
    if (editingBusyRef.current) return
    // AIE-UI-002: this open invalidates any in-flight read; it applies only
    // while it is still the newest editing request.
    const request = ++editingReqRef.current
    try {
      const file = await readFile('project', dir, slot.name)
      if (!aliveRef.current || request !== editingReqRef.current) return
      setEditing({
        dir,
        name: slot.name,
        displayPath: file.displayPath,
        exists: file.exists,
        content: file.content,
        draft: file.content,
        mtimeMs: file.exists && file.mtimeMs !== undefined ? file.mtimeMs : null,
        conflict: false,
      })
    } catch (error) {
      say('error', String(error))
    }
  }

  const saveEditing = async (force: boolean): Promise<void> => {
    if (editing === null || editingBusyRef.current) return
    editingBusyRef.current = true
    const savedTarget = { dir: editing.dir, name: editing.name }
    try {
      let mtimeMs = editing.mtimeMs
      if (force) {
        const fresh = await readFile('project', editing.dir, editing.name)
        mtimeMs = fresh.exists && fresh.mtimeMs !== undefined ? fresh.mtimeMs : null
      }
      // AIE-UI-001: send this exact snapshot; the success handler commits
      // only it, so input typed during the flight stays dirty.
      const snapshot = editing.draft
      const result = await writeFile({
        scope: 'project',
        dir: savedTarget.dir,
        name: savedTarget.name,
        content: snapshot,
        expectedMtimeMs: mtimeMs,
      })
      if (!aliveRef.current) return
      if (result.ok) {
        setEditing((previous) => {
          if (previous === null) return previous
          // AIE-UI-002: the editor may have switched targets while the
          // request was in flight — never land file A's result on B.
          if (previous.dir !== savedTarget.dir || previous.name !== savedTarget.name) return previous
          return mergeSaveSuccess(previous, snapshot, result)
        })
        // AIE-BUDGET-003 r4: refresh via the current-selection mirror — the
        // click-time `selectedDir` closure would re-read the OLD project if
        // the user switched while the save was in flight.
        refreshBudget()
        showFlash({ kind: 'ok', text: `已保存 ${editing.displayPath}。新会话保证生效；已开启的会话会在下一次文件操作后自动同步。` })
      } else if (result.conflict) {
        setEditing((previous) => {
          if (previous === null) return previous
          if (previous.dir !== savedTarget.dir || previous.name !== savedTarget.name) return previous
          return { ...previous, conflict: true }
        })
      } else {
        say('error', result.message ?? '保存失败')
      }
    } finally {
      editingBusyRef.current = false
      flushPendingRefresh()
    }
  }

  const reloadEditing = async (): Promise<void> => {
    if (editing === null || editingBusyRef.current) return
    const requested = { dir: editing.dir, name: editing.name }
    // AIE-UI-002: the response may only apply while this is still the newest
    // request AND the editor is still bound to the requested file.
    const request = ++editingReqRef.current
    try {
      const fresh = await readFile('project', requested.dir, requested.name)
      if (!aliveRef.current || request !== editingReqRef.current) return
      setEditing((previous) => previous === null ? null : mergeFreshContent(previous, requested, { dir: previous.dir, name: previous.name }, fresh))
    } catch (error) {
      say('error', String(error))
    }
  }

  // ── render ────────────────────────────────────────────────────────────
  // AIE-BUDGET-003: the host already folds the loader-relevant share of the
  // global file into chain.totalBytes (skipping it when over 1 MiB) — the
  // client must not add it a second time.
  const totalBytes = chain?.totalBytes ?? 0
  const budgetBytes = chain?.budgetBytes ?? projects?.budgetBytes ?? 65536
  const ratio = budgetBytes > 0 ? totalBytes / budgetBytes : 0
  const usableProjects = (projects?.projects ?? []).filter((entry) => !entry.missing)
  const selectedEntry = usableProjects.find((entry) => (entry.realpath ?? entry.dir) === selectedDir)

  const conflictBanner = (onReload: () => void, onOverwrite: () => void): React.ReactElement => (
    <div style={{ ...S.banner, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span>文件已被外部修改。</span>
      <button type="button" style={S.button} onClick={onReload}>从磁盘重新加载（丢弃本地修改）</button>
      <button type="button" style={S.danger} onClick={onOverwrite}>用当前内容覆盖</button>
    </div>
  )

  return (
    <div style={S.root}>
      <div>
        <h3 style={{ ...S.heading, display: 'flex', alignItems: 'center', gap: 8 }}>
          <SectionIcon size={18} />
          个性化指令
        </h3>
        <p style={S.sub}>
          编辑 DeepSeek Harness 的工作区指令文件（AGENTS.md 体系）。全局指令对所有项目生效，项目指令只作用于对应目录。
          字节合计为源文件估算（已排除超 1 MiB 被加载器跳过的文件、同目录去重文件），与加载器渲染后上下文的实际预算占用不完全等价。
        </p>
      </div>

      {flash !== null && (
        <div style={flash.kind === 'ok' ? S.ok : S.error} onClick={() => showFlash(null)} role="status">
          {flash.text}
        </div>
      )}

      {/* ── 全局 ─────────────────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={S.row}>
          <strong style={{ fontSize: 13 }}>全局指令</strong>
          {global_ !== null && <span style={S.path}>{global_.displayPath}</span>}
        </div>
        {global_ === null
          ? <p style={S.hint}>加载中…</p>
          : global_.readFailed === 'too-large' ? (
          <p style={S.hint}>⚠ 全局文件超过 1 MiB：加载器会整体跳过它（不计入预算），编辑器也不载入这么大的正文——请在本插件外编辑该文件。</p>
          ) : global_.readFailed === 'failed' ? (
          <div style={S.row}>
            <p style={{ ...S.hint, margin: 0, flex: 1, minWidth: 0 }}>全局文件读取失败：{global_.readErrorMessage}</p>
            <button type="button" style={S.button} onClick={() => void loadGlobal()}>重试</button>
          </div>
          ) : (
          <>
            <textarea
              style={S.textarea}
              value={global_.draft}
              spellCheck={false}
              onChange={(event) => {
                const draft = event.target.value
                globalDraftRef.current = draft
                setGlobal((previous) => previous === null ? previous : { ...previous, draft })
              }}
              placeholder={'## 全局偏好\n\n在这里写下希望所有会话遵守的约定，例如语言、代码风格、回复习惯……'}
            />
            {global_.conflict && conflictBanner(
              () => void loadGlobal(),
              () => void saveGlobal(true),
            )}
            <div style={S.row}>
              <span style={S.path}>{bytesOf(global_.draft)} 字节 / {budgetBytes} 预算</span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={S.button}
                onClick={() => setGlobal((previous) => {
                  if (previous === null) return previous
                  globalDraftRef.current = previous.content
                  return { ...previous, draft: previous.content }
                })}
                disabled={global_.draft === global_.content}
              >还原</button>
              <button
                type="button"
                style={S.primary}
                onClick={() => void saveGlobal(false)}
                disabled={busyRef.current || global_.draft === global_.content}
              >保存</button>
            </div>
          </>
          )}
        {/* AIE-BUDGET-003: the over-limit fact must not depend on reading the
            body — surface it from the chain view in every editor state. */}
        {chain?.global.overLimit === true && global_?.readFailed !== 'too-large' && (
          <p style={S.hint}>⚠ 全局文件超过 1 MiB：加载器会整体跳过它（未计入下方预算）。</p>
        )}
      </div>

      {/* ── 项目 ─────────────────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={S.row}>
          <button type="button" style={{ ...S.button, border: 'none', padding: '2px 4px' }} onClick={toggleOpen}>
            {open ? '▾' : '▸'} 项目指令
          </button>
          {projects !== null && (
            <span style={S.path}>
              {usableProjects.length} 个项目
              {chain !== null ? ` · 链上 ${formatBytes(totalBytes)} / ${formatBytes(budgetBytes)}` : ''}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {chain !== null && (
            <span style={{ ...S.barOuter, maxWidth: 220 }}>
              <span style={{ ...S.barInner, width: `${Math.min(100, ratio * 100)}%`, background: byteColor(ratio) }} />
            </span>
          )}
        </div>

        {open && (
          projects === null
            ? <p style={S.hint}>{loadError ?? '加载中…'}</p>
            : (
          <>
            <div style={S.row}>
              <select
                style={S.select}
                value={selectedDir ?? ''}
                onChange={(event) => {
                  const dir = event.target.value
                  setSelectedDir(dir === '' ? null : dir)
                  // AIE-UI-002: closing the editor invalidates its in-flight reads.
                  ++editingReqRef.current
                  setEditing(null)
                  if (dir === '') window.localStorage.removeItem(SELECTED_KEY)
                  else window.localStorage.setItem(SELECTED_KEY, dir)
                }}
              >
                {usableProjects.length === 0 && <option value="">（暂无项目）</option>}
                {usableProjects.map((entry) => (
                  <option key={entry.id} value={entry.realpath ?? entry.dir}>
                    {entry.label}（{entry.source === 'manual' ? '手动' : '自动'}）
                  </option>
                ))}
              </select>
              {selectedEntry !== null && selectedEntry !== undefined && selectedEntry.source === 'manual' && (
                <button
                  type="button"
                  style={S.button}
                  onClick={() => void removeProject(selectedEntry.id.slice('manual:'.length), selectedEntry.label)}
                >移除</button>
              )}
              <button
                type="button"
                style={S.button}
                onClick={() => {
                  void (async () => {
                    const dir = await pickDirectory()
                    if (dir !== null) void addProject(dir)
                    else say('error', '目录选择器不可用，请在下方粘贴路径。')
                  })()
                }}
              >选择目录…</button>
            </div>
            <div style={S.row}>
              <input
                style={S.input}
                value={manualDir}
                placeholder="或粘贴项目绝对路径，如 E:\path\to\project"
                onChange={(event) => setManualDir(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && manualDir.trim() !== '') void addProject(manualDir)
                }}
              />
              <button
                type="button"
                style={S.primary}
                disabled={manualDir.trim() === '' || busyRef.current}
                onClick={() => void addProject(manualDir)}
              >添加</button>
            </div>

            {chain !== null && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {chain.dirs.map((dir) => (
                  <div key={dir.absolutePath} style={{ borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 6 }}>
                    <div style={{ ...S.path, marginBottom: 4 }}>
                      {dir.isRoot ? <strong>{dir.displayPath}（项目根）</strong> : dir.displayPath}
                    </div>
                    <div style={S.row}>
                      {dir.slots.map((slot) => {
                        const label = slot.dedupWith !== undefined
                          ? `⧉ ${slot.name}（同 ${slot.dedupWith}）`
                          : `${slot.name}${slot.bytes !== undefined ? ` · ${formatBytes(slot.bytes)}` : ''}${slot.overLimit ? ' ⚠超限' : ''}`
                        if (slot.exists) {
                          return (
                            <button
                              key={slot.name}
                              type="button"
                              style={S.chip}
                              title={slot.overLimit
                                ? '超过 1 MiB：加载器会整体跳过该文件，不计入预算'
                                : slot.dedupWith !== undefined ? '与同级文件内容一致，加载器已去重；编辑会破坏去重' : undefined}
                              onClick={() => void openEditor(dir.absolutePath, slot)}
                            >{label}</button>
                          )
                        }
                        return (
                          <button
                            key={slot.name}
                            type="button"
                            style={{ ...S.chip, ...S.chipNew }}
                            title={`新建 ${slot.displayPath}`}
                            onClick={() => void openEditor(dir.absolutePath, slot)}
                          >+ {slot.name}</button>
                        )
                      })}
                    </div>
                    {editing !== null && editing.dir === dir.absolutePath && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={S.path}>{editing.displayPath}{editing.exists ? '' : '（新建）'}</span>
                        <textarea
                          style={{ ...S.textarea, minHeight: 140 }}
                          value={editing.draft}
                          spellCheck={false}
                          onChange={(event) => {
                            const draft = event.target.value
                            setEditing((previous) => previous === null ? previous : { ...previous, draft })
                          }}
                        />
                        {editing.conflict && conflictBanner(() => void reloadEditing(), () => void saveEditing(true))}
                        <div style={S.row}>
                          <span style={S.path}>{bytesOf(editing.draft)} 字节</span>
                          <span style={{ flex: 1 }} />
                          <button type="button" style={S.button} onClick={() => { ++editingReqRef.current; setEditing(null) }}>关闭</button>
                          <button
                            type="button"
                            style={S.button}
                            onClick={() => setEditing((previous) => previous === null ? previous : { ...previous, draft: previous.content })}
                            disabled={editing.draft === editing.content}
                          >还原</button>
                          <button
                            type="button"
                            style={S.primary}
                            onClick={() => void saveEditing(false)}
                            disabled={editingBusyRef.current || editing.draft === editing.content}
                          >保存</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
          )
        )}
      </div>

      <p style={S.hint}>
        ⓘ 加载顺序：全局 → 项目根 → 子目录，越具体的越优先；同目录内容一致的文件只加载一份（⧉ 标记）；全部内容共享 {formatBytes(budgetBytes)} 预算，超预算时较宽泛的文件先被省略。没有文件监视器：保存后新会话保证生效，已开启的会话由指令加载器在下一次文件操作后自动同步。
      </p>
    </div>
  )
}
