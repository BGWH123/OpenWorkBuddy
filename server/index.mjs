import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExperts, loadSkills, writeExpert, writeSkill } from "./catalog.mjs";
import { exportTaskMarkdown, listLibrary, openInExplorer, saveLibraryNote, taskNotices } from "./desk.mjs";
import { answerTool, confirmTask, createTaskRecord, enqueueMessage, launchTask, publicTask } from "./runner.mjs";
import { createStore, findTask } from "./store.mjs";
import { runInWorkspace } from "./agent.mjs";
import { decodeBuffer } from "./text.mjs";
import { setExtraRoots } from "./workspace.mjs";
import { buildTree, ensureWorkspace, fileMtime, importFile, listFiles, makeDir, moveEntry, readText, removeEntry, resolveInside, saveText, saveUpload, toRelative } from "./workspace.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createServer(options = {}) {
  const dataDir = options.dataDir || path.join(appRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const store = createStore(options.storePath || path.join(dataDir, "state.json"));
  setExtraRoots(ensureWorkcode(store));

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      try {
        const result = await route(req, url, store, options);
        if (result?.raw) {
          sendJson(res, result.status || 200, result);
          return;
        }
        sendJson(res, result.status || 200, result.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "服务器错误";
        const known = /文件夹|工作区|路径|文件不存在|超出|请先|请提供|没有这个接口|请求/.test(message);
        const status = Number(error.status) || (known ? 400 : 500);
        sendJson(res, status, { error: message });
      }
      return;
    }
    serveStatic(url.pathname, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : "服务器错误" });
    });
  });
  return { server, store };
}

async function route(req, url, store, options) {
  if (req.method === "GET" && url.pathname === "/api/health") return { body: { ok: true } };
  if (req.method === "GET" && url.pathname === "/api/state") return { body: publicState(store.snapshot()) };
  if (req.method === "POST" && url.pathname === "/api/workspace") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.path);
    const state = await store.update((draft) => {
      draft.currentWorkspace = workspace;
      draft.recentWorkspaces = [workspace, ...draft.recentWorkspaces.filter((item) => item !== workspace)].slice(0, 8);
      return draft;
    });
    return { body: publicState(state) };
  }
  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readBody(req);
    const state = await store.update((draft) => {
      if (body.provider === "local" || body.provider === "openai") draft.settings.provider = body.provider;
      if (typeof body.baseUrl === "string" && body.baseUrl.trim()) draft.settings.baseUrl = body.baseUrl.trim();
      if (typeof body.model === "string" && body.model.trim()) draft.settings.model = body.model.trim();
      if (Array.isArray(body.extraDirectories)) {
        draft.settings.extraDirectories = body.extraDirectories.map((item) => String(item).trim()).filter(Boolean);
      }
      if (typeof body.apiKey === "string") draft.settings.apiKey = body.apiKey.trim();
      return draft;
    });
    return { body: publicState(state) };
  }
  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readBody(req);
    const text = String(body.text || "").trim();
    if (!text) throw httpError(400, "请先写任务内容");
    const current = store.snapshot();
    const workspace = ensureWorkspace(body.workspace || current.currentWorkspace);
    const task = createTaskRecord({
      workspace,
      text,
      mode: body.mode,
      expertId: body.expertId || "",
      skillId: body.skillId || "",
    });
    await store.update((draft) => {
      draft.currentWorkspace = workspace;
      draft.recentWorkspaces = [workspace, ...draft.recentWorkspaces.filter((item) => item !== workspace)].slice(0, 8);
      draft.tasks.unshift(task);
      return draft;
    });
    await enqueueMessage(store, task.id, {
      text,
      mode: body.mode,
      expertId: body.expertId || "",
      skillId: body.skillId || "",
      attachments: body.attachments,
    });
    launchTask(store, task.id, { fetchImpl: options.fetchImpl });
    return { body: publicTask(findTask(store.snapshot(), task.id)) };
  }
  const messageRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/messages$/);
  if (req.method === "POST" && messageRoute) {
    const body = await readBody(req);
    await enqueueMessage(store, decodeURIComponent(messageRoute[1]), body);
    launchTask(store, decodeURIComponent(messageRoute[1]), { fetchImpl: options.fetchImpl });
    return { body: publicTask(findTask(store.snapshot(), decodeURIComponent(messageRoute[1]))) };
  }
  const confirmRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/confirm$/);
  if (req.method === "POST" && confirmRoute) {
    const id = decodeURIComponent(confirmRoute[1]);
    await confirmTask(store, id);
    launchTask(store, id, { fetchImpl: options.fetchImpl });
    return { body: publicTask(findTask(store.snapshot(), id)) };
  }
  const toolRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/tool$/);
  if (req.method === "POST" && toolRoute) {
    const body = await readBody(req);
    const task = await answerTool(store, decodeURIComponent(toolRoute[1]), {
      decision: body.decision,
      answer: body.answer,
    }, { fetchImpl: options.fetchImpl });
    return { body: publicTask(task) };
  }
  const taskRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskRoute && req.method === "POST") {
    const id = decodeURIComponent(taskRoute[1]);
    const body = await readBody(req);
    const state = await store.update((draft) => {
      const task = findTask(draft, id);
      if (!task) throw httpError(404, "找不到这个任务");
      if (task.status === "running") throw httpError(409, "这个任务还在执行");
      if (body.status === "done") task.status = "done";
      task.updatedAt = Date.now();
      return draft;
    });
    return { body: publicTask(findTask(state, id)) };
  }
  if (taskRoute && req.method === "DELETE") {
    const id = decodeURIComponent(taskRoute[1]);
    await store.update((draft) => {
      const task = findTask(draft, id);
      if (!task) throw httpError(404, "找不到这个任务");
      if (task.status === "running") throw httpError(409, "这个任务还在执行");
      draft.tasks = draft.tasks.filter((item) => item.id !== id);
      return draft;
    });
    return { body: { ok: true } };
  }
  if (req.method === "GET" && url.pathname === "/api/tree") {
    const workspace = ensureWorkspace(url.searchParams.get("workspace") || store.snapshot().currentWorkspace);
    return { body: { items: listFiles(workspace), tree: buildTree(workspace) } };
  }
  if (req.method === "POST" && url.pathname === "/api/upload") {
    const workspace = ensureWorkspace(url.searchParams.get("workspace") || store.snapshot().currentWorkspace);
    const data = await readRaw(req, 8_000_000);
    const nested = url.searchParams.get("path") || "";
    if (!data.length && !nested) throw httpError(400, "没有收到文件内容");
    return { body: { path: saveUpload(workspace, url.searchParams.get("name") || "附件", data, nested) } };
  }
  if (req.method === "POST" && url.pathname === "/api/file") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.workspace || store.snapshot().currentWorkspace);
    const saved = saveText(workspace, body.path, body.content ?? "", body.mtimeMs);
    return { body: { path: saved.path, action: saved.action, mtimeMs: saved.mtimeMs } };
  }
  if (req.method === "DELETE" && url.pathname === "/api/file") {
    const workspace = ensureWorkspace(url.searchParams.get("workspace") || store.snapshot().currentWorkspace);
    removeEntry(workspace, url.searchParams.get("path") || "");
    return { body: { ok: true } };
  }
  if (req.method === "POST" && url.pathname === "/api/mkdir") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.workspace || store.snapshot().currentWorkspace);
    return { body: { path: makeDir(workspace, body.path) } };
  }
  if (req.method === "POST" && url.pathname === "/api/move") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.workspace || store.snapshot().currentWorkspace);
    return { body: { path: moveEntry(workspace, body.from, body.to) } };
  }
  if (req.method === "POST" && url.pathname === "/api/terminal") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.workspace || store.snapshot().currentWorkspace);
    try {
      const result = await runInWorkspace(body.command, workspace);
      return { body: result };
    } catch (error) {
      throw httpError(400, error instanceof Error ? error.message : "命令不能执行");
    }
  }
  if (req.method === "GET" && url.pathname === "/api/file") {
    const workspace = ensureWorkspace(url.searchParams.get("workspace"));
    const relative = url.searchParams.get("path") || "";
    return { body: describeFile(workspace, relative) };
  }
  if (req.method === "GET" && url.pathname === "/api/raw") {
    const workspace = ensureWorkspace(url.searchParams.get("workspace"));
    const relative = url.searchParams.get("path") || "";
    const target = resolveInside(workspace, relative);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw httpError(404, "文件不存在");
    return { raw: fs.readFileSync(target), type: contentType(target) };
  }
  if (req.method === "POST" && url.pathname === "/api/explore") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.workspace || store.snapshot().currentWorkspace);
    return { body: openInExplorer(workspace, body.path || ".") };
  }
  if (req.method === "POST" && url.pathname === "/api/library") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.workspace || store.snapshot().currentWorkspace);
    return { body: { path: saveLibraryNote(workspace, body.name, body.content ?? "") } };
  }
  if (req.method === "POST" && url.pathname === "/api/share") {
    const body = await readBody(req);
    const task = findTask(store.snapshot(), body.taskId);
    if (!task) throw httpError(404, "找不到这个任务");
    return { body: { path: exportTaskMarkdown(task.workspace, task) } };
  }
  if (req.method === "POST" && url.pathname === "/api/experts") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.workspace || store.snapshot().currentWorkspace);
    const id = writeExpert(workspace, body);
    return { body: { id } };
  }
  if (req.method === "POST" && url.pathname === "/api/skills") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.workspace || store.snapshot().currentWorkspace);
    const id = writeSkill(workspace, body);
    return { body: { id } };
  }
  if (req.method === "POST" && url.pathname === "/api/import") {
    const body = await readBody(req);
    const workspace = ensureWorkspace(body.workspace || store.snapshot().currentWorkspace);
    return { body: { path: importFile(workspace, body.sourcePath) } };
  }
  throw httpError(404, "没有这个接口");
}

function ensureWorkcode(store) {
  const target = "Z:\\workcode";
  const current = store.snapshot().settings.extraDirectories || [];
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    return current;
  }
  if (current.some((item) => path.resolve(item) === path.resolve(target))) return current;
  const next = [...current, target];
  store.update((draft) => {
    draft.settings.extraDirectories = next;
    return draft;
  });
  return next;
}

function publicState(state) {
  const workspace = state.currentWorkspace || "";
  return {
    currentWorkspace: workspace,
    recentWorkspaces: state.recentWorkspaces,
    settings: {
      provider: state.settings.provider,
      baseUrl: state.settings.baseUrl,
      model: state.settings.model,
      hasApiKey: Boolean(state.settings.apiKey),
    },
    tasks: state.tasks.map(publicTask),
    experts: loadExperts(workspace),
    skills: loadSkills(workspace),
    notices: taskNotices(state.tasks),
    library: workspace ? listLibrary(workspace) : [],
  };
}

function describeFile(workspace, relative) {
  const target = resolveInside(workspace, relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw httpError(404, "文件不存在");
  const shown = toRelative(workspace, target);
  const mtimeMs = fileMtime(workspace, shown);
  const extension = path.extname(target).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(extension)) {
    return { path: shown, kind: "image", content: "", mtimeMs };
  }
  if (extension === ".html" || extension === ".htm") {
    return { path: shown, kind: "html", content: readText(workspace, shown), mtimeMs };
  }
  const data = fs.readFileSync(target);
  if (data.includes(0)) return { path: shown, kind: "binary", content: "", mtimeMs };
  return { path: shown, kind: "text", content: decodeBuffer(data).slice(0, 200_000), mtimeMs };
}

function contentType(target) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return types[path.extname(target).toLowerCase()] || "text/plain; charset=utf-8";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, "文件超过 8MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(httpError(413, "请求过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "请求不是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  if (body?.raw) {
    res.writeHead(status, {
      "Content-Type": body.type || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body.raw);
    return;
  }
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function serveStatic(pathname, res) {
  const dist = path.join(appRoot, "client", "dist");
  const requested = pathname === "/" ? "/index.html" : pathname;
  let decoded = requested;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    sendJson(res, 400, { error: "路径无效" });
    return;
  }
  const target = path.resolve(dist, `.${decoded}`);
  if (target !== dist && !target.startsWith(`${dist}${path.sep}`)) {
    sendJson(res, 403, { error: "拒绝访问" });
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    sendJson(res, 404, { error: "页面还没有构建，请先运行 npm run build" });
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  res.writeHead(200, {
    "Content-Type": types[path.extname(target).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(target).pipe(res);
}

function isDirectRun() {
  const self = fileURLToPath(import.meta.url);
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === self);
}

if (isDirectRun()) {
  const port = Number(process.env.PORT || 4186);
  const { server } = createServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`OpenWorkBuddy http://127.0.0.1:${port}\n`);
  });
}
