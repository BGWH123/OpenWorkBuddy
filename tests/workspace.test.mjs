import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importFile, listFiles, readText, resolveInside, searchText, setExtraRoots, writeText } from "../server/workspace.mjs";

function makeRoot() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ws-"));
  const root = path.join(parent, "box");
  fs.mkdirSync(root);
  return { parent, root };
}

test("文件操作不能离开工作区", () => {
  const { parent, root } = makeRoot();
  assert.throws(() => resolveInside(root, "../outside.txt"), /超出工作区/);
  assert.throws(() => writeText(root, "../outside.txt", "no"), /超出工作区/);
  assert.throws(() => writeText(root, "C:\\Windows\\Temp\\outside.txt", "no"), /工作区/);
  assert.equal(fs.existsSync(path.join(parent, "outside.txt")), false);
});

test("可以写入、读取、列出和搜索工作区文件", () => {
  const { root } = makeRoot();
  fs.writeFileSync(path.join(root, "MEMORY.md"), "项目代号青石\n", "utf8");
  const written = writeText(root, "output/hello.md", "OpenWorkBuddy");
  assert.equal(written.action, "created");
  assert.equal(readText(root, "output/hello.md"), "OpenWorkBuddy");
  const again = writeText(root, "output/hello.md", "再次");
  assert.equal(again.action, "modified");
  assert.equal(again.before, "OpenWorkBuddy");
  const items = listFiles(root);
  assert.ok(items.includes("MEMORY.md"));
  assert.ok(items.includes("output/hello.md"));
  assert.match(searchText(root, "青石").join("\n"), /MEMORY\.md:1:/);
});

test("已允许的目录可以写入绝对路径", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "owb-extra-"));
  const root = path.join(parent, "box");
  const outside = path.join(parent, "workcode");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  setExtraRoots([outside]);
  try {
    const written = writeText(root, path.join(outside, "note.txt"), "可以写到外面");
    assert.equal(fs.readFileSync(path.join(outside, "note.txt"), "utf8"), "可以写到外面");
    assert.equal(written.path, path.join(outside, "note.txt"));
  } finally {
    setExtraRoots([]);
  }
});

test("导入文件会复制到 inbox", () => {
  const { parent, root } = makeRoot();
  const source = path.join(parent, "来源.txt");
  fs.writeFileSync(source, "外部材料", "utf8");
  const relative = importFile(root, source);
  assert.equal(relative, "inbox/来源.txt");
  assert.equal(readText(root, relative), "外部材料");
});
