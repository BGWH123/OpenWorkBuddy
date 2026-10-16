import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectOutput } from "../server/spawn.mjs";
import { decodeBuffer } from "../server/text.mjs";

test("GBK 字节会还原成中文，UTF-8 保持不变", () => {
  assert.equal(decodeBuffer(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), "你好");
  assert.equal(decodeBuffer(Buffer.from("会议结论", "utf8")), "会议结论");
});

test("命令输出里的中文不会变成乱码", async () => {
  const result = await collectOutput("python -c \"print('会议结论')\"", [], {
    cwd: os.tmpdir(),
    shell: true,
  });
  assert.equal(result.code, 0);
  assert.match(result.output, /会议结论/);
  assert.equal(result.output.includes("\uFFFD"), false);
  assert.equal(path.basename(os.tmpdir()).length > 0, true);
});
