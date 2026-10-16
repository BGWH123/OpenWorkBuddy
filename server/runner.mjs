import { randomUUID } from "node:crypto";
import { buildSystem, completeWithOpenAI, executeTool, modeLabel, runAgent, toolsForMode } from "./agent.mjs";
import { loadHarnessSettings } from "./harness.mjs";
import { findExpert, findSkill } from "./catalog.mjs";
import { localComplete, localPlan } from "./local-agent.mjs";
import { findTask } from "./store.mjs";
import { readContext, setExtraRoots } from "./workspace.mjs";

const runs = new Map();

export function createTaskRecord({ workspace, text, mode, expertId, skillId }) {
  const now = Date.now();
  return {
    id: randomUUID(),
    title: clipTitle(text),
    workspace,
    mode: normalizeMode(mode),
    phase: "idle",
    status: "idle",
    error: "",
    expertId: expertId || "",
    skillId: skillId || "",
    pendingText: "",
    goal: text,
    createdAt: now,
    updatedAt: now,
    messages: [],
    artifacts: [],
    changes: [],
  };
}

export function enqueueMessage(store, taskId, { text, mode, expertId, skillId, attachments }) {
  return store.update((state) => {
    const task = findTask(state, taskId);
    if (!task) throw httpError(404, "找不到这个任务");
    if (task.status === "running" || task.status === "awaiting_tool") throw httpError(409, "这个任务还在执行");
    const spoken = String(text || "").trim();
    const files = [...new Set((Array.isArray(attachments) ? attachments : []).map((item) => String(item || "").trim()).filter(Boolean))];
    const content = [spoken, files.length ? `附件：\n${files.map((file) => `- ${file}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
    if (!content) throw httpError(400, "请先写任务内容");
    task.mode = normalizeMode(mode || task.mode);
    if (expertId !== undefined) task.expertId = expertId || "";
    if (skillId !== undefined) task.skillId = skillId || "";
    task.goal = spoken || content;
    task.error = "";
    task.messages.push({ role: "user", content, attachments: files, at: Date.now() });
    if (task.mode === "plan") {
      task.phase = "planning";
      task.pendingText = content;
    } else {
      task.phase = "idle";
      task.pendingText = "";
    }
    task.status = "running";
    task.updatedAt = Date.now();
    if (task.title === "未命名任务") task.title = clipTitle(content);
    return state;
  });
}

export function confirmTask(store, taskId) {
  return store.update((state) => {
    const task = findTask(state, taskId);
    if (!task) throw httpError(404, "找不到这个任务");
    if (task.status === "running") throw httpError(409, "这个任务还在执行");
    if (task.status !== "awaiting_confirm") throw httpError(400, "当前没有待确认的方案");
    task.phase = "executing";
    task.status = "running";
    task.error = "";
    task.messages.push({ role: "user", content: "确认执行上一份方案。", at: Date.now() });
    task.updatedAt = Date.now();
    return state;
  });
}

export function launchTask(store, taskId, deps = {}) {
  if (runs.has(taskId)) return runs.get(taskId);
  const job = executeTask(store, taskId, deps).finally(() => runs.delete(taskId));
  runs.set(taskId, job);
  return job;
}

async function executeTask(store, taskId, deps) {
  try {
    const initial = findTask(store.snapshot(), taskId);
    if (!initial) return;
    const meta = taskMeta(initial);
    if (initial.mode === "plan" && initial.phase === "planning") {
      const plan = await createPlan(store.snapshot().settings, initial, meta, deps.fetchImpl, publishThinking(store, taskId));
      await store.update((state) => {
        const task = findTask(state, taskId);
        if (!task) return state;
        task.messages.push({ role: "assistant", content: plan.content, thinking: plan.thinking, at: Date.now() });
        task.liveThinking = "";
        task.status = "awaiting_confirm";
        task.phase = "planning";
        task.updatedAt = Date.now();
        return state;
      });
      return;
    }
    await runTurn(store, taskId, deps, initial.messages);
  } catch (error) {
    await store.update((state) => {
      const task = findTask(state, taskId);
      if (!task) return state;
      task.status = "error";
      task.liveThinking = "";
      task.error = error instanceof Error ? error.message : "执行失败";
      task.messages.push({ role: "assistant", content: `执行失败：${task.error}`, at: Date.now() });
      task.updatedAt = Date.now();
      return state;
    });
  }
}

export async function answerTool(store, taskId, { decision, answer }, deps = {}) {
  const current = findTask(store.snapshot(), taskId);
  if (!current || current.status !== "awaiting_tool" || !current.pendingTool) {
    throw httpError(400, "当前没有等待处理的操作");
  }
  const pending = current.pendingTool;
  const executed = decision === "allow" && pending.kind !== "question"
    ? await executeTool(pending.toolCall, current.workspace, null, { skipAsk: true, todos: current.todos || [] })
    : { text: decision === "allow" ? (String(answer || "").trim() || "用户没有填写回答。") : "用户拒绝了这个操作。" };
  const transcript = [
    ...current.messages,
    {
      role: "tool",
      toolName: pending.toolCall.name,
      toolCallId: pending.toolCall.id,
      content: executed.text || "",
      artifact: executed.artifact ? { path: executed.artifact.path, action: executed.artifact.action } : null,
      change: executed.artifact ? {
        path: executed.artifact.path,
        action: executed.artifact.action,
        before: executed.artifact.before ?? null,
        after: executed.artifact.after ?? null,
        at: Date.now(),
      } : null,
      todos: executed.todos || null,
      at: Date.now(),
    },
  ];
  await store.update((state) => {
    const task = findTask(state, taskId);
    if (!task) return state;
    applyTranscript(task, transcript);
    task.pendingTool = null;
    task.status = "running";
    return state;
  });
  launchTask(store, taskId, { ...deps, transcript });
  return findTask(store.snapshot(), taskId);
}

async function runTurn(store, taskId, deps, messages) {
  const initial = findTask(store.snapshot(), taskId);
  if (!initial) return;
  const executing = initial.mode === "plan" && initial.phase === "executing";
  const tools = toolsForMode(initial.mode, executing);
  const instruction = executing ? initial.pendingText : initial.goal;
  const provider = createProvider(store.snapshot().settings, {
    instruction,
    expert: taskMeta(initial).expert,
    skill: taskMeta(initial).skill,
    lastArtifact: initial.artifacts?.at(-1)?.path || "",
  }, initial, executing, deps.fetchImpl, publishThinking(store, taskId));
  const settings = loadHarnessSettings(initial.workspace);
  setExtraRoots(store.snapshot().settings.extraDirectories || []);
  const result = await runAgent({
    messages,
    tools,
    provider,
    workspace: initial.workspace,
    context: {
      permit: deps.permit !== false,
      mode: initial.mode,
      executing,
      settings,
      todos: initial.todos || [],
      depth: 0,
      runNested: (prompt) => runNested(initial, prompt, deps),
    },
  });
  const transcript = Array.isArray(result) ? result : result.transcript;
  const pause = Array.isArray(result) ? null : result.pause;
  await store.update((state) => {
    const task = findTask(state, taskId);
    if (!task) return state;
    applyTranscript(task, transcript);
    task.liveThinking = "";
    if (!Array.isArray(result) && result.todos) task.todos = result.todos;
    if (pause) {
      task.pendingTool = { toolCall: pause.toolCall, reason: pause.reason, kind: pause.kind || "permission" };
      task.status = "awaiting_tool";
    } else {
      task.pendingTool = null;
      task.status = "idle";
      task.phase = "idle";
    }
    task.updatedAt = Date.now();
    return state;
  });
}

async function runNested(task, prompt, deps) {
  const executing = task.mode === "plan" && task.phase === "executing";
  const tools = toolsForMode(task.mode, executing).filter((tool) => tool.name !== "Agent");
  const provider = createProvider(deps.settings || { provider: "local" }, {
    instruction: prompt,
    expert: null,
    skill: null,
    lastArtifact: "",
  }, task, executing, deps.fetchImpl);
  const result = await runAgent({
    messages: [{ role: "user", content: prompt }],
    tools,
    provider,
    workspace: task.workspace,
    maxSteps: 4,
    context: {
      permit: true,
      skipAsk: true,
      mode: task.mode,
      executing,
      settings: loadHarnessSettings(task.workspace),
      depth: 1,
      todos: [],
    },
  });
  const transcript = Array.isArray(result) ? result : result.transcript;
  return transcript.filter((message) => message.role === "assistant" && message.content).map((message) => message.content).at(-1) || "子代理没有结论。";
}

function applyTranscript(task, transcript) {
  const artifacts = new Map((task.artifacts || []).map((item) => [item.path, item]));
  for (const message of transcript) {
    if (message.artifact) artifacts.set(message.artifact.path, message.artifact);
    if (message.change) task.changes.push(message.change);
    if (message.todos) task.todos = message.todos;
  }
  task.artifacts = [...artifacts.values()];
  task.messages = transcript.map(({ change, todos, ...message }) => message);
  task.updatedAt = Date.now();
}

function createProvider(settings, meta, task, executing, fetchImpl, onUpdate) {
  const system = buildSystem({
    mode: task.mode,
    executing,
    workspace: task.workspace,
    expert: meta.expert,
    skill: meta.skill,
    context: readContext(task.workspace),
    extraDirectories: settings.extraDirectories || [],
  });
  if (settings.provider === "openai") {
    return (messages, tools) => completeWithOpenAI({ settings, messages, tools, system, fetchImpl, onUpdate });
  }
  return (messages, tools) => Promise.resolve(localComplete(messages, tools, meta));
}

function publishThinking(store, taskId) {
  let last = "";
  return (partial) => {
    const thinking = String(partial?.thinking || "");
    const answered = Boolean(String(partial?.content || "").trim()) || (partial?.toolCalls || []).some((call) => call.name);
    const next = answered ? "" : thinking;
    if (next === last) return;
    last = next;
    store.update((state) => {
      const task = findTask(state, taskId);
      if (!task || task.status !== "running") return state;
      task.liveThinking = next;
      task.updatedAt = Date.now();
      return state;
    }).catch(() => {});
  };
}

async function createPlan(settings, task, meta, fetchImpl, onUpdate) {
  if (settings.provider !== "openai") return { content: localPlan(task.pendingText || task.goal, meta), thinking: "" };
  const system = buildSystem({
    mode: "plan",
    executing: false,
    workspace: task.workspace,
    expert: meta.expert,
    skill: meta.skill,
    context: readContext(task.workspace),
    extraDirectories: settings.extraDirectories || [],
  });
  const result = await completeWithOpenAI({
    settings,
    messages: task.messages,
    tools: [],
    system,
    fetchImpl,
    onUpdate,
  });
  return {
    content: result.content || localPlan(task.pendingText || task.goal, meta),
    thinking: result.thinking || "",
  };
}

function taskMeta(task) {
  return {
    expert: findExpert(task.workspace, task.expertId),
    skill: findSkill(task.workspace, task.skillId),
  };
}

export function publicTask(task) {
  return {
    ...task,
    modeLabel: modeLabel(task.mode),
    messages: task.messages.map(({ change, ...message }) => message),
  };
}

export function clipTitle(text) {
  const line = String(text || "").trim().split(/\r?\n/)[0] || "未命名任务";
  return [...line].slice(0, 32).join("") || "未命名任务";
}

export function normalizeMode(mode) {
  if (mode === "plan" || mode === "ask") return mode;
  return "agent";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
