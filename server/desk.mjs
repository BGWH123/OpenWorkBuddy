import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const LIBRARY_ROOTS = ["资料", path.join(".openworkbuddy", "library")];
const MAX_LIBRARY = 200;
const MAX_DEPTH = 4;
const MAX_NOTICES = 30;

export function assertInside(root, inputPath = ".") {
  const base = path.resolve(root);
  const raw = String(inputPath ?? ".").trim().replaceAll("/", path.sep);
  if (!raw || raw === ".") return base;
  if (path.isAbsolute(raw)) throw new Error("只能使用工作区内的相对路径");
  const resolved = path.resolve(base, raw);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("路径超出工作区");
  return resolved;
}

export function openInExplorer(workspaceRoot, relativePath) {
  const target = assertInside(workspaceRoot, relativePath);
  if (!fs.existsSync(target)) throw new Error("路径不存在");
  const stat = fs.statSync(target);
  if (process.platform !== "win32") throw new Error("当前系统不能用资源管理器打开");
  const args = stat.isDirectory() ? [target] : stat.isFile() ? [`/select,${target}`] : null;
  if (!args) throw new Error("无法在资源管理器中打开这个路径");
  const child = spawn("explorer.exe", args, { shell: false, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return { ok: true, path: target };
}

export function exportTaskMarkdown(workspaceRoot, task) {
  if (!task || typeof task !== "object") throw new Error("缺少任务内容");
  const root = requireRoot(workspaceRoot);
  const relative = unusedSharePath(root);
  const target = assertInside(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderTask(task), "utf8");
  return relative;
}

export function listLibrary(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot ?? ""));
  const items = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return items;
  for (const folder of LIBRARY_ROOTS) {
    const dir = path.resolve(root, folder);
    const relative = path.relative(root, dir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    walkLibrary(root, dir, 1, items);
  }
  return items;
}

export function saveLibraryNote(workspaceRoot, name, content) {
  const root = requireRoot(workspaceRoot);
  const fileName = libraryFileName(name);
  const relative = `资料/${fileName}.md`.replaceAll("\\", "/");
  const target = assertInside(root, relative);
  const library = path.resolve(root, "资料");
  const parentRelative = path.relative(library, path.dirname(target));
  if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw new Error("路径超出工作区");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, String(content ?? ""), "utf8");
  return toRelative(root, target);
}

export function taskNotices(tasks) {
  const notices = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task !== "object") continue;
    const notice = noticeFor(task);
    if (notice) notices.push(notice);
  }
  notices.sort((a, b) => b.updatedAt - a.updatedAt);
  return notices.slice(0, MAX_NOTICES).map(({ id, kind, title, text }) => ({ id, kind, title, text }));
}

function requireRoot(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot ?? ""));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("这个路径不是已存在的文件夹");
  }
  return root;
}

function toRelative(root, target) {
  return path.relative(path.resolve(root), target).replaceAll("\\", "/");
}

function unusedSharePath(root) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const relative = `output/share-${randomBytes(4).toString("hex")}.md`;
    if (!fs.existsSync(path.join(root, relative))) return relative;
  }
  return `output/share-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.md`;
}

function libraryFileName(name) {
  const raw = String(name ?? "").trim();
  if (!raw) throw new Error("请提供资料名称");
  if (path.isAbsolute(raw)) throw new Error("只能使用工作区内的相对路径");
  const parts = raw.replaceAll("\\", "/").split("/");
  if (parts.some((part) => part === "..")) throw new Error("路径超出工作区");
  if (parts.length !== 1) throw new Error("资料名称不能包含路径");
  const cleaned = raw.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("资料名称无效");
  return cleaned;
}

function walkLibrary(root, current, level, items) {
  if (level > MAX_DEPTH || items.length >= MAX_LIBRARY) return;
  let entries = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  for (const entry of entries) {
    if (items.length >= MAX_LIBRARY) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    const shown = toRelative(root, full);
    if (!shown || shown.startsWith("..") || path.isAbsolute(shown)) continue;
    if (entry.isDirectory()) {
      walkLibrary(root, full, level + 1, items);
    } else if (entry.isFile()) {
      items.push({ path: shown, name: entry.name, folder: path.posix.dirname(shown) });
    }
  }
}

function noticeFor(task) {
  let kind = "";
  let text = "";
  if (task.status === "awaiting_confirm") {
    kind = "confirm";
    text = "任务操作待您确认";
  } else if (task.status === "done") {
    kind = "done";
    text = "任务已成功完成";
  } else {
    return null;
  }
  return { id: task.id, kind, title: task.title, text, updatedAt: stamp(task.updatedAt) };
}

function stamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function renderTask(task) {
  const title = redact(task.title || "未命名任务");
  const lines = [
    `# ${title}`,
    "",
    `- 模式：${modeText(task.mode)}`,
    `- 状态：${statusText(task.status)}`,
    "",
  ];
  for (const message of Array.isArray(task.messages) ? task.messages : []) {
    lines.push(messageHeading(message), "", redact(message?.content || ""), "");
  }
  lines.push("## 产物", "");
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  if (!artifacts.length) {
    lines.push("（无）");
  } else {
    for (const artifact of artifacts) {
      lines.push(`- ${redact(artifact?.path || "未命名文件")}（${actionText(artifact?.action)}）`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function messageHeading(message) {
  const role = message?.role;
  let label = "消息";
  if (role === "user") label = "用户";
  else if (role === "assistant") label = "助手";
  else if (role === "tool") label = "工具";
  else if (role === "system") label = "系统";
  else if (role) label = redact(role);
  const tool = message?.toolName ? ` · ${redact(message.toolName)}` : "";
  return `## ${label}${tool}`;
}

function modeText(mode) {
  if (mode === "plan") return "计划";
  if (mode === "ask") return "仅问答";
  if (mode === "agent") return "默认";
  return redact(mode || "默认");
}

function statusText(status) {
  if (status === "running") return "执行中";
  if (status === "awaiting_confirm") return "待确认";
  if (status === "done") return "已完成";
  if (status === "error") return "失败";
  return redact(status || "进行中");
}

function actionText(action) {
  if (action === "created") return "新建";
  if (action === "modified") return "修改";
  if (action === "deleted") return "删除";
  return redact(action || "记录");
}

function redact(value) {
  let text = String(value ?? "");
  text = text.replace(/\b(?:sk-[A-Za-z0-9_\-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[已隐藏]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, "Bearer [已隐藏]");
  text = text.replace(/\b((?:api[_-]?key|access[_-]?key|secret|token|password|passwd))\b(\s*[:=]\s*)["']?[^\s"',]+/gi, "$1$2[已隐藏]");
  return text;
}
