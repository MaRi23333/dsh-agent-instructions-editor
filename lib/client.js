window.__ModuleLoader__.load({ id: "dsh-agent-instructions-editor", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/editState.ts
/**
* AIE-UI-001: a successful save commits **only the exact snapshot that was
* sent to the server**. Any draft the user typed while the request was in
* flight stays untouched in `draft`, so the editor remains dirty and the
* next save writes it — the page must never report more as persisted than
* what actually hit the disk.
*/
function mergeSaveSuccess(previous, snapshot, result) {
	return {
		...previous,
		content: snapshot,
		mtimeMs: result.mtimeMs,
		exists: true,
		conflict: false
	};
}
function sameTarget(a, b) {
	return a.dir === b.dir && a.name === b.name;
}
/**
* AIE-UI-002: a finished read (initial open, conflict reload) may only be
* applied to the editor session that requested it. `requested` is the
* target captured when the request was issued, `current` the target of the
* state about to be patched; on any mismatch the merge is refused (`null`)
* and the caller keeps the current state — a late response must never move
* another file's content or mtime into this editor.
*/
function mergeFreshContent(previous, requested, current, fresh) {
	if (!sameTarget(requested, current)) return null;
	return {
		...previous,
		exists: fresh.exists,
		content: fresh.content,
		draft: fresh.content,
		mtimeMs: fresh.exists && fresh.mtimeMs !== void 0 ? fresh.mtimeMs : null,
		conflict: false
	};
}
function classifyGlobalRead(code) {
	return code === "file-too-large" ? "too-large" : "failed";
}
/**
* Monotonic-request discipline shared by every async view (editing session,
* chain/budget view): a response may only land while it is still the newest
* request issued for its slot. `latestIssued` is the counter's current
* value at completion time; `thisRequest` is the generation the response
* belongs to.
*/
function responseIsCurrent(latestIssued, thisRequest) {
	return thisRequest === latestIssued;
}
function chainResultMayLand(ctx) {
	return ctx.alive && ctx.requestIsNewest && ctx.open && ctx.selectedDir === ctx.requestedDir;
}

//#endregion
//#region src/client/icon.tsx
/**
* The dedicated 个性化指令 icon: a document with a pen — instruction file
* plus editing. Stroke follows `currentColor`, so it inherits the theme's
* label color in both light and dark mode. Drawn on a 16px grid, 1.2 stroke.
* (Every third-party settings plugin owns and decorates its own icon the
* same way — see dsh-subagent-library/src/client/nav-icon.ts for the pattern.)
*/
const SECTION_ICON_INNER = "<path d=\"M13.25 8V5.5L10 2.25H4.75A1.5 1.5 0 0 0 3.25 3.75v8.5a1.5 1.5 0 0 0 1.5 1.5H7.75\"/><path d=\"M10 2.25v3.25h3.25\"/><path d=\"M6 6.5h2\"/><path d=\"M6 9h1.5\"/><path d=\"M14.1 8.9l.47.47a.81.81 0 0 1 0 1.14l-3.74 3.74-1.66.34.34-1.66 3.74-3.74a.81.81 0 0 1 1.14 0z\"/>";
function SectionIcon({ size = 16 }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
		viewBox: "0 0 16 16",
		width: size,
		height: size,
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.2,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true",
		dangerouslySetInnerHTML: { __html: SECTION_ICON_INNER }
	});
}

//#endregion
//#region src/client/InstructionsSection.tsx
const encoder = new TextEncoder();
const bytesOf = (text) => encoder.encode(text).length;
function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}
const OPEN_KEY = "aie.projects.open";
const SELECTED_KEY = "aie.selected.dir";
const proseStyle = {
	fontFamily: "inherit",
	fontSize: 13.5,
	lineHeight: 1.6
};
const monoStyle = {
	fontFamily: "Consolas, Menlo, monospace",
	fontSize: 13,
	lineHeight: 1.5
};
const S = {
	root: {
		display: "flex",
		flexDirection: "column",
		gap: 14,
		maxWidth: 860
	},
	heading: {
		fontSize: 15,
		fontWeight: 600,
		margin: 0
	},
	sub: {
		fontSize: 13,
		opacity: .75,
		margin: 0
	},
	card: {
		border: "1px solid rgba(128,128,128,0.35)",
		borderRadius: 8,
		padding: 12,
		display: "flex",
		flexDirection: "column",
		gap: 8
	},
	row: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap"
	},
	path: {
		...monoStyle,
		opacity: .65
	},
	textarea: {
		width: "100%",
		minHeight: 170,
		boxSizing: "border-box",
		...proseStyle,
		padding: 8,
		border: "1px solid rgba(128,128,128,0.4)",
		borderRadius: 6,
		background: "transparent",
		color: "inherit",
		resize: "vertical",
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere"
	},
	button: {
		padding: "4px 12px",
		fontSize: 13,
		borderRadius: 6,
		border: "1px solid rgba(128,128,128,0.4)",
		background: "transparent",
		color: "inherit",
		cursor: "pointer"
	},
	primary: {
		padding: "4px 14px",
		fontSize: 13,
		borderRadius: 6,
		border: "1px solid transparent",
		background: "rgba(59,130,246,0.9)",
		color: "#fff",
		cursor: "pointer"
	},
	danger: {
		padding: "4px 12px",
		fontSize: 13,
		borderRadius: 6,
		border: "1px solid rgba(220,38,38,0.55)",
		background: "transparent",
		color: "inherit",
		cursor: "pointer"
	},
	chip: {
		display: "inline-flex",
		alignItems: "center",
		gap: 4,
		padding: "2px 9px",
		...monoStyle,
		fontSize: 12.5,
		lineHeight: 1.4,
		borderRadius: 999,
		border: "1px solid rgba(128,128,128,0.45)",
		background: "transparent",
		color: "inherit",
		cursor: "pointer"
	},
	chipNew: {
		borderStyle: "dashed",
		opacity: .7
	},
	barOuter: {
		height: 6,
		borderRadius: 3,
		background: "rgba(128,128,128,0.25)",
		overflow: "hidden",
		flex: 1,
		minWidth: 120
	},
	barInner: {
		height: "100%",
		borderRadius: 3
	},
	hint: {
		fontSize: 12.5,
		opacity: .65,
		margin: 0
	},
	banner: {
		fontSize: 13,
		padding: "6px 10px",
		borderRadius: 6,
		background: "rgba(217,119,6,0.14)",
		border: "1px solid rgba(217,119,6,0.45)"
	},
	ok: {
		fontSize: 13,
		padding: "6px 10px",
		borderRadius: 6,
		background: "rgba(22,163,74,0.12)",
		border: "1px solid rgba(22,163,74,0.4)"
	},
	error: {
		fontSize: 13,
		padding: "6px 10px",
		borderRadius: 6,
		background: "rgba(220,38,38,0.12)",
		border: "1px solid rgba(220,38,38,0.45)"
	},
	select: {
		fontSize: 13,
		padding: "3px 6px",
		borderRadius: 6,
		border: "1px solid rgba(128,128,128,0.4)",
		background: "transparent",
		color: "inherit",
		maxWidth: 420
	},
	input: {
		...monoStyle,
		padding: "3px 8px",
		borderRadius: 6,
		border: "1px solid rgba(128,128,128,0.4)",
		background: "transparent",
		color: "inherit",
		flex: 1,
		minWidth: 220
	}
};
function byteColor(ratio) {
	if (ratio >= 1) return "rgba(220,38,38,0.85)";
	if (ratio >= .7) return "rgba(217,119,6,0.85)";
	return "rgba(22,163,74,0.75)";
}
function InstructionsSection(props) {
	const { readProjects: readProjects$1, writeProjects: writeProjects$1, readChain: readChain$1, readFile: readFile$1, writeFile: writeFile$1, pickDirectory, subscribeRefresh } = props;
	const aliveRef = (0, react.useRef)(true);
	(0, react.useEffect)(() => () => {
		aliveRef.current = false;
	}, []);
	const [projects, setProjects] = (0, react.useState)(null);
	const [loadError, setLoadError] = (0, react.useState)(null);
	const [open, setOpen] = (0, react.useState)(() => window.localStorage.getItem(OPEN_KEY) === "1");
	const [selectedDir, setSelectedDir] = (0, react.useState)(() => window.localStorage.getItem(SELECTED_KEY));
	const [chain, setChain] = (0, react.useState)(null);
	const [manualDir, setManualDir] = (0, react.useState)("");
	const [flash, setFlash] = (0, react.useState)(null);
	const [global_, setGlobal] = (0, react.useState)(null);
	const [editing, setEditing] = (0, react.useState)(null);
	const busyRef = (0, react.useRef)(false);
	const editingBusyRef = (0, react.useRef)(false);
	const pendingRefreshRef = (0, react.useRef)(false);
	const editingReqRef = (0, react.useRef)(0);
	const chainReqRef = (0, react.useRef)(0);
	const selectionRef = (0, react.useRef)({
		open: false,
		selectedDir: null
	});
	(0, react.useEffect)(() => {
		selectionRef.current = {
			open,
			selectedDir
		};
	}, [open, selectedDir]);
	const globalDraftRef = (0, react.useRef)("");
	const say = (kind, text) => {
		setFlash({
			kind,
			text
		});
	};
	const showFlash = (next) => {
		setFlash(next);
	};
	/**
	* AIE-BUDGET-003: the budget bar's chain view folds in the global file's
	* loader-relevant bytes, so whenever the global file may have changed on
	* disk (save, reload, external edit + re-read) the current chain view must
	* be re-read or the bar shows stale numbers. Reads the CURRENT selection
	* from the mirror — never the closure captured when the async operation
	* was issued — and loadChain's generation guard drops the response if the
	* user has since switched projects or collapsed the section.
	*/
	const refreshBudget = () => {
		const current = selectionRef.current;
		if (current.open && current.selectedDir !== null) loadChain(current.selectedDir);
	};
	const loadGlobal = async () => {
		try {
			const file = await readFile$1("global", void 0, "AGENTS.md");
			if (!aliveRef.current) return;
			globalDraftRef.current = file.content;
			setGlobal({
				displayPath: file.displayPath,
				exists: file.exists,
				content: file.content,
				draft: file.content,
				mtimeMs: file.exists && file.mtimeMs !== void 0 ? file.mtimeMs : null,
				bytes: file.bytes,
				conflict: false,
				readFailed: void 0,
				readErrorMessage: void 0
			});
			refreshBudget();
		} catch (error) {
			if (!aliveRef.current) return;
			const readState = classifyGlobalRead(error instanceof Error ? error.code : void 0);
			setGlobal({
				displayPath: "~/.dsh/AGENTS.md",
				exists: readState === "too-large",
				content: "",
				draft: "",
				mtimeMs: null,
				bytes: 0,
				conflict: false,
				readFailed: readState,
				readErrorMessage: String(error)
			});
		}
	};
	const loadProjects = async (keepSelection) => {
		try {
			const view = await readProjects$1();
			if (!aliveRef.current) return;
			setProjects(view);
			setLoadError(null);
			const usable = view.projects.filter((entry) => !entry.missing);
			if (!(keepSelection && selectedDir !== null && usable.some((entry) => (entry.realpath ?? entry.dir) === selectedDir))) {
				const first = usable[0]?.realpath ?? usable[0]?.dir ?? null;
				setSelectedDir(first);
				if (first !== null) window.localStorage.setItem(SELECTED_KEY, first);
				else window.localStorage.removeItem(SELECTED_KEY);
			}
		} catch (error) {
			if (aliveRef.current) setLoadError(String(error));
		}
	};
	/** A push that arrived while busy is re-run here instead of being lost. */
	const flushPendingRefresh = () => {
		if (!pendingRefreshRef.current) return;
		pendingRefreshRef.current = false;
		loadProjects(true);
	};
	const loadChain = async (dir) => {
		const request = ++chainReqRef.current;
		try {
			const view = await readChain$1(dir);
			const current = selectionRef.current;
			if (!chainResultMayLand({
				alive: aliveRef.current,
				requestIsNewest: responseIsCurrent(chainReqRef.current, request),
				open: current.open,
				selectedDir: current.selectedDir,
				requestedDir: dir
			})) return;
			setChain(view);
		} catch (error) {
			if (!aliveRef.current || !responseIsCurrent(chainReqRef.current, request)) return;
			say("error", String(error));
		}
	};
	(0, react.useEffect)(() => {
		loadProjects(false);
		loadGlobal();
		return subscribeRefresh(() => {
			if (busyRef.current || editingBusyRef.current) {
				pendingRefreshRef.current = true;
				return;
			}
			loadProjects(true);
		});
	}, []);
	(0, react.useEffect)(() => {
		if (open && selectedDir !== null) loadChain(selectedDir);
		else {
			++chainReqRef.current;
			setChain(null);
		}
	}, [open, selectedDir]);
	const toggleOpen = () => {
		setOpen((previous) => {
			window.localStorage.setItem(OPEN_KEY, previous ? "0" : "1");
			return !previous;
		});
	};
	const saveGlobal = async (force) => {
		if (global_ === null || busyRef.current) return;
		busyRef.current = true;
		try {
			let mtimeMs = global_.mtimeMs;
			if (force) {
				const fresh = await readFile$1("global", void 0, "AGENTS.md");
				mtimeMs = fresh.exists && fresh.mtimeMs !== void 0 ? fresh.mtimeMs : null;
			}
			const snapshot = global_.draft;
			const result = await writeFile$1({
				scope: "global",
				name: "AGENTS.md",
				content: snapshot,
				expectedMtimeMs: mtimeMs
			});
			if (!aliveRef.current) return;
			if (result.ok) {
				setGlobal((previous) => previous === null ? previous : {
					...mergeSaveSuccess(previous, snapshot, result),
					bytes: result.bytes
				});
				refreshBudget();
				showFlash({
					kind: "ok",
					text: globalDraftRef.current !== snapshot ? "已保存，但保存期间你又有新的输入尚未写入磁盘——请再次保存。" : "全局指令已保存。新会话保证生效；已开启的会话会在下一次文件操作后自动同步。"
				});
			} else if (result.conflict) setGlobal((previous) => previous === null ? previous : {
				...previous,
				conflict: true
			});
			else say("error", result.message ?? "保存失败");
		} finally {
			busyRef.current = false;
			flushPendingRefresh();
		}
	};
	const addProject = async (dir) => {
		if (projects === null || busyRef.current) return;
		const trimmed = dir.trim();
		if (trimmed === "" || !(trimmed.startsWith("\\") || trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed))) {
			say("error", "请提供绝对路径（如 E:\\path\\to\\project）。");
			return;
		}
		busyRef.current = true;
		try {
			const result = await writeProjects$1({
				op: "add",
				dir: trimmed
			}, projects.revision);
			if (!aliveRef.current) return;
			if (result.ok) {
				setProjects(result.view);
				setManualDir("");
				const added = result.view.projects.find((entry) => entry.source === "manual" && (entry.realpath ?? entry.dir).toLowerCase() === trimmed.toLowerCase());
				const target = added?.realpath ?? added?.dir;
				if (target !== void 0) {
					setSelectedDir(target);
					window.localStorage.setItem(SELECTED_KEY, target);
					setOpen(true);
					window.localStorage.setItem(OPEN_KEY, "1");
				}
				showFlash({
					kind: "ok",
					text: "项目已添加。"
				});
			} else if (result.conflict) {
				say("error", "项目列表已被其他窗口修改，请重试。");
				loadProjects(true);
			} else say("error", result.message ?? "添加失败");
		} finally {
			busyRef.current = false;
			flushPendingRefresh();
		}
	};
	const removeProject = async (id, label) => {
		if (projects === null || busyRef.current) return;
		if (!window.confirm(`从列表移除项目「${label}」？\n（只从编辑器列表移除，不会删除任何文件）`)) return;
		busyRef.current = true;
		try {
			const result = await writeProjects$1({
				op: "remove",
				id
			}, projects.revision);
			if (!aliveRef.current) return;
			if (result.ok) {
				setProjects(result.view);
				showFlash({
					kind: "ok",
					text: "已移除。"
				});
			} else if (result.conflict) {
				say("error", "项目列表已被其他窗口修改，请重试。");
				loadProjects(true);
			} else say("error", result.message ?? "移除失败");
		} finally {
			busyRef.current = false;
			flushPendingRefresh();
		}
	};
	const openEditor = async (dir, slot) => {
		if (editingBusyRef.current) return;
		const request = ++editingReqRef.current;
		try {
			const file = await readFile$1("project", dir, slot.name);
			if (!aliveRef.current || request !== editingReqRef.current) return;
			setEditing({
				dir,
				name: slot.name,
				displayPath: file.displayPath,
				exists: file.exists,
				content: file.content,
				draft: file.content,
				mtimeMs: file.exists && file.mtimeMs !== void 0 ? file.mtimeMs : null,
				conflict: false
			});
		} catch (error) {
			say("error", String(error));
		}
	};
	const saveEditing = async (force) => {
		if (editing === null || editingBusyRef.current) return;
		editingBusyRef.current = true;
		const savedTarget = {
			dir: editing.dir,
			name: editing.name
		};
		try {
			let mtimeMs = editing.mtimeMs;
			if (force) {
				const fresh = await readFile$1("project", editing.dir, editing.name);
				mtimeMs = fresh.exists && fresh.mtimeMs !== void 0 ? fresh.mtimeMs : null;
			}
			const snapshot = editing.draft;
			const result = await writeFile$1({
				scope: "project",
				dir: savedTarget.dir,
				name: savedTarget.name,
				content: snapshot,
				expectedMtimeMs: mtimeMs
			});
			if (!aliveRef.current) return;
			if (result.ok) {
				setEditing((previous) => {
					if (previous === null) return previous;
					if (previous.dir !== savedTarget.dir || previous.name !== savedTarget.name) return previous;
					return mergeSaveSuccess(previous, snapshot, result);
				});
				refreshBudget();
				showFlash({
					kind: "ok",
					text: `已保存 ${editing.displayPath}。新会话保证生效；已开启的会话会在下一次文件操作后自动同步。`
				});
			} else if (result.conflict) setEditing((previous) => {
				if (previous === null) return previous;
				if (previous.dir !== savedTarget.dir || previous.name !== savedTarget.name) return previous;
				return {
					...previous,
					conflict: true
				};
			});
			else say("error", result.message ?? "保存失败");
		} finally {
			editingBusyRef.current = false;
			flushPendingRefresh();
		}
	};
	const reloadEditing = async () => {
		if (editing === null || editingBusyRef.current) return;
		const requested = {
			dir: editing.dir,
			name: editing.name
		};
		const request = ++editingReqRef.current;
		try {
			const fresh = await readFile$1("project", requested.dir, requested.name);
			if (!aliveRef.current || request !== editingReqRef.current) return;
			setEditing((previous) => previous === null ? null : mergeFreshContent(previous, requested, {
				dir: previous.dir,
				name: previous.name
			}, fresh));
		} catch (error) {
			say("error", String(error));
		}
	};
	const totalBytes = chain?.totalBytes ?? 0;
	const budgetBytes = chain?.budgetBytes ?? projects?.budgetBytes ?? 65536;
	const ratio = budgetBytes > 0 ? totalBytes / budgetBytes : 0;
	const usableProjects = (projects?.projects ?? []).filter((entry) => !entry.missing);
	const selectedEntry = usableProjects.find((entry) => (entry.realpath ?? entry.dir) === selectedDir);
	const conflictBanner = (onReload, onOverwrite) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			...S.banner,
			display: "flex",
			alignItems: "center",
			gap: 8,
			flexWrap: "wrap"
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "文件已被外部修改。" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				style: S.button,
				onClick: onReload,
				children: "从磁盘重新加载（丢弃本地修改）"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				style: S.danger,
				onClick: onOverwrite,
				children: "用当前内容覆盖"
			})
		]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: S.root,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
				style: {
					...S.heading,
					display: "flex",
					alignItems: "center",
					gap: 8
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionIcon, { size: 18 }), "个性化指令"]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: S.sub,
				children: "编辑 DeepSeek Harness 的工作区指令文件（AGENTS.md 体系）。全局指令对所有项目生效，项目指令只作用于对应目录。 字节合计为源文件估算（已排除超 1 MiB 被加载器跳过的文件、同目录去重文件），与加载器渲染后上下文的实际预算占用不完全等价。"
			})] }),
			flash !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: flash.kind === "ok" ? S.ok : S.error,
				onClick: () => showFlash(null),
				role: "status",
				children: flash.text
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: S.card,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: S.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							style: { fontSize: 13 },
							children: "全局指令"
						}), global_ !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.path,
							children: global_.displayPath
						})]
					}),
					global_ === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: S.hint,
						children: "加载中…"
					}) : global_.readFailed === "too-large" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: S.hint,
						children: "⚠ 全局文件超过 1 MiB：加载器会整体跳过它（不计入预算），编辑器也不载入这么大的正文——请在本插件外编辑该文件。"
					}) : global_.readFailed === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: S.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: {
								...S.hint,
								margin: 0,
								flex: 1,
								minWidth: 0
							},
							children: ["全局文件读取失败：", global_.readErrorMessage]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: S.button,
							onClick: () => void loadGlobal(),
							children: "重试"
						})]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							style: S.textarea,
							value: global_.draft,
							spellCheck: false,
							onChange: (event) => {
								const draft = event.target.value;
								globalDraftRef.current = draft;
								setGlobal((previous) => previous === null ? previous : {
									...previous,
									draft
								});
							},
							placeholder: "## 全局偏好\n\n在这里写下希望所有会话遵守的约定，例如语言、代码风格、回复习惯……"
						}),
						global_.conflict && conflictBanner(() => void loadGlobal(), () => void saveGlobal(true)),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: S.row,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: S.path,
									children: [
										bytesOf(global_.draft),
										" 字节 / ",
										budgetBytes,
										" 预算"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: S.button,
									onClick: () => setGlobal((previous) => {
										if (previous === null) return previous;
										globalDraftRef.current = previous.content;
										return {
											...previous,
											draft: previous.content
										};
									}),
									disabled: global_.draft === global_.content,
									children: "还原"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: S.primary,
									onClick: () => void saveGlobal(false),
									disabled: busyRef.current || global_.draft === global_.content,
									children: "保存"
								})
							]
						})
					] }),
					chain?.global.overLimit === true && global_?.readFailed !== "too-large" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: S.hint,
						children: "⚠ 全局文件超过 1 MiB：加载器会整体跳过它（未计入下方预算）。"
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: S.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: S.row,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							style: {
								...S.button,
								border: "none",
								padding: "2px 4px"
							},
							onClick: toggleOpen,
							children: [open ? "▾" : "▸", " 项目指令"]
						}),
						projects !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: S.path,
							children: [
								usableProjects.length,
								" 个项目",
								chain !== null ? ` · 链上 ${formatBytes(totalBytes)} / ${formatBytes(budgetBytes)}` : ""
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
						chain !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								...S.barOuter,
								maxWidth: 220
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
								...S.barInner,
								width: `${Math.min(100, ratio * 100)}%`,
								background: byteColor(ratio)
							} })
						})
					]
				}), open && (projects === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: S.hint,
					children: loadError ?? "加载中…"
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: S.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: S.select,
								value: selectedDir ?? "",
								onChange: (event) => {
									const dir = event.target.value;
									setSelectedDir(dir === "" ? null : dir);
									++editingReqRef.current;
									setEditing(null);
									if (dir === "") window.localStorage.removeItem(SELECTED_KEY);
									else window.localStorage.setItem(SELECTED_KEY, dir);
								},
								children: [usableProjects.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "（暂无项目）"
								}), usableProjects.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: entry.realpath ?? entry.dir,
									children: [
										entry.label,
										"（",
										entry.source === "manual" ? "手动" : "自动",
										"）"
									]
								}, entry.id))]
							}),
							selectedEntry !== null && selectedEntry !== void 0 && selectedEntry.source === "manual" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: S.button,
								onClick: () => void removeProject(selectedEntry.id.slice(7), selectedEntry.label),
								children: "移除"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: S.button,
								onClick: () => {
									(async () => {
										const dir = await pickDirectory();
										if (dir !== null) addProject(dir);
										else say("error", "目录选择器不可用，请在下方粘贴路径。");
									})();
								},
								children: "选择目录…"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: S.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: S.input,
							value: manualDir,
							placeholder: "或粘贴项目绝对路径，如 E:\\path\\to\\project",
							onChange: (event) => setManualDir(event.target.value),
							onKeyDown: (event) => {
								if (event.key === "Enter" && manualDir.trim() !== "") addProject(manualDir);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: S.primary,
							disabled: manualDir.trim() === "" || busyRef.current,
							onClick: () => void addProject(manualDir),
							children: "添加"
						})]
					}),
					chain !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 6
						},
						children: chain.dirs.map((dir) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								borderTop: "1px solid rgba(128,128,128,0.2)",
								paddingTop: 6
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										...S.path,
										marginBottom: 4
									},
									children: dir.isRoot ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [dir.displayPath, "（项目根）"] }) : dir.displayPath
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: S.row,
									children: dir.slots.map((slot) => {
										const label = slot.dedupWith !== void 0 ? `⧉ ${slot.name}（同 ${slot.dedupWith}）` : `${slot.name}${slot.bytes !== void 0 ? ` · ${formatBytes(slot.bytes)}` : ""}${slot.overLimit ? " ⚠超限" : ""}`;
										if (slot.exists) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: S.chip,
											title: slot.overLimit ? "超过 1 MiB：加载器会整体跳过该文件，不计入预算" : slot.dedupWith !== void 0 ? "与同级文件内容一致，加载器已去重；编辑会破坏去重" : void 0,
											onClick: () => void openEditor(dir.absolutePath, slot),
											children: label
										}, slot.name);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											style: {
												...S.chip,
												...S.chipNew
											},
											title: `新建 ${slot.displayPath}`,
											onClick: () => void openEditor(dir.absolutePath, slot),
											children: ["+ ", slot.name]
										}, slot.name);
									})
								}),
								editing !== null && editing.dir === dir.absolutePath && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										marginTop: 8,
										display: "flex",
										flexDirection: "column",
										gap: 6
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: S.path,
											children: [editing.displayPath, editing.exists ? "" : "（新建）"]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
											style: {
												...S.textarea,
												minHeight: 140
											},
											value: editing.draft,
											spellCheck: false,
											onChange: (event) => {
												const draft = event.target.value;
												setEditing((previous) => previous === null ? previous : {
													...previous,
													draft
												});
											}
										}),
										editing.conflict && conflictBanner(() => void reloadEditing(), () => void saveEditing(true)),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: S.row,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: S.path,
													children: [bytesOf(editing.draft), " 字节"]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: S.button,
													onClick: () => {
														++editingReqRef.current;
														setEditing(null);
													},
													children: "关闭"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: S.button,
													onClick: () => setEditing((previous) => previous === null ? previous : {
														...previous,
														draft: previous.content
													}),
													disabled: editing.draft === editing.content,
													children: "还原"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: S.primary,
													onClick: () => void saveEditing(false),
													disabled: editingBusyRef.current || editing.draft === editing.content,
													children: "保存"
												})
											]
										})
									]
								})
							]
						}, dir.absolutePath))
					})
				] }))]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				style: S.hint,
				children: [
					"ⓘ 加载顺序：全局 → 项目根 → 子目录，越具体的越优先；同目录内容一致的文件只加载一份（⧉ 标记）；全部内容共享 ",
					formatBytes(budgetBytes),
					" 预算，超预算时较宽泛的文件先被省略。没有文件监视器：保存后新会话保证生效，已开启的会话由指令加载器在下一次文件操作后自动同步。"
				]
			})
		]
	});
}

//#endregion
//#region src/client/locales.ts
const zh = {
	title: "个性化指令",
	subtitle: "编辑 DeepSeek Harness 的工作区指令文件（AGENTS.md 体系）。",
	globalTitle: "全局指令",
	projectsTitle: "项目指令",
	save: "保存",
	saved: "已保存",
	revert: "还原",
	conflict: "文件已被外部修改",
	reloadFromDisk: "从磁盘重新加载",
	overwrite: "用当前内容覆盖",
	newSessionHint: "保存后新会话保证生效；已开启的会话会在下一次文件操作后自动同步。",
	rulesHint: "加载规则：全局 → 项目根 → 子目录，越具体的越优先；全部内容共享字节预算。"
};
const en = {
	title: "Personalization",
	subtitle: "Edit the DeepSeek Harness workspace instruction files (the AGENTS.md family).",
	globalTitle: "Global instructions",
	projectsTitle: "Project instructions",
	save: "Save",
	saved: "Saved",
	revert: "Revert",
	conflict: "File changed on disk",
	reloadFromDisk: "Reload from disk",
	overwrite: "Overwrite with my version",
	newSessionHint: "New sessions are guaranteed to pick this up; open sessions sync on their next file operation.",
	rulesHint: "Loading order: global → project root → subdirectories; more specific wins. Everything shares one byte budget."
};

//#endregion
//#region src/client/index.tsx
const NS = "agent-instructions-editor";
const API_BASE = "/agent-instructions/api";
/** The nav label this plugin registers — also the DOM hook for icon decoration. */
const NAV_LABELS = new Set(["个性化指令"]);
const ERROR_TEXT = {
	"not-ready": "插件服务尚未就绪，请稍后重试。",
	"readonly": "设置当前为只读，无法写入。",
	"content-type-json-required": "请求被拒绝：写入只接受 JSON。",
	"cross-origin-forbidden": "请求被拒绝：跨源写入。",
	"host-not-allowed": "请求被拒绝：目标主机不是本机回环地址。",
	"body-too-large": "请求体超过上限。",
	"bad-json": "请求体不是合法 JSON。",
	"invalid-name": "非法的文件名。",
	"invalid-target": "非法的目标。",
	"invalid-dir": "请提供项目的绝对路径。",
	"dir-missing": "目录不存在或无法访问。",
	"not-a-directory": "该路径不是目录。",
	"unknown-project": "未知项目。",
	"dir-not-editable": "该目录不在可编辑范围内。",
	"file-too-large": "文件超过 1 MiB 上限（加载器同样会跳过它）。",
	"revision-required": "缺少版本号，请刷新后重试。",
	"unknown-op": "未知操作。"
};
function errorText(body, fallback) {
	const message = body?.message;
	if (typeof message === "string" && message !== "") return message;
	const code = body?.error;
	if (code !== void 0 && ERROR_TEXT[code] !== void 0) return ERROR_TEXT[code];
	return fallback;
}
async function readProjects() {
	const response = await fetch(`${API_BASE}/projects`, { cache: "no-store" });
	const body = await response.json();
	if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) throw new Error(errorText(body, "项目列表不可用（插件未加载？）"));
	return body;
}
async function writeProjects(write, expectedRevision) {
	try {
		const response = await fetch(`${API_BASE}/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...write,
				expectedRevision
			}),
			cache: "no-store"
		});
		const body = await response.json();
		if (response.status === 409) return {
			ok: false,
			conflict: true
		};
		if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) return {
			ok: false,
			message: errorText(body, "操作失败")
		};
		return {
			ok: true,
			view: body
		};
	} catch (error) {
		return {
			ok: false,
			message: String(error)
		};
	}
}
async function readChain(dir) {
	const response = await fetch(`${API_BASE}/chain?dir=${encodeURIComponent(dir)}`, { cache: "no-store" });
	const body = await response.json();
	if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) throw new Error(errorText(body, "项目链不可用"));
	return body;
}
/** Fetch error carrying the API error code so callers can branch on it
* (e.g. the global editor's file-too-large state) instead of parsing text. */
var ApiError = class extends Error {
	code;
	status;
	constructor(code, status, message) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
	}
};
async function readFile(scope, dir, name) {
	const params = new URLSearchParams({
		scope,
		...dir !== void 0 ? { dir } : {},
		name
	});
	const response = await fetch(`${API_BASE}/file?${params.toString()}`, { cache: "no-store" });
	const body = await response.json();
	if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) {
		const payload = body;
		throw new ApiError(payload?.error ?? "unknown", response.status, errorText(payload, "文件不可读"));
	}
	return body;
}
async function writeFile(write) {
	try {
		const response = await fetch(`${API_BASE}/file`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(write),
			cache: "no-store"
		});
		const body = await response.json();
		if (response.status === 409) return {
			ok: false,
			conflict: true,
			exists: body?.exists
		};
		if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) return {
			ok: false,
			message: errorText(body, "保存失败")
		};
		const payload = body;
		return {
			ok: true,
			bytes: payload.bytes,
			mtimeMs: payload.mtimeMs
		};
	} catch (error) {
		return {
			ok: false,
			message: String(error)
		};
	}
}
const inject = [
	"slots",
	"locale",
	"remote"
];
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "agent-instructions-editor: dictionaries");
	const listeners = /* @__PURE__ */ new Set();
	const subscribeRefresh = (fn) => {
		listeners.add(fn);
		return () => {
			listeners.delete(fn);
		};
	};
	const refresh = () => {
		for (const fn of listeners) try {
			fn();
		} catch {}
	};
	ctx.effect(() => ctx.remote.$on("settings/document-updated", (ns) => {
		if (ns === NS) refresh();
	}), "agent-instructions-editor: settings invalidation");
	const pickDirectory = async () => {
		try {
			const result = await ctx.remote.directoryPicker.pick();
			return result.ok ? result.value : null;
		} catch {
			return null;
		}
	};
	ctx.effect(() => {
		const decorate = () => {
			if (document.querySelector("[role=\"dialog\"]") === null) return;
			for (const button of Array.from(document.querySelectorAll("button"))) {
				const label = button.querySelector(":scope > span");
				if (label === null || !NAV_LABELS.has(label.textContent ?? "")) continue;
				const existing = button.firstElementChild;
				if (existing instanceof SVGElement) {
					if (existing.dataset.navIcon === "1") continue;
					const template = document.createElement("template");
					template.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-nav-icon="1">${SECTION_ICON_INNER}</svg>`;
					existing.replaceWith(template.content.firstElementChild);
				}
			}
		};
		const observer = new MutationObserver(() => decorate());
		observer.observe(document.body, {
			childList: true,
			subtree: true
		});
		decorate();
		return () => observer.disconnect();
	}, "agent-instructions-editor: nav icon decoration");
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: NS,
		order: 42,
		label: () => "个性化指令",
		inject: () => ({
			readProjects,
			writeProjects,
			readChain,
			readFile,
			writeFile,
			pickDirectory,
			subscribeRefresh
		})
	}, InstructionsSection));
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map