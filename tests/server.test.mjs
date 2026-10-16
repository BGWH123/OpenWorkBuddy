import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "../server/index.mjs";

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "owb-box-"));
  const app = createServer({ dataDir });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address();
  return {
    workspace,
    dataDir,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => app.server.close(resolve));
    },
  };
}

async function post(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function waitTask(base, id) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await fetch(`${base}/api/state`).then((response) => response.json());
    const task = state.tasks.find((item) => item.id === id);
    if (task && task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`任务超时 ${id}`);
}

test("默认模式写文件，仅问答不写，计划要确认后才写", async () => {
  const app = await start();
  try {
    const created = await post(app.base, "/api/tasks", {
      workspace: app.workspace,
      mode: "agent",
      text: "创建一个文件 output/hello.md，内容是 OpenWorkBuddy",
    });
    const done = await waitTask(app.base, created.id);
    assert.equal(done.status, "idle");
    assert.equal(fs.readFileSync(path.join(app.workspace, "output", "hello.md"), "utf8"), "OpenWorkBuddy");

    const asked = await post(app.base, "/api/tasks", {
      workspace: app.workspace,
      mode: "ask",
      text: "创建一个文件 output/nope.txt，内容是 nope",
    });
    const askDone = await waitTask(app.base, asked.id);
    assert.match(askDone.messages.at(-1).content, /仅问答/);
    assert.equal(fs.existsSync(path.join(app.workspace, "output", "nope.txt")), false);

    const planned = await post(app.base, "/api/tasks", {
      workspace: app.workspace,
      mode: "plan",
      text: "创建一个文件 output/plan.txt，内容是 尚未执行",
    });
    const waiting = await waitTask(app.base, planned.id);
    assert.equal(waiting.status, "awaiting_confirm");
    assert.match(waiting.messages.at(-1).content, /未确认前不会修改文件/);
    assert.equal(fs.existsSync(path.join(app.workspace, "output", "plan.txt")), false);
    await post(app.base, `/api/tasks/${planned.id}/confirm`);
    const confirmed = await waitTask(app.base, planned.id);
    assert.equal(confirmed.status, "idle");
    assert.equal(fs.readFileSync(path.join(app.workspace, "output", "plan.txt"), "utf8"), "尚未执行");
  } finally {
    await app.close();
  }
});

test("两个任务可以各自完成，设置接口不回传密钥", async () => {
  const app = await start();
  try {
    const [first, second] = await Promise.all([
      post(app.base, "/api/tasks", { workspace: app.workspace, mode: "agent", text: "创建一个文件 output/a.txt，内容是 A" }),
      post(app.base, "/api/tasks", { workspace: app.workspace, mode: "agent", text: "创建一个文件 output/b.txt，内容是 B" }),
    ]);
    await Promise.all([waitTask(app.base, first.id), waitTask(app.base, second.id)]);
    assert.equal(fs.readFileSync(path.join(app.workspace, "output", "a.txt"), "utf8"), "A");
    assert.equal(fs.readFileSync(path.join(app.workspace, "output", "b.txt"), "utf8"), "B");

    const saved = await post(app.base, "/api/settings", {
      provider: "openai",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "mock-model",
      apiKey: "secret-value",
    });
    assert.equal(saved.settings.hasApiKey, true);
    assert.equal(saved.settings.model, "mock-model");
    assert.equal(Object.hasOwn(saved.settings, "apiKey"), false);
    const stored = JSON.parse(fs.readFileSync(path.join(app.dataDir, "state.json"), "utf8"));
    assert.equal(stored.settings.apiKey, "secret-value");
  } finally {
    await app.close();
  }
});
