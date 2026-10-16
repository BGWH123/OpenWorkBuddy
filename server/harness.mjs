import fs from "node:fs";
import path from "node:path";
import { findSkill, loadSkills } from "./catalog.mjs";
import { assertCommandAllowed } from "./policy.mjs";
import { collectOutput } from "./spawn.mjs";
import { listFiles, readText, resolveInside, searchText, writeText } from "./workspace.mjs";

const ALIASES = {
  write_file: "Write",
  read_file: "Read",
  search_text: "Grep",
  list_dir: "Glob",
  run_command: "Bash",
};

const READ_ONLY = new Set(["Read", "Grep", "Glob", "Skill", "TaskList", "TaskGet", "TaskCreate", "TaskUpdate"]);
const MUTATING = new Set(["Write", "Edit", "MultiEdit", "Bash", "PowerShell", "WebFetch"]);

export const HARNESS_TOOLS = [
  { name: "Read", description: "读取工作区内的文本文件", parameters: { path: "相对路径" }, required: ["path"] },
  { name: "Grep", description: "在工作区文本中搜索", parameters: { pattern: "要搜索的文字或正则", path: "可选的相对目录" }, required: ["pattern"] },
  { name: "Glob", description: "按文件名模式列出工作区文件", parameters: { pattern: "如 **/*.md，留空表示全部" }, required: [] },
  { name: "Write", description: "创建或覆盖工作区文件", parameters: { path: "相对路径", content: "完整内容" }, required: ["path", "content"] },
  { name: "Edit", description: "把文件中的一段原文替换成新文本", parameters: { path: "相对路径", old_string: "要替换的原文", new_string: "替换后的文本" }, required: ["path", "old_string", "new_string"] },
  { name: "MultiEdit", description: "对同一文件连续做多处替换。edits 是 JSON 数组", parameters: { path: "相对路径", edits: "[{old_string,new_string}] 的 JSON" }, required: ["path", "edits"] },
  { name: "Bash", description: "在工作区目录执行命令。危险命令会被拒绝或等待用户允许", parameters: { command: "命令" }, required: ["command"] },
  { name: "PowerShell", description: "在工作区目录执行 PowerShell", parameters: { command: "命令" }, required: ["command"] },
  { name: "Skill", description: "读取一个本地技能的说明并按它执行", parameters: { name: "技能 id 或名称" }, required: ["name"] },
  { name: "Agent", description: "派一个只有读取和编辑能力的子代理处理子任务", parameters: { prompt: "交给子代理的任务", tools: "可选，逗号分隔的工具名" }, required: ["prompt"] },
  { name: "TaskCreate", description: "在当前任务清单里新增一项", parameters: { subject: "标题", description: "说明" }, required: ["subject"] },
  { name: "TaskUpdate", description: "更新任务清单中的一项", parameters: { id: "任务编号", status: "pending、in_progress 或 completed" }, required: ["id", "status"] },
  { name: "TaskList", description: "列出当前任务清单", parameters: {}, required: [] },
  { name: "TaskGet", description: "查看任务清单中的一项", parameters: { id: "任务编号" }, required: ["id"] },
  { name: "AskUserQuestion", description: "向用户提一个问题并等待回答", parameters: { question: "问题" }, required: ["question"] },
  { name: "WebFetch", description: "获取 http 或 https 页面的文本", parameters: { url: "网址" }, required: ["url"] },
];

export function canonicalTool(name) {
  return ALIASES[name] || name;
}

export function harnessToolsForMode(mode, executing) {
  if (mode === "plan" && !executing) return [];
  if (mode === "ask") return HARNESS_TOOLS.filter((tool) => READ_ONLY.has(tool.name));
  return HARNESS_TOOLS;
}

export function loadHarnessSettings(workspace) {
  const file = path.join(workspace, ".openworkbuddy", "settings.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      permissions: {
        allow: parsed.permissions?.allow || [],
        ask: parsed.permissions?.ask || [],
        deny: parsed.permissions?.deny || [],
      },
      hooks: parsed.hooks || {},
    };
  } catch {
    return { permissions: { allow: [], ask: [], deny: [] }, hooks: {} };
  }
}

export async function decideTool({ name, args, mode, executing, workspace, settings, depth }) {
  const tool = canonicalTool(name);
  if (matchRules(settings.permissions.deny, tool, args)) return { action: "deny", reason: "权限规则拒绝了这个操作" };
  if ((mode === "ask" || (mode === "plan" && !executing)) && !READ_ONLY.has(tool)) {
    return { action: "deny", reason: mode === "ask" ? "仅问答不能修改文件或执行命令" : "计划确认前不能修改文件或执行命令" };
  }
  if (tool === "Agent" && depth > 0) return { action: "deny", reason: "子代理不能再派生子代理" };
  if (tool === "Bash" || tool === "PowerShell") {
    try {
      assertCommandAllowed(args.command || "");
    } catch (error) {
      return { action: "deny", reason: error.message };
    }
  }
  const hook = await runPreHooks(workspace, tool, args);
  if (hook.action === "deny" || hook.action === "ask") return hook;
  if (matchRules(settings.permissions.ask, tool, args)) return { action: "ask", reason: "权限规则要求先询问" };
  if ((tool === "Bash" || tool === "PowerShell") && looksRisky(args.command || "")) {
    return { action: "ask", reason: "这条命令需要你允许后才会执行" };
  }
  if (tool === "AskUserQuestion") return { action: "ask", reason: args.question || "需要你回答一个问题", kind: "question" };
  return { action: "allow" };
}

export async function performTool(toolCall, workspace, context = {}) {
  const name = canonicalTool(toolCall.name);
  const args = typeof toolCall.arguments === "string" ? parseArgs(toolCall.arguments) : (toolCall.arguments || {});
  const todos = Array.isArray(context.todos) ? context.todos.map((item) => ({ ...item })) : [];
  try {
    if (name === "Read") return { text: readText(workspace, args.path || args.file_path) };
    if (name === "Grep") {
      const hits = searchText(workspace, args.pattern || args.query || "");
      const prefix = args.path ? `${String(args.path).replaceAll("\\", "/")}` : "";
      const filtered = prefix ? hits.filter((line) => line.startsWith(prefix)) : hits;
      return { text: filtered.length ? filtered.join("\n") : "没有匹配。" };
    }
    if (name === "Glob") {
      const items = listFiles(workspace, ".");
      const pattern = String(args.pattern || args.path || "").trim();
      const matched = pattern && pattern !== "." ? items.filter((item) => globMatch(item.replace(/\/$/, ""), pattern)) : items;
      return { text: matched.length ? matched.join("\n") : "没有匹配的文件。" };
    }
    if (name === "Write") {
      const artifact = writeText(workspace, args.path || args.file_path, args.content ?? "");
      return { text: `已写入 ${artifact.path}`, artifact };
    }
    if (name === "Edit") {
      const artifact = editFile(workspace, args.path || args.file_path, args.old_string, args.new_string, args.replace_all === "true");
      return { text: `已修改 ${artifact.path}`, artifact };
    }
    if (name === "MultiEdit") {
      const edits = typeof args.edits === "string" ? parseArgs(args.edits) : args.edits;
      let artifact = null;
      for (const edit of Array.isArray(edits) ? edits : []) {
        artifact = editFile(workspace, args.path, edit.old_string, edit.new_string, false);
      }
      return { text: `已修改 ${artifact?.path || args.path}`, artifact };
    }
    if (name === "Bash") return await runShell(args.command, workspace, "cmd");
    if (name === "PowerShell") return await runShell(args.command, workspace, "powershell");
    if (name === "Skill") {
      const skill = findSkill(workspace, args.name) || loadSkills(workspace).find((item) => item.name === args.name);
      if (!skill) return { text: "没有这个技能。" };
      return { text: `# ${skill.name}\n\n${skill.body}` };
    }
    if (name === "Agent") {
      if (!context.runNested) return { text: "当前不能派生子代理。" };
      const text = await context.runNested(String(args.prompt || ""), String(args.tools || ""));
      return { text };
    }
    if (name === "TaskCreate") {
      const item = { id: String(todos.length + 1), subject: String(args.subject || "未命名"), description: String(args.description || ""), status: "pending" };
      todos.push(item);
      return { text: `已添加任务 ${item.id}：${item.subject}`, todos };
    }
    if (name === "TaskUpdate") {
      const item = todos.find((entry) => entry.id === String(args.id));
      if (!item) return { text: "没有这个任务编号。", todos };
      item.status = ["pending", "in_progress", "completed"].includes(args.status) ? args.status : item.status;
      return { text: `任务 ${item.id} 现在是 ${item.status}`, todos };
    }
    if (name === "TaskList") {
      return { text: todos.length ? todos.map((item) => `${item.id} [${item.status}] ${item.subject}`).join("\n") : "任务清单是空的。", todos };
    }
    if (name === "TaskGet") {
      const item = todos.find((entry) => entry.id === String(args.id));
      return { text: item ? `${item.id} [${item.status}] ${item.subject}\n${item.description}` : "没有这个任务编号。", todos };
    }
    if (name === "WebFetch") return { text: await fetchUrl(args.url) };
    return { text: `不认识的操作：${toolCall.name}` };
  } catch (error) {
    return { text: `操作失败：${error instanceof Error ? error.message : "未知错误"}`, todos };
  }
}

function editFile(workspace, relative, oldText, newText, replaceAll) {
  const current = readText(workspace, relative);
  const source = String(oldText ?? "");
  if (!source) throw new Error("要替换的原文不能为空");
  if (!current.includes(source)) throw new Error("找不到要替换的原文");
  const next = replaceAll ? current.split(source).join(String(newText ?? "")) : current.replace(source, String(newText ?? ""));
  return writeText(workspace, relative, next);
}

async function runShell(command, workspace, kind) {
  const allowed = assertCommandAllowed(command);
  const result = kind === "powershell"
    ? await collectOutput("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", utf8PowerShell(allowed)], { cwd: workspace })
    : await collectOutput(allowed, [], { cwd: workspace, shell: true });
  return { text: `退出码 ${result.code}\n${result.output || "（没有输出）"}` };
}

function utf8PowerShell(command) {
  return `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[Console]::OutputEncoding; ${command}`;
}

async function fetchUrl(input) {
  const url = new URL(String(input || ""));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许 http 或 https");
  if (url.hostname === "169.254.169.254" || url.hostname.endsWith(".local")) throw new Error("这个地址不在允许范围内");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  return text.slice(0, 8_000);
}

async function runPreHooks(workspace, tool, args) {
  const settings = loadHarnessSettings(workspace);
  const hooks = settings.hooks?.PreToolUse || [];
  for (const hook of Array.isArray(hooks) ? hooks : []) {
    if (hook.matcher && hook.matcher !== "*" && hook.matcher !== tool) continue;
    if (!hook.command) continue;
    let script = "";
    try {
      script = resolveInside(workspace, hook.command);
    } catch (error) {
      return { action: "deny", reason: error.message };
    }
    if (!fs.existsSync(script) || !fs.statSync(script).isFile()) return { action: "deny", reason: "钩子脚本不存在" };
    const result = await collectOutput(process.execPath, [script, tool], { cwd: workspace });
    if (result.code === 2) return { action: "deny", reason: result.output || "钩子拒绝了这个操作" };
    const parsed = parseArgs(result.output);
    if (parsed.decision === "deny") return { action: "deny", reason: parsed.reason || "钩子拒绝了这个操作" };
    if (parsed.decision === "ask") return { action: "ask", reason: parsed.reason || "钩子要求先询问" };
  }
  return { action: "allow" };
}

function matchRules(rules, tool, args) {
  return (rules || []).some((rule) => {
    const text = String(rule || "");
    const named = text.match(/^([A-Za-z]+)\((.+)\)$/);
    if (!named) return text === tool;
    if (named[1] !== tool) return false;
    const body = `${args.command || ""} ${args.path || ""}`;
    const needle = named[2].replace(/:\*$/, "").replace(/\*$/, "");
    return body.includes(needle);
  });
}

function looksRisky(command) {
  return /\b(git\s+push|npm\s+publish|curl|wget|Invoke-WebRequest|iwr)\b/i.test(command);
}

function globMatch(value, pattern) {
  const source = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(source, "i").test(value) || new RegExp(source, "i").test(value.split("/").pop());
}

function parseArgs(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
