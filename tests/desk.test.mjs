import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertInside, exportTaskMarkdown, listLibrary, openInExplorer, saveLibraryNote, taskNotices } from "../server/desk.mjs";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "owb-desk-"));
}

test("路径越界会被拒绝", () => {
  const root = makeRoot();
  assert.throws(() => assertInside(root, "../outside.txt"), /路径超出工作区/);
  assert.throws(() => assertInside(root, "foo/../../outside.txt"), /路径超出工作区/);
  assert.throws(() => assertInside(root, path.resolve(root, "..", "outside.txt")), /相对路径/);
  assert.throws(() => openInExplorer(root, "../outside.txt"), /路径超出工作区/);
  assert.throws(() => saveLibraryNote(root, "../secret", "不能写到外面"), /路径超出工作区/);
  assert.equal(fs.existsSync(path.join(root, "..", "outside.txt")), false);
});

test("导出任务会写成包含标题的 Markdown", () => {
  const root = makeRoot();
  const relative = exportTaskMarkdown(root, {
    title: "青石纪要",
    mode: "ask",
    status: "done",
    messages: [
      { role: "user", content: "整理范围，token: sk-abcdefghijklmnopqrstuvwxyz" },
      { role: "assistant", content: "已按现有材料整理", toolName: "read_file" },
    ],
    artifacts: [{ path: "output/纪要.md", action: "created" }],
  });
  assert.match(relative, /^output\/share-[a-z0-9-]+\.md$/);
  const text = fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");
  assert.match(text, /青石纪要/);
  assert.match(text, /仅问答/);
  assert.match(text, /已完成/);
  assert.match(text, /产物/);
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz/);
});

test("保存资料后可以在资料库中找到", () => {
  const root = makeRoot();
  const relative = saveLibraryNote(root, "会议记录", "今天确认了范围");
  assert.equal(relative, "资料/会议记录.md");
  const found = listLibrary(root).find((item) => item.path === relative);
  assert.ok(found);
  assert.equal(found.name, "会议记录.md");
  assert.equal(found.folder, "资料");
  assert.equal(fs.readFileSync(path.join(root, "资料", "会议记录.md"), "utf8"), "今天确认了范围");
});

test("任务通知包含待确认和已完成", () => {
  const notices = taskNotices([
    { id: "run", title: "仍在执行", status: "running", updatedAt: 300 },
    { id: "old", title: "待确认任务", status: "awaiting_confirm", updatedAt: 100 },
    { id: "new", title: "完成任务", status: "done", updatedAt: 200 },
  ]);
  assert.deepEqual(notices, [
    { id: "new", kind: "done", title: "完成任务", text: "任务已成功完成" },
    { id: "old", kind: "confirm", title: "待确认任务", text: "任务操作待您确认" },
  ]);
});
