import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "../server/index.mjs";

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-files-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "owb-files-box-"));
  const app = createServer({ dataDir });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address();
  return {
    workspace,
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
  return { status: response.status, data };
}

test("可以浏览、保存、重命名文件，冲突时不覆盖", async () => {
  const app = await start();
  try {
    const created = await post(app.base, "/api/file", { workspace: app.workspace, path: "notes/a.txt", content: "第一版" });
    assert.equal(created.status, 200);
    const file = await fetch(`${app.base}/api/file?workspace=${encodeURIComponent(app.workspace)}&path=notes/a.txt`).then((response) => response.json());
    assert.equal(file.content, "第一版");
    const conflict = await post(app.base, "/api/file", {
      workspace: app.workspace,
      path: "notes/a.txt",
      content: "覆盖",
      mtimeMs: file.mtimeMs - 10000,
    });
    assert.equal(conflict.status, 409);
    assert.equal(fs.readFileSync(path.join(app.workspace, "notes", "a.txt"), "utf8"), "第一版");
    const moved = await post(app.base, "/api/move", { workspace: app.workspace, from: "notes/a.txt", to: "notes/b.txt" });
    assert.equal(moved.status, 200);
    const tree = await fetch(`${app.base}/api/tree?workspace=${encodeURIComponent(app.workspace)}`).then((response) => response.json());
    assert.match(JSON.stringify(tree.tree), /b\.txt/);
    const removed = await fetch(`${app.base}/api/file?workspace=${encodeURIComponent(app.workspace)}&path=.`, { method: "DELETE" });
    const removedBody = await removed.json();
    assert.equal(removed.ok, false);
    assert.match(removedBody.error, /不能删除/);
  } finally {
    await app.close();
  }
});

test("上传的附件会进入工作区，并写进任务", async () => {
  const app = await start();
  try {
    const uploaded = await fetch(`${app.base}/api/upload?workspace=${encodeURIComponent(app.workspace)}&name=材料.txt`, {
      method: "POST",
      body: Buffer.from("青石材料"),
    });
    const uploadBody = await uploaded.json();
    assert.equal(uploaded.status, 200);
    assert.equal(uploadBody.path, "inbox/材料.txt");
    const created = await post(app.base, "/api/tasks", {
      workspace: app.workspace,
      mode: "ask",
      text: "读取 inbox/材料.txt",
      attachments: [uploadBody.path],
    });
    assert.equal(created.status, 200);
    let task = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await fetch(`${app.base}/api/state`).then((response) => response.json());
      task = state.tasks.find((item) => item.id === created.data.id);
      if (task && task.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.match(task.messages[0].content, /附件：/);
    assert.match(task.messages.at(-1).content, /青石材料/);
  } finally {
    await app.close();
  }
});

test("终端拒绝破坏性命令，可以运行工作区内的普通命令", async () => {
  const app = await start();
  try {
    const blocked = await post(app.base, "/api/terminal", { workspace: app.workspace, command: "format C:" });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /不在本地执行范围/);
    const ran = await post(app.base, "/api/terminal", { workspace: app.workspace, command: "node -e \"console.log(7)\"" });
    assert.equal(ran.status, 200);
    assert.equal(ran.code ?? ran.data.code, 0);
    assert.match(ran.data.output, /7/);
  } finally {
    await app.close();
  }
});
