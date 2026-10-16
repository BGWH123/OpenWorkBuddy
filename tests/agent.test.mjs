import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completeWithOpenAI, executeTool, runAgent, toolsForMode } from "../server/agent.mjs";
import { localComplete, localPlan } from "../server/local-agent.mjs";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "owb-agent-"));
}

test("仅问答不会因为明确的写入要求而改文件", () => {
  const result = localComplete([], toolsForMode("ask", false), {
    instruction: "创建一个文件 output/nope.txt，内容是 nope",
  });
  assert.equal(result.toolCalls, undefined);
  assert.match(result.content, /仅问答/);
});

test("默认模式按要求写入文件，并在下一步给出结果", async () => {
  const root = workspace();
  const first = localComplete([], toolsForMode("agent", true), {
    instruction: "创建一个文件 output/hello.md，内容是 OpenWorkBuddy",
  });
  assert.equal(first.toolCalls[0].name, "Write");
  const executed = await executeTool(first.toolCalls[0], root, new Set(["Write"]));
  assert.equal(fs.readFileSync(path.join(root, "output", "hello.md"), "utf8"), "OpenWorkBuddy");
  const second = localComplete([
    { role: "user", content: "创建一个文件 output/hello.md，内容是 OpenWorkBuddy" },
    { role: "tool", toolName: "Write", content: executed.text },
  ], toolsForMode("agent", true), {
    instruction: "创建一个文件 output/hello.md，内容是 OpenWorkBuddy",
  });
  assert.match(second.content, /output\/hello\.md/);
});

test("计划文案本身不包含已经执行的说法", () => {
  const plan = localPlan("整理会议记录", { expert: { name: "研究员" }, skill: { name: "文档" } });
  assert.match(plan, /未确认前不会修改文件/);
  assert.match(plan, /研究员/);
});

test("当前模式拒绝不被允许的写入", async () => {
  const root = workspace();
  let calls = 0;
  const transcript = await runAgent({
    messages: [{ role: "user", content: "写进去" }],
    tools: toolsForMode("ask", false),
    workspace: root,
    provider: async () => {
      calls += 1;
      if (calls === 1) {
        return { toolCalls: [{ id: "x", name: "write_file", arguments: { path: "output/evil.txt", content: "no" } }] };
      }
      return { content: "停" };
    },
  });
  assert.equal(fs.existsSync(path.join(root, "output", "evil.txt")), false);
  assert.match(transcript.map((item) => item.content).join("\n"), /已拒绝 write_file/);
});

test("危险命令不会被执行", async () => {
  const root = workspace();
  const result = await executeTool(
    { id: "c", name: "run_command", arguments: { command: "format C:" } },
    root,
    new Set(["run_command"]),
  );
  assert.match(result.text, /不在本地执行范围/);
});

test("文件整理技能先列出再写入目录说明", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "笔记.md"), "材料", "utf8");
  const skill = { id: "file-organize", name: "文件整理" };
  const listed = localComplete([], toolsForMode("agent", true), { instruction: "整理当前文件夹", skill });
  assert.equal(listed.toolCalls[0].name, "Glob");
  const listing = await executeTool(listed.toolCalls[0], root, new Set(["Glob"]));
  const write = localComplete([
    { role: "user", content: "整理当前文件夹" },
    { role: "tool", toolName: "Glob", content: listing.text },
  ], toolsForMode("agent", true), { instruction: "整理当前文件夹", skill });
  assert.equal(write.toolCalls[0].arguments.path, "output/目录说明.md");
  assert.match(write.toolCalls[0].arguments.content, /笔记\.md/);
});

test("专家团交付稿按角色分节", () => {
  const result = localComplete([], toolsForMode("agent", true), {
    instruction: "写一份说明",
    expert: { name: "报告小组", kind: "team", members: ["调研", "写作", "校对"], summary: "顺序完成" },
  });
  assert.match(result.toolCalls[0].arguments.content, /## 校对/);
  assert.equal(result.toolCalls[0].arguments.path, "output/交付.md");
});

test("外部模型的工具调用可以落到工作区", async () => {
  const root = workspace();
  let step = 0;
  const fetchImpl = async () => {
    step += 1;
    const message = step === 1
      ? { tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "output/ai.txt", content: "from-model" }) } }] }
      : { content: "已完成" };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
  };
  const transcript = await runAgent({
    messages: [{ role: "user", content: "写一个文件" }],
    tools: toolsForMode("agent", true),
    workspace: root,
    provider: (messages, tools) => completeWithOpenAI({
      settings: { apiKey: "test-key", baseUrl: "http://127.0.0.1:9/v1", model: "mock" },
      messages,
      tools,
      system: "测试",
      fetchImpl,
    }),
  });
  assert.equal(fs.readFileSync(path.join(root, "output", "ai.txt"), "utf8"), "from-model");
  assert.match(transcript.at(-1).content, /已完成/);
});

test("流式响应会先交出思考，回答开始后不再把它当作进行中", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"2"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const seen = [];
  const result = await completeWithOpenAI({
    settings: { apiKey: "test-key", baseUrl: "http://127.0.0.1:9/v1", model: "mock" },
    messages: [{ role: "user", content: "1+1" }],
    tools: [],
    system: "测试",
    onUpdate: (partial) => seen.push(partial),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader() {
          let index = 0;
          return {
            async read() {
              if (index >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: new TextEncoder().encode(chunks[index++]) };
            },
          };
        },
      },
    }),
  });
  assert.equal(result.thinking, "先想");
  assert.equal(result.content, "2");
  assert.equal(seen[0].thinking, "先想");
  assert.equal(seen.at(-1).content, "2");
});
