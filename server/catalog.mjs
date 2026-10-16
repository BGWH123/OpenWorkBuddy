import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadExperts(workspace = "") {
  return [
    ...readExperts(path.join(appRoot, "builtin", "experts")),
    ...readExperts(workspace ? path.join(workspace, ".openworkbuddy", "experts") : ""),
  ];
}

export function loadSkills(workspace = "") {
  return [
    ...readSkills(path.join(appRoot, "builtin", "skills")),
    ...readSkills(workspace ? path.join(workspace, ".openworkbuddy", "skills") : ""),
  ];
}

export function findExpert(workspace, id) {
  return loadExperts(workspace).find((item) => item.id === id) || null;
}

export function findSkill(workspace, id) {
  return loadSkills(workspace).find((item) => item.id === id) || null;
}

export function writeExpert(workspace, input) {
  const name = safeName(input?.name);
  const summary = oneLine(input?.summary);
  const kind = input?.kind === "team" ? "team" : "expert";
  const dir = path.join(workspace, ".openworkbuddy", "experts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---\nname: ${name}\nkind: ${kind}\nsummary: ${summary}\n---\n\n${summary}\n`, "utf8");
  return name;
}

export function writeSkill(workspace, input) {
  const name = safeName(input?.name);
  const summary = oneLine(input?.summary);
  const dir = path.join(workspace, ".openworkbuddy", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\nsummary: ${summary}\n---\n\n${summary}\n`, "utf8");
  return name;
}

function safeName(value) {
  const name = String(value || "").trim().replace(/[<>:"|?*\\/]/g, "").slice(0, 40);
  if (!name || name === "." || name === "..") throw new Error("请填写名称");
  return name;
}

function oneLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").slice(0, 200);
}

function readExperts(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const parsed = parseDocument(fs.readFileSync(path.join(dir, name), "utf8"));
      const id = name.slice(0, -3);
      return {
        id,
        name: parsed.meta.name || id,
        kind: parsed.meta.kind === "team" ? "team" : "expert",
        summary: parsed.meta.summary || "",
        members: String(parsed.meta.members || "").split(",").map((item) => item.trim()).filter(Boolean),
        body: parsed.body,
      };
    });
}

function readSkills(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(file)) return null;
      const parsed = parseDocument(fs.readFileSync(file, "utf8"));
      return {
        id: entry.name,
        name: parsed.meta.name || entry.name,
        summary: parsed.meta.summary || "",
        body: parsed.body,
      };
    })
    .filter(Boolean);
}

function parseDocument(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { meta: {}, body: text.trim() };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim();
  }
  return { meta, body: text.slice(end + 4).trim() };
}
