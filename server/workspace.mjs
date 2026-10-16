import fs from "node:fs";
import path from "node:path";
import { decodeBuffer } from "./text.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
let extraRoots = [];

export function setExtraRoots(roots) {
  extraRoots = (Array.isArray(roots) ? roots : [])
    .map((item) => path.resolve(String(item || "").trim()))
    .filter((item) => item && isDirectory(item));
}

export function extraRootList() {
  return [...extraRoots];
}

function isDirectory(target) {
  try {
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveInside(root, inputPath = ".") {
  const raw = String(inputPath ?? ".").trim();
  if (!raw || raw === "." || raw === "./") return path.resolve(root);
  if (path.isAbsolute(raw)) {
    const resolved = path.resolve(raw);
    if (isInside(root, resolved) || extraRoots.some((extra) => isInside(extra, resolved))) return resolved;
    throw new Error("只能写入工作区或已允许的目录");
  }
  const resolved = path.resolve(root, raw);
  if (!isInside(root, resolved)) throw new Error("路径超出工作区");
  return resolved;
}

export function shownPath(root, target) {
  if (isInside(root, target)) return toRelative(root, target);
  return path.resolve(target);
}

export function toRelative(root, target) {
  return path.relative(root, target).replaceAll("\\", "/");
}

export function ensureWorkspace(input) {
  const root = path.resolve(String(input || "").trim());
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("这个路径不是已存在的文件夹");
  }
  return root;
}

export function listFiles(root, relative = ".", depth = 4) {
  const start = resolveInside(root, relative);
  if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) throw new Error("目录不存在");
  const items = [];
  function walk(current, level) {
    if (items.length >= 300 || level > depth) return;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const shown = toRelative(root, full);
      if (!shown || shown.startsWith("..")) continue;
      if (entry.isDirectory()) {
        items.push(`${shown}/`);
        walk(full, level + 1);
      } else if (entry.isFile()) {
        items.push(shown);
      }
      if (items.length >= 300) return;
    }
  }
  walk(start, 1);
  return items;
}

export function readText(root, relative) {
  const target = resolveInside(root, relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error("文件不存在");
  const size = fs.statSync(target).size;
  if (size > 200_000) throw new Error("文件超过 200KB，暂不读取");
  const data = fs.readFileSync(target);
  if (data.includes(0)) throw new Error("这不是文本文件");
  return decodeBuffer(data);
}

export function writeText(root, relative, content) {
  const target = resolveInside(root, relative);
  resolveInside(root, path.dirname(target));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existed = fs.existsSync(target) && fs.statSync(target).isFile();
  const before = existed ? fs.readFileSync(target, "utf8") : null;
  const text = String(content ?? "");
  fs.writeFileSync(target, text, "utf8");
  return {
    path: shownPath(root, target),
    action: existed ? "modified" : "created",
    before,
    after: text,
  };
}

export function searchText(root, query) {
  const needle = String(query || "").trim();
  if (!needle) throw new Error("请提供要搜索的文字");
  const hits = [];
  function walk(current) {
    if (hits.length >= 40) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const size = fs.statSync(full).size;
        if (size > 512_000) continue;
        let text = "";
        try {
          const data = fs.readFileSync(full);
          if (data.includes(0)) continue;
          text = decodeBuffer(data);
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].includes(needle)) continue;
          hits.push(`${toRelative(root, full)}:${index + 1}: ${lines[index].slice(0, 200)}`);
          if (hits.length >= 40) return;
        }
      }
      if (hits.length >= 40) return;
    }
  }
  walk(path.resolve(root));
  return hits;
}

export function importFile(root, sourcePath) {
  const source = path.resolve(String(sourcePath || ""));
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("要导入的文件不存在");
  const name = path.basename(source).replace(/[<>:"|?*]/g, "_");
  const relative = `inbox/${name}`;
  const target = resolveInside(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return toRelative(root, target);
}

export function buildTree(root, depth = 6) {
  const nodes = [];
  let count = 0;
  function walk(current, level) {
    if (level > depth || count > 400) return [];
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !SKIP_DIRS.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    const children = [];
    for (const entry of entries) {
      if (count > 400) break;
      count += 1;
      const full = path.join(current, entry.name);
      const relative = toRelative(root, full);
      if (entry.isDirectory()) {
        children.push({ name: entry.name, path: relative, type: "dir", children: walk(full, level + 1) });
      } else if (entry.isFile()) {
        children.push({ name: entry.name, path: relative, type: "file" });
      }
    }
    return children;
  }
  nodes.push(...walk(path.resolve(root), 1));
  return nodes;
}

export function fileMtime(root, relative) {
  const target = resolveInside(root, relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error("文件不存在");
  return fs.statSync(target).mtimeMs;
}

export function saveText(root, relative, content, expectedMtime) {
  const target = resolveInside(root, relative);
  if (path.resolve(target) === path.resolve(root)) throw new Error("不能把工作区根目录当成文件");
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new Error("这是文件夹，不能按文件保存");
  if (fs.existsSync(target) && expectedMtime != null && expectedMtime !== "") {
    const current = fs.statSync(target).mtimeMs;
    if (Math.abs(current - Number(expectedMtime)) > 2) {
      const error = new Error("文件在别处发生了修改。可以刷新载入新版本，或另存为副本。");
      error.status = 409;
      throw error;
    }
  }
  const written = writeText(root, relative, content);
  return { ...written, mtimeMs: fs.statSync(target).mtimeMs };
}

export function makeDir(root, relative) {
  const target = resolveInside(root, relative);
  if (path.resolve(target) === path.resolve(root)) throw new Error("不能把工作区本身当作新文件夹");
  fs.mkdirSync(target, { recursive: true });
  return toRelative(root, target);
}

export function moveEntry(root, from, to) {
  const source = resolveInside(root, from);
  const dest = resolveInside(root, to);
  if (path.resolve(source) === path.resolve(root)) throw new Error("不能移动工作区根目录");
  if (!fs.existsSync(source)) throw new Error("要移动的文件不存在");
  if (path.resolve(dest) === path.resolve(root) || path.resolve(dest).startsWith(`${path.resolve(source)}${path.sep}`)) {
    throw new Error("不能移动到这个位置");
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(source, dest);
  return toRelative(root, dest);
}

export function removeEntry(root, relative) {
  const target = resolveInside(root, relative);
  if (path.resolve(target) === path.resolve(root)) throw new Error("不能删除工作区根目录");
  if (!fs.existsSync(target)) throw new Error("文件不存在");
  fs.rmSync(target, { recursive: true, force: false });
}

export function saveUpload(root, name, data, nested = "") {
  const relative = nested ? uniqueInboxPath(root, nested) : uniqueFlatName(root, name);
  const target = resolveInside(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return toRelative(root, target);
}

function uniqueFlatName(root, name) {
  const cleaned = path.basename(String(name || "附件")).replace(/[<>:"|?*]/g, "_") || "附件";
  const extension = path.extname(cleaned);
  const stem = path.basename(cleaned, extension) || "附件";
  let relative = `inbox/${stem}${extension}`;
  let index = 2;
  while (fs.existsSync(resolveInside(root, relative))) {
    relative = `inbox/${stem}-${index}${extension}`;
    index += 1;
  }
  return relative;
}

function uniqueInboxPath(root, nested) {
  const parts = String(nested).replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..").map((part) => part.replace(/[<>:"|?*]/g, "_"));
  if (!parts.length) throw new Error("没有文件名");
  const extension = path.extname(parts.at(-1));
  const stem = path.basename(parts.at(-1), extension) || "附件";
  let relative = path.posix.join("inbox", ...parts.slice(0, -1), `${stem}${extension}`);
  let index = 2;
  while (fs.existsSync(resolveInside(root, relative))) {
    relative = path.posix.join("inbox", ...parts.slice(0, -1), `${stem}-${index}${extension}`);
    index += 1;
  }
  return relative;
}

export function readContext(root) {
  const names = ["IDENTITY.md", "USER.md", "MEMORY.md", "SOUL.md"];
  const parts = [];
  for (const name of names) {
    const target = path.join(root, name);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
    try {
      const text = fs.readFileSync(target, "utf8").slice(0, 2000);
      if (text.trim()) parts.push(`# ${name}\n${text}`);
    } catch {
      // 单个记忆文件读不到时，其余文件仍然可用。
    }
  }
  return parts.join("\n\n");
}
