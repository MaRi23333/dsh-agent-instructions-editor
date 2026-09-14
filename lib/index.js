import { promises, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import z from "@deepseek-ai/schemastery";

//#region src/chain.ts
const PROJECT_ROOT_MARKERS = [".git"];
const BASE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
const LOCAL_CANDIDATES = ["AGENTS.local.md", "CLAUDE.local.md"];
const USER_GLOBAL_FILE = "AGENTS.md";
/** Every file name the editor may ever read or write. */
const EDITABLE_NAMES = [...BASE_CANDIDATES, ...LOCAL_CANDIDATES];
/** dsh-base's budget for the rendered baseline message. */
const DEFAULT_MAX_BYTES = 65536;
/** The loader's per-source-file read cap; bigger files are skipped by the loader. */
const MAX_SOURCE_BYTES = 1048576;
/** Expand supported tilde prefixes against the OS home. */
function expandHomePath(target) {
	if (target === "~") return os.homedir();
	if (target.startsWith("~/") || target.startsWith("~\\")) return path.join(os.homedir(), target.slice(2));
	return target;
}
/**
* Resolve the harness home: explicit config, then a non-blank `$DSH_HOME`,
* then `~/.dsh`; expanded and resolved to an absolute normalized path.
*/
function resolveDshHome(configured, env = process.env) {
	const fromEnv = env.DSH_HOME;
	const chosen = configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : path.join(os.homedir(), ".dsh"));
	return path.resolve(expandHomePath(chosen));
}
/** `~/.dsh` for the default home, `$DSH_HOME` for anything else. */
function dshHomeDisplay(resolvedHome) {
	return path.resolve(resolvedHome) === path.resolve(path.join(os.homedir(), ".dsh")) ? "~/.dsh" : "$DSH_HOME";
}
/** Absolute path of the user-global instruction file. */
function userGlobalPath(configured, env = process.env) {
	return path.join(resolveDshHome(configured, env), USER_GLOBAL_FILE);
}
/** Display form of the user-global path, exactly as the loader renders it. */
function userGlobalDisplayPath(configured, env = process.env) {
	return `${dshHomeDisplay(resolveDshHome(configured, env))}/${USER_GLOBAL_FILE}`;
}
/**
* Comparison key for directory identity (dedup and "already seen" sets).
* Case-folded **only** on platforms whose default filesystem is
* case-insensitive; on case-sensitive filesystems `/repo/A` and `/repo/a`
* are distinct directories and must not collide. This key is for comparison
* only — it must never be used as an actual filesystem path (AIE-PATH-004).
*/
function dirKey(target, platform = process.platform) {
	const resolved = path.resolve(target);
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}
/**
* Bytes of the user-global file that the instruction loader would actually
* count toward its budget: sources over MAX_SOURCE_BYTES are skipped
* entirely, so an over-limit global contributes zero (AIE-BUDGET-003).
* The result is a source-file estimate for display — the loader's own
* budget applies to the rendered context and is not byte-identical.
*/
function countedGlobalBytes(global) {
	return global.exists && global.bytes <= MAX_SOURCE_BYTES ? global.bytes : 0;
}
/** True when the global file exists but the loader would skip it for size. */
function globalOverLimit(global) {
	return global.exists && global.bytes > MAX_SOURCE_BYTES;
}
function mergeSessionWorkspaces(previous, records, options) {
	const latest = /* @__PURE__ */ new Map();
	for (const record of records) {
		const cwd = record.cwd;
		if (typeof cwd !== "string" || cwd === "" || options.isNoise(cwd)) continue;
		const created = typeof record.createdAt === "number" ? record.createdAt : 0;
		const key = dirKey(cwd, options.platform);
		const known = latest.get(key);
		if (known === void 0 || created > known.created) latest.set(key, {
			dir: path.resolve(cwd),
			created
		});
	}
	const seen = new Set(previous.map((entry) => dirKey(entry.dir, options.platform)));
	const extra = [...latest.entries()].filter(([key]) => !seen.has(key)).sort((a, b) => b[1].created - a[1].created).slice(0, options.limit ?? 12).map(([, recent]) => ({ dir: recent.dir }));
	return [...previous, ...extra];
}
/** One settled tail promise per resolved target path. */
const writeQueues = /* @__PURE__ */ new Map();
/**
* Run `task` only after every previously enqueued task for `key` has
* settled. The returned promise propagates the task's result/rejection to
* the caller, while the stored tail never rejects (the chain must survive
* failures). Callers re-check their version fence inside the task, so two
* concurrent same-version writers serialize and the second one conflicts
* instead of silently clobbering the first.
*/
function enqueueWrite(key, task) {
	const run = (writeQueues.get(key) ?? Promise.resolve()).then(task, task);
	const tail = run.then(() => void 0, () => void 0);
	writeQueues.set(key, tail);
	tail.then(() => {
		if (writeQueues.get(key) === tail) writeQueues.delete(key);
	});
	return run;
}
/** Tri-state presence test mirroring the loader: present only when stat succeeds and isFile(). */
async function statFile(absolutePath) {
	try {
		const info = await promises.stat(absolutePath);
		return info.isFile() ? {
			size: info.size,
			mtimeMs: info.mtimeMs
		} : "absent";
	} catch (error) {
		const code = error.code;
		return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unavailable";
	}
}
async function existsAsMarker(absolutePath) {
	try {
		await promises.stat(absolutePath);
		return true;
	} catch {
		return false;
	}
}
/**
* Walk upward from `cwd` testing markers (any existing entry — a worktree
* `.git` file counts); stop only at the filesystem root. No marker ⇒ the
* cwd itself is the root, exactly like the loader.
*/
async function findProjectRoot(cwd, markers = PROJECT_ROOT_MARKERS) {
	let current = path.resolve(cwd);
	for (;;) {
		for (const marker of markers) if (await existsAsMarker(path.join(current, marker))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}
/** Inclusive ancestor chain `[root, …, cwd]`, broadest first. */
function ancestorChain(root, cwd) {
	const resolvedRoot = path.resolve(root);
	const chain = [];
	let current = path.resolve(cwd);
	while (current !== resolvedRoot) {
		chain.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	chain.push(resolvedRoot);
	return chain.reverse();
}
/** SHA-1 of content.trim(), the loader's dedup digest. */
function trimmedDigest(content) {
	return createHash("sha1").update(content.trim(), "utf8").digest("hex");
}
/**
* Probe every candidate in every chain directory (base list first, then
* overlays), then compute per-directory content dedup by reading existing
* files. Read failures leave `dedupWith` unset rather than lying.
*/
async function buildChain(workspaceDir, markers = PROJECT_ROOT_MARKERS) {
	const resolvedWorkspace = path.resolve(workspaceDir);
	const root = await findProjectRoot(resolvedWorkspace, markers);
	const dirs = [];
	for (const dir of ancestorChain(root, resolvedWorkspace)) {
		const relative = path.relative(root, dir);
		const chainDir = {
			absolutePath: dir,
			displayPath: relative === "" ? "." : relative,
			isRoot: dir === root,
			slots: []
		};
		for (const [kind, candidates] of [["base", BASE_CANDIDATES], ["overlay", LOCAL_CANDIDATES]]) for (const name$1 of candidates) {
			const absolutePath = path.join(dir, name$1);
			const stat = await statFile(absolutePath);
			chainDir.slots.push({
				name: name$1,
				kind,
				absolutePath,
				displayPath: path.relative(root, absolutePath),
				exists: stat !== "absent" && stat !== "unavailable",
				...typeof stat === "object" ? {
					bytes: stat.size,
					mtimeMs: stat.mtimeMs,
					...stat.size > MAX_SOURCE_BYTES ? { overLimit: true } : {}
				} : {}
			});
		}
		dirs.push(chainDir);
	}
	for (const dir of dirs) {
		const seen = /* @__PURE__ */ new Map();
		for (const slot of dir.slots) {
			if (!slot.exists || slot.bytes === void 0 || slot.overLimit) continue;
			let content;
			try {
				content = await promises.readFile(slot.absolutePath, "utf8");
			} catch {
				slot.readFailed = true;
				continue;
			}
			const digest = trimmedDigest(content);
			const winner = seen.get(digest);
			if (winner !== void 0) slot.dedupWith = winner;
			else seen.set(digest, slot.displayPath);
		}
	}
	let totalBytes = 0;
	for (const dir of dirs) for (const slot of dir.slots) if (slot.exists && slot.dedupWith === void 0 && !slot.overLimit && !slot.readFailed && slot.bytes !== void 0) totalBytes += slot.bytes;
	return {
		root,
		workspaceDir: resolvedWorkspace,
		dirs,
		totalBytes
	};
}

//#endregion
//#region src/index.ts
const name = "agent-instructions-editor";
const inject = [];
const Config = z.object({ manualProjects: z.dict(z.string()).default({}) });
const NS = "agent-instructions-editor";
const API_BASE = "/agent-instructions/api";
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
/** JSON body cap — 4 MiB: a ≤1 MiB instruction file with newline-heavy JSON escaping stays well inside it. */
const MAX_BODY_BYTES = 4 << 20;
const sendJson = (res, status, value) => {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
};
const readJsonBody = async (req) => {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) return {
			ok: false,
			error: "too-large"
		};
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {
		ok: true,
		body: {}
	};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? {
			ok: true,
			body: parsed
		} : {
			ok: false,
			error: "bad-json"
		};
	} catch {
		return {
			ok: false,
			error: "bad-json"
		};
	}
};
/**
* Host-header allowlist — the anti-DNS-rebinding defense for these routes.
* A rebound attacker domain resolves to 127.0.0.1 but keeps its own name in
* the Host header; only loopback literals/localhost may pass, on any port.
*/
const HOSTNAME_LOOPBACK = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/;
const guardHost = (req, res) => {
	const hostHeader = req.headers.host;
	if (hostHeader === void 0) {
		sendJson(res, 403, {
			ok: false,
			error: "host-not-allowed"
		});
		return false;
	}
	const host = hostHeader.trim().toLowerCase();
	const colon = host.lastIndexOf(":");
	const hostname = colon === -1 ? host : host.slice(0, colon);
	if (!HOSTNAME_LOOPBACK.test(hostname)) {
		sendJson(res, 403, {
			ok: false,
			error: "host-not-allowed"
		});
		return false;
	}
	return true;
};
const guardWrite = (req, res) => {
	if ((req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json") {
		sendJson(res, 415, {
			ok: false,
			error: "content-type-json-required"
		});
		return false;
	}
	const origin = req.headers.origin;
	if (origin !== void 0) {
		let originHost = "";
		try {
			originHost = new URL(origin).host;
		} catch {
			originHost = "";
		}
		const hostHeader = req.headers.host ?? "";
		if (originHost === "" || originHost !== hostHeader) {
			sendJson(res, 403, {
				ok: false,
				error: "cross-origin-forbidden"
			});
			return false;
		}
	}
	return true;
};
let sessionWorkspaceSource = async () => [];
/** Directories never worth listing as projects. */
function isNoiseDir(dir) {
	const resolved = path.resolve(dir);
	if (path.dirname(resolved) === resolved) return true;
	const home = resolveDshHome();
	if (resolved === home || resolved === path.dirname(home)) return true;
	return resolved === path.resolve(os.homedir()) || resolved === os.tmpdir();
}
async function recentSessionWorkspaces() {
	return (await sessionWorkspaceSource()).filter((entry) => !isNoiseDir(entry.dir));
}
async function safeRealpath(target) {
	try {
		return await promises.realpath(target);
	} catch {
		return null;
	}
}
function labelFor(dir) {
	const base = path.basename(dir);
	return base === "" ? dir : base;
}
function apply(ctx, config) {
	let settingsService;
	let settingsFailure;
	ctx.inject(["settings"], (sctx) => {
		settingsService = sctx.settings;
		settingsFailure = void 0;
		try {
			const scope = sctx.settings.register(NS, Config, { base: config });
			sctx.effect(() => () => {}, "agent-instructions-editor: settings scope");
			scope.watch(() => {});
		} catch (error) {
			settingsFailure = `agent-instructions-editor 设置段注册失败：${String(error)}`;
		}
	});
	let registryWired = false;
	let sessionQueryWired = false;
	ctx.inject(["workspaceRegistry"], (wctx) => {
		if (registryWired) return;
		registryWired = true;
		wctx.effect(() => () => {
			registryWired = false;
		}, "agent-instructions-editor: registry source lifetime");
		const registrySource = sessionWorkspaceSource;
		sessionWorkspaceSource = async () => {
			const fromRegistry = await registrySource();
			try {
				return [...fromRegistry, ...wctx.workspaceRegistry.list().map((workspace) => ({
					dir: workspace.path,
					label: workspace.title
				}))];
			} catch {
				return fromRegistry;
			}
		};
	});
	ctx.inject(["sessionQuery"], (qctx) => {
		if (sessionQueryWired) return;
		sessionQueryWired = true;
		qctx.effect(() => () => {
			sessionQueryWired = false;
		}, "agent-instructions-editor: session-query source lifetime");
		const previousSource = sessionWorkspaceSource;
		sessionWorkspaceSource = async () => {
			const fromPrevious = await previousSource();
			try {
				return mergeSessionWorkspaces(fromPrevious, (await qctx.sessionQuery.listSessions()).map((record) => ({
					cwd: record.header.cwd,
					createdAt: record.header.createdAt
				})), { isNoise: isNoiseDir });
			} catch {
				return fromPrevious;
			}
		};
	});
	const manualProjects = () => {
		const svc = settingsService;
		if (svc === void 0) return {};
		const descriptor = svc.describe().find((candidate) => candidate.ns === NS);
		if (descriptor === void 0) return {};
		const raw = (descriptor.user ?? descriptor.value)?.manualProjects;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		const out = {};
		for (const [id, dir] of Object.entries(raw)) if (PROJECT_ID.test(id) && typeof dir === "string" && dir !== "") out[id] = dir;
		return out;
	};
	const currentRevision = () => {
		const svc = settingsService;
		if (svc === void 0) return void 0;
		return svc.describe().find((candidate) => candidate.ns === NS)?.revision;
	};
	const registeredProjects = async () => {
		const entries = [];
		for (const { dir, label } of await recentSessionWorkspaces()) {
			if (typeof dir !== "string" || dir === "") continue;
			entries.push({
				id: `session:${dir}`,
				dir,
				realpath: null,
				label: label ?? labelFor(dir),
				source: "session"
			});
		}
		for (const [id, dir] of Object.entries(manualProjects())) entries.push({
			id: `manual:${id}`,
			dir,
			realpath: null,
			label: labelFor(dir),
			source: "manual"
		});
		const byKey = /* @__PURE__ */ new Map();
		for (const entry of entries) {
			const real = await safeRealpath(entry.dir);
			if (real === null) {
				const key$1 = `missing:${dirKey(entry.dir)}`;
				if (!byKey.has(key$1)) byKey.set(key$1, entry);
				continue;
			}
			entry.realpath = real;
			const key = dirKey(real);
			const existing = byKey.get(key);
			if (existing === void 0 || existing.source !== "manual" && entry.source === "manual") byKey.set(key, entry);
		}
		return [...byKey.values()];
	};
	/** Global file facts + project registry with realpaths resolved lazily. */
	const projectsView = async () => {
		const globalPath = userGlobalPath();
		const globalStat = await statFile(globalPath);
		const entries = [];
		for (const entry of await registeredProjects()) entries.push({
			...entry,
			...entry.realpath === null ? { missing: true } : {}
		});
		return {
			writable: settingsService?.writable ?? false,
			revision: currentRevision(),
			home: dshHomeDisplay(resolveDshHome()),
			budgetBytes: DEFAULT_MAX_BYTES,
			global: {
				absolutePath: globalPath,
				displayPath: userGlobalDisplayPath(),
				exists: globalStat !== "absent" && globalStat !== "unavailable",
				...typeof globalStat === "object" ? {
					bytes: globalStat.size,
					mtimeMs: globalStat.mtimeMs
				} : {}
			},
			projects: entries
		};
	};
	/**
	* Every directory the editor may touch: for each registered workspace, the
	* loader's own root→workspace chain, realpathed. Returns the owning project
	* root too, because the loader renders display paths relative to it.
	*/
	const editableChainDirs = async () => {
		const dirs = /* @__PURE__ */ new Set();
		const rootsByDir = /* @__PURE__ */ new Map();
		for (const entry of await registeredProjects()) {
			const realWorkspace = entry.realpath ?? await safeRealpath(entry.dir);
			if (realWorkspace === null) continue;
			const root = await findProjectRoot(realWorkspace);
			for (const dir of ancestorChain(root, realWorkspace)) {
				const real = await safeRealpath(dir);
				if (real === null) continue;
				if (!rootsByDir.has(real)) rootsByDir.set(real, root);
				dirs.add(real);
			}
		}
		return {
			dirs,
			rootsByDir
		};
	};
	/** Whitelist + realpath containment — the whole write-path security model. */
	const resolveTarget = async (scope, dir, name$1) => {
		if (typeof name$1 !== "string" || !EDITABLE_NAMES.includes(name$1)) return { error: "invalid-name" };
		if (name$1.includes("/") || name$1.includes("\\") || name$1.includes("..")) return { error: "invalid-name" };
		if (scope === "global") {
			if (dir !== void 0 || name$1 !== USER_GLOBAL_FILE) return { error: "invalid-target" };
			return {
				absolutePath: userGlobalPath(),
				displayPath: userGlobalDisplayPath()
			};
		}
		if (scope !== "project" || typeof dir !== "string" || dir === "") return { error: "invalid-target" };
		const real = await safeRealpath(dir);
		if (real === null) return { error: "unknown-project" };
		const { dirs, rootsByDir } = await editableChainDirs();
		const root = dirs.has(real) ? rootsByDir.get(real) : void 0;
		if (root === void 0) return { error: "dir-not-editable" };
		return {
			absolutePath: path.join(real, name$1),
			displayPath: path.relative(root, path.join(real, name$1))
		};
	};
	const readFile = async (target) => {
		const stat = await statFile(target.absolutePath);
		if (stat === "unavailable") return {
			status: 503,
			payload: {
				ok: false,
				error: "stat-failed"
			}
		};
		if (stat === "absent") return {
			status: 200,
			payload: {
				ok: true,
				exists: false,
				...target,
				content: "",
				bytes: 0
			}
		};
		if (stat.size > MAX_SOURCE_BYTES) return {
			status: 400,
			payload: {
				ok: false,
				error: "file-too-large",
				message: `文件超过 ${MAX_SOURCE_BYTES} 字节上限（加载器也会跳过它），请在编辑器外处理。`
			}
		};
		let content;
		try {
			content = await promises.readFile(target.absolutePath, "utf8");
		} catch {
			return {
				status: 503,
				payload: {
					ok: false,
					error: "read-failed"
				}
			};
		}
		return {
			status: 200,
			payload: {
				ok: true,
				exists: true,
				...target,
				content,
				bytes: stat.size,
				mtimeMs: stat.mtimeMs
			}
		};
	};
	const atomicWrite = async (targetPath, content) => {
		const dir = path.dirname(targetPath);
		await promises.mkdir(dir, { recursive: true });
		try {
			const now = Date.now();
			const prefix = `.${path.basename(targetPath)}.tmp-`;
			for (const name$1 of await promises.readdir(dir)) {
				if (!name$1.startsWith(prefix)) continue;
				const stalePath = path.join(dir, name$1);
				const info = await promises.stat(stalePath).catch(() => null);
				if (info !== null && now - info.mtimeMs > 6e4) await promises.rm(stalePath, { force: true }).catch(() => {});
			}
		} catch {}
		const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
		try {
			await promises.writeFile(tmp, content, "utf8");
			try {
				await promises.rename(tmp, targetPath);
			} catch (error) {
				if (error.code !== "EPERM") throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
				await promises.rename(tmp, targetPath);
			}
		} catch (error) {
			await promises.rm(tmp, { force: true }).catch(() => {});
			throw error;
		}
		const stat = await statFile(targetPath);
		if (typeof stat !== "object") throw new Error("写入后校验失败");
		return {
			bytes: stat.size,
			mtimeMs: stat.mtimeMs
		};
	};
	ctx.inject(["webServer"], (wctx) => {
		const web = wctx.webServer;
		wctx.effect(() => web.register({
			kind: "exact",
			path: `${API_BASE}/projects`,
			handler: async (req, res) => {
				if (!guardHost(req, res)) return;
				if (req.method === "GET") {
					if (settingsFailure !== void 0) {
						sendJson(res, 503, {
							ok: false,
							error: "not-ready",
							message: settingsFailure
						});
						return;
					}
					sendJson(res, 200, {
						ok: true,
						...await projectsView()
					});
					return;
				}
				if (req.method !== "POST") {
					sendJson(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					return;
				}
				if (!guardWrite(req, res)) return;
				const read = await readJsonBody(req);
				if (!read.ok) {
					if (read.error === "too-large") sendJson(res, 413, {
						ok: false,
						error: "body-too-large"
					});
					else sendJson(res, 400, {
						ok: false,
						error: "bad-json"
					});
					return;
				}
				const svc = settingsService;
				if (settingsFailure !== void 0 || svc === void 0) {
					sendJson(res, 503, {
						ok: false,
						error: "not-ready",
						message: settingsFailure
					});
					return;
				}
				if (!svc.writable) {
					sendJson(res, 403, {
						ok: false,
						error: "readonly"
					});
					return;
				}
				const body = read.body;
				const op = body.op;
				if (typeof body.expectedRevision !== "number") {
					sendJson(res, 400, {
						ok: false,
						error: "revision-required"
					});
					return;
				}
				const expectedRevision = body.expectedRevision;
				let candidate;
				try {
					const current = manualProjects();
					if (op === "add") {
						const dir = typeof body.dir === "string" ? body.dir.trim() : "";
						if (dir === "" || !path.isAbsolute(dir)) {
							sendJson(res, 400, {
								ok: false,
								error: "invalid-dir",
								message: "请提供项目的绝对路径。"
							});
							return;
						}
						const real = await safeRealpath(dir);
						if (real === null) {
							sendJson(res, 400, {
								ok: false,
								error: "dir-missing",
								message: "目录不存在或无法访问。"
							});
							return;
						}
						if (!(await promises.stat(real)).isDirectory()) {
							sendJson(res, 400, {
								ok: false,
								error: "not-a-directory"
							});
							return;
						}
						if (Object.values(current).some((known) => safeRealpathSync(known) === real)) {
							sendJson(res, 200, {
								ok: true,
								...await projectsView()
							});
							return;
						}
						const base = labelFor(real).replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 24) || "project";
						let id = `${base}-${randomBytes(2).toString("hex")}`;
						while (Object.hasOwn(current, id)) id = `${base}-${randomBytes(2).toString("hex")}`;
						candidate = {
							...current,
							[id]: real
						};
					} else if (op === "remove") {
						const id = typeof body.id === "string" ? body.id : "";
						if (!PROJECT_ID.test(id) || !Object.hasOwn(current, id)) {
							sendJson(res, 400, {
								ok: false,
								error: "unknown-project"
							});
							return;
						}
						candidate = { ...current };
						delete candidate[id];
					} else {
						sendJson(res, 400, {
							ok: false,
							error: "unknown-op"
						});
						return;
					}
					const userSection = svc.describe().find((row) => row.ns === NS)?.user ?? {};
					await svc.replace(NS, {
						...userSection,
						manualProjects: candidate
					}, expectedRevision);
					sendJson(res, 200, {
						ok: true,
						...await projectsView()
					});
				} catch (error) {
					console.error("[agent-instructions-editor] projects write failed:", error);
					if (error.code === "SETTINGS_CONFLICT") sendJson(res, 409, {
						ok: false,
						error: "conflict"
					});
					else sendJson(res, 400, {
						ok: false,
						error: "rejected"
					});
				}
			}
		}), "agent-instructions-editor: projects route");
		wctx.effect(() => web.register({
			kind: "exact",
			path: `${API_BASE}/chain`,
			handler: async (req, res) => {
				if (!guardHost(req, res)) return;
				if (req.method !== "GET") {
					sendJson(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					return;
				}
				const dir = new URL(req.url ?? "/", "http://localhost").searchParams.get("dir") ?? "";
				const real = dir === "" ? null : await safeRealpath(dir);
				if (real === null) {
					sendJson(res, 400, {
						ok: false,
						error: "unknown-project",
						message: "目录不存在或无法访问。"
					});
					return;
				}
				const { dirs } = await editableChainDirs();
				if (!dirs.has(real)) {
					sendJson(res, 403, {
						ok: false,
						error: "dir-not-editable"
					});
					return;
				}
				const view = await buildChain(real);
				const globalStat = await statFile(userGlobalPath());
				const globalInfo = {
					exists: globalStat !== "absent" && globalStat !== "unavailable",
					bytes: typeof globalStat === "object" ? globalStat.size : 0
				};
				sendJson(res, 200, {
					ok: true,
					...view,
					global: {
						...globalInfo,
						overLimit: globalOverLimit(globalInfo)
					},
					totalBytes: view.totalBytes + countedGlobalBytes(globalInfo),
					budgetBytes: DEFAULT_MAX_BYTES
				});
			}
		}), "agent-instructions-editor: chain route");
		wctx.effect(() => web.register({
			kind: "exact",
			path: `${API_BASE}/file`,
			handler: async (req, res) => {
				if (!guardHost(req, res)) return;
				if (req.method === "GET") {
					const query = new URL(req.url ?? "/", "http://localhost").searchParams;
					const target$1 = await resolveTarget(query.get("scope") ?? void 0, query.get("dir") ?? void 0, query.get("name"));
					if ("error" in target$1) {
						sendJson(res, target$1.error === "invalid-name" || target$1.error === "invalid-target" ? 400 : 403, {
							ok: false,
							error: target$1.error,
							message: target$1.message
						});
						return;
					}
					const result = await readFile(target$1);
					sendJson(res, result.status, result.payload);
					return;
				}
				if (req.method !== "POST") {
					sendJson(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					return;
				}
				if (!guardWrite(req, res)) return;
				const read = await readJsonBody(req);
				if (!read.ok) {
					if (read.error === "too-large") sendJson(res, 413, {
						ok: false,
						error: "body-too-large"
					});
					else sendJson(res, 400, {
						ok: false,
						error: "bad-json"
					});
					return;
				}
				const body = read.body;
				const content = body.content;
				if (typeof content !== "string") {
					sendJson(res, 400, {
						ok: false,
						error: "content-required"
					});
					return;
				}
				if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) {
					sendJson(res, 413, {
						ok: false,
						error: "file-too-large",
						message: `内容超过 ${MAX_SOURCE_BYTES} 字节上限。`
					});
					return;
				}
				const target = await resolveTarget(body.scope, body.dir, body.name);
				if ("error" in target) {
					sendJson(res, target.error === "invalid-name" || target.error === "invalid-target" ? 400 : 403, {
						ok: false,
						error: target.error,
						message: target.message
					});
					return;
				}
				try {
					const written = await enqueueWrite(target.absolutePath, async () => {
						const stat = await statFile(target.absolutePath);
						if (stat === "unavailable") return {
							status: 503,
							payload: {
								ok: false,
								error: "stat-failed"
							}
						};
						const expectedMtimeMs = body.expectedMtimeMs;
						if (typeof stat === "object") {
							if (typeof expectedMtimeMs !== "number" || Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) return {
								status: 409,
								payload: {
									ok: false,
									error: "conflict",
									exists: true,
									bytes: stat.size,
									mtimeMs: stat.mtimeMs
								}
							};
						} else if (expectedMtimeMs !== null && expectedMtimeMs !== void 0) return {
							status: 409,
							payload: {
								ok: false,
								error: "conflict",
								exists: false
							}
						};
						const written$1 = await atomicWrite(target.absolutePath, content);
						return {
							status: 200,
							payload: {
								ok: true,
								...target,
								...written$1
							}
						};
					});
					sendJson(res, written.status, written.payload);
				} catch (error) {
					console.error("[agent-instructions-editor] file write failed:", error);
					sendJson(res, 500, {
						ok: false,
						error: "write-failed"
					});
				}
			}
		}), "agent-instructions-editor: file route");
	});
}
/** Best-effort synchronous realpath for duplicate detection; falls back to the raw path. */
function safeRealpathSync(target) {
	try {
		return realpathSync(target);
	} catch {
		return target;
	}
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=index.js.map