import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectEntries } from "../client/drop-read.mjs";
import { saveUpload } from "../server/workspace.mjs";

test("文件夹条目会按相对路径展开", async () => {
  const file = (name, text) => ({
    name,
    isFile: true,
    isDirectory: false,
    file: (ok) => ok({ name, text }),
  });
  const dir = (name, children) => ({
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      const batches = [children, []];
      return { readEntries: (ok) => ok(batches.shift() || []) };
    },
  });
  const found = await collectEntries([dir("资料", [file("a.txt", "A"), dir("内层", [file("b.txt", "B")])])]);
  assert.deepEqual(found.map((item) => item.relativePath), ["资料/a.txt", "资料/内层/b.txt"]);
});

test("上传可以按文件夹路径写入", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-folder-"));
  const saved = saveUpload(root, "a.txt", Buffer.from("甲"), "资料/内层/a.txt");
  assert.equal(saved, "inbox/资料/内层/a.txt");
  assert.equal(fs.readFileSync(path.join(root, "inbox", "资料", "内层", "a.txt"), "utf8"), "甲");
});
