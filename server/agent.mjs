import { canonicalTool, decideTool, harnessToolsForMode, HARNESS_TOOLS, loadHarnessSettings, performTool } from "./harness.mjs";
import { collectOutput } from "./spawn.mjs";
import { assertCommandAllowed } from "./policy.mjs";

export const TOOL_DEFS = HARNESS_TOOLS;

export function toolsForMode(mode, executing) {
  return harnessToolsForMode(mode, executing);
}

export function buildSystem({ mode, executing, workspace, expert, skill, context, extraDirectories }) {
  const lines = [
    "你是 OpenWorkBuddy，负责在用户指定的本地工作区里完成任务。",
    "使用工具完成工作：Read、Grep、Glob 用于查看，Write、Edit、MultiEdit 用于改文件，Bash 或 PowerShell 用于执行命令。",
    "Skill 读取本地技能说明。Agent 把子任务交给独立上下文。TaskCreate、TaskUpdate、TaskList 维护任务清单。需要用户做决定时调用 AskUserQuestion。",
    "工作区内的文件用相对路径。用户点名的已允许目录可以用完整绝对路径写入，不要拒绝这些目录。",
    "不要编造没有读到的文件内容，也不要编造外部资料。缺少证据时直接写未确认。",
    `当前工作区：${workspace}`,
    extraDirectories?.length ? `已允许写入的其他目录：${extraDirectories.join("、")}。写这些目录时使用完整绝对路径，不要说无法写入。` : "",
    `当前模式：${modeLabel(mode)}。`,
  ];
  if (mode === "ask") lines.push("仅问答：只能列出、读取和搜索，不能写入文件，不能执行命令。");
  else if (mode === "plan" && !executing) lines.push("计划：只给出可审阅的步骤，不要调用工具，不要声称已经修改文件。");
  else lines.push("可以写入工作区文件，也可以在工作区目录执行命令。完成后说明产物路径。");
  if (expert) lines.push(`专家角色「${expert.name}」：\n${expert.body}`);
  if (skill) lines.push(`启用技能「${skill.name}」：\n${skill.body}`);
  if (context) lines.push(`工作区中的身份和记忆文件，只作为背景：\n${context}`);
  return lines.join("\n\n");
}

export async function runAgent({ messages, tools, provider, workspace, maxSteps = 12, context = {} }) {
  const transcript = messages.map((message) => ({ ...message }));
  const allowed = new Set(tools.map((tool) => tool.name));
  let todos = context.todos || [];
  for (let step = 0; step < maxSteps; step += 1) {
    const result = await provider(transcript, tools);
    const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    if (!toolCalls.length) {
      transcript.push({
        role: "assistant",
        content: String(result?.content || ""),
        thinking: clipThinking(result?.thinking),
        at: Date.now(),
      });
      return transcript;
    }
    transcript.push({
      role: "assistant",
      content: String(result?.content || ""),
      thinking: clipThinking(result?.thinking),
      toolCalls,
      at: Date.now(),
    });
    for (const toolCall of toolCalls) {
      const executed = await executeTool(toolCall, workspace, allowed, { ...context, todos });
      if (executed.ask) {
        return { transcript, pause: { toolCall, reason: executed.reason, kind: executed.kind || "permission" }, todos };
      }
      if (executed.todos) todos = executed.todos;
      transcript.push(toolMessage(toolCall, executed));
    }
  }
  transcript.push({ role: "assistant", content: "这一轮的步骤已经达到上限。可以继续补充要求。", at: Date.now() });
  return transcript;
}

export async function executeTool(toolCall, workspace, allowed, context = {}) {
  const name = canonicalTool(toolCall.name);
  if (allowed && !allowed.has(toolCall.name) && !allowed.has(name)) {
    return { text: `已拒绝 ${toolCall.name}：当前模式不允许这个操作。` };
  }
  if (context.permit && !context.skipAsk) {
    const settings = context.settings || loadHarnessSettings(workspace);
    const decision = await decideTool({
      name: toolCall.name,
      args: typeof toolCall.arguments === "string" ? parseArgs(toolCall.arguments) : (toolCall.arguments || {}),
      mode: context.mode,
      executing: context.executing,
      workspace,
      settings,
      depth: context.depth || 0,
    });
    if (decision.action === "deny") return { text: `已拒绝 ${name}：${decision.reason}` };
    if (decision.action === "ask") return { ask: true, reason: decision.reason, kind: decision.kind || "permission" };
  }
  return performTool(toolCall, workspace, context);
}

function toolMessage(toolCall, executed) {
  return {
    role: "tool",
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    content: clip(executed.text),
    artifact: executed.artifact ? { path: executed.artifact.path, action: executed.artifact.action } : null,
    change: executed.artifact ? clipChange(executed.artifact) : null,
    todos: executed.todos || null,
    at: Date.now(),
  };
}

export async function completeWithOpenAI({ settings, messages, tools, system, fetchImpl = fetch, onUpdate }) {
  if (!settings.apiKey) throw new Error("还没有填写外部模型的接口密钥");
  const payload = {
    model: settings.model || "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      ...messages.filter((message) => message.role !== "status").map(toOpenAIMessage),
    ],
  };
  if (onUpdate) {
    payload.stream = true;
    if (tools.length) payload.reasoning_effort = "medium";
  }
  if (tools.length) payload.tools = tools.map(toOpenAITool);
  let response = await postChat(settings, payload, fetchImpl);
  if (!response.ok && payload.reasoning_effort) {
    const data = await response.json().catch(() => ({}));
    const message = data?.error?.message || "";
    if (/reasoning/i.test(message)) {
      delete payload.reasoning_effort;
      response = await postChat(settings, payload, fetchImpl);
    } else {
      throw new Error(message || `外部模型返回 ${response.status}`);
    }
  }
  const type = response.headers?.get?.("content-type") || "";
  if (onUpdate && type.includes("text/event-stream") && response.body) {
    return readCompletionStream(response, onUpdate);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `外部模型返回 ${response.status}`;
    throw new Error(message);
  }
  const parsed = parseCompletionMessage(data?.choices?.[0]?.message || {});
  onUpdate?.(parsed);
  return parsed;
}

function postChat(settings, payload, fetchImpl) {
  return fetchImpl(chatEndpoint(settings.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(payload),
  });
}

async function readCompletionStream(response, onUpdate) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let thinking = "";
  let content = "";
  const toolCalls = [];
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    onUpdate({ thinking, content, toolCalls });
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta || {};
      if (delta.reasoning_content) thinking += delta.reasoning_content;
      if (typeof delta.content === "string") content += delta.content;
      if (Array.isArray(delta.tool_calls)) mergeToolDeltas(toolCalls, delta.tool_calls);
      emit();
    }
  }
  emit(true);
  return { thinking, content, toolCalls: toolCalls.filter((call) => call.name) };
}

function parseCompletionMessage(message) {
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => ({
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments || "{}",
    }))
    : [];
  return {
    content: message.content || "",
    thinking: message.reasoning_content || message.thinking || "",
    toolCalls,
  };
}

function mergeToolDeltas(toolCalls, deltas) {
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : toolCalls.length;
    if (!toolCalls[index]) toolCalls[index] = { id: delta.id || `call_${index}`, name: "", arguments: "" };
    if (delta.id) toolCalls[index].id = delta.id;
    if (delta.function?.name) toolCalls[index].name += delta.function.name;
    if (delta.function?.arguments) toolCalls[index].arguments += delta.function.arguments;
  }
}

function toOpenAIMessage(message) {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content || "" };
  }
  if (message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments || {}),
        },
      })),
    };
  }
  return { role: message.role, content: message.content || "" };
}

function toOpenAITool(tool) {
  const properties = {};
  for (const [key, description] of Object.entries(tool.parameters)) {
    properties[key] = { type: "string", description };
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { type: "object", properties, required: tool.required || [] },
    },
  };
}

function chatEndpoint(baseUrl) {
  const base = String(baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function parseArgs(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function runInWorkspace(command, cwd) {
  return runCommand(assertCommandAllowed(command), cwd);
}

function runCommand(command, cwd) {
  return collectOutput(command, [], { cwd, shell: true });
}

function clipThinking(text) {
  const value = String(text || "");
  return value.length > 12000 ? `${value.slice(0, 12000)}\n…` : value;
}

function clip(text) {
  const value = String(text || "");
  return value.length > 8000 ? `${value.slice(0, 8000)}\n…` : value;
}

function clipChange(artifact) {
  return {
    path: artifact.path,
    action: artifact.action,
    before: clipSide(artifact.before),
    after: clipSide(artifact.after),
    at: Date.now(),
  };
}

function clipSide(text) {
  if (text == null) return null;
  const value = String(text);
  return value.length > 4000 ? `${value.slice(0, 4000)}\n…` : value;
}

export function modeLabel(mode) {
  if (mode === "plan") return "计划";
  if (mode === "ask") return "仅问答";
  return "默认";
}
