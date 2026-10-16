import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTool } from "../server/agent.mjs";
import { loadHarnessSettings } from "../server/harness.mjs";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "owb-harness-"));
}

test("Edit 只替换指定原文", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "note.txt"), "hello world", "utf8");
  const result = await executeTool({
    name: "Edit",
    arguments: { path: "note.txt", old_string: "world", new_string: "there" },
  }, root, new Set(["Edit"]));
  assert.match(result.text, /已修改/);
  assert.equal(fs.readFileSync(path.join(root, "note.txt"), "utf8"), "hello there");
});

test("权限规则可以拒绝 Bash", async () => {
  const root = workspace();
  const result = await executeTool({
    name: "Bash",
    arguments: { command: "node -v" },
  }, root, new Set(["Bash"]), {
    permit: true,
    mode: "agent",
    executing: true,
    settings: { permissions: { allow: [], ask: [], deny: ["Bash(node:*)"] }, hooks: {} },
  });
  assert.match(result.text, /拒绝/);
});

test("PreToolUse 钩子可以拒绝写入", async () => {
  const root = workspace();
  const hookDir = path.join(root, ".openworkbuddy", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, "deny.mjs"), "process.exit(2);\n");
  fs.writeFileSync(path.join(root, ".openworkbuddy", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Write", command: ".openworkbuddy/hooks/deny.mjs" }] },
  }));
  const result = await executeTool({
    name: "Write",
    arguments: { path: "blocked.txt", content: "no" },
  }, root, new Set(["Write"]), {
    permit: true,
    mode: "agent",
    executing: true,
    settings: loadHarnessSettings(root),
  });
  assert.match(result.text, /拒绝/);
  assert.equal(fs.existsSync(path.join(root, "blocked.txt")), false);
});

test("任务清单可以新增和查看", async () => {
  const root = workspace();
  const todos = [];
  const created = await executeTool({
    name: "TaskCreate",
    arguments: { subject: "核对产物" },
  }, root, new Set(["TaskCreate"]), { todos });
  const listed = await executeTool({
    name: "TaskList",
    arguments: {},
  }, root, new Set(["TaskList"]), { todos: created.todos });
  assert.match(listed.text, /核对产物/);
});
