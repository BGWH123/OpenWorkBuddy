import { spawn } from "node:child_process";
import { decodeBuffer } from "./text.mjs";

function childEnv() {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

export function collectOutput(command, args = [], { cwd, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      windowsHide: true,
      env: childEnv(),
    });
    const chunks = [];
    let size = 0;
    let timer;
    const append = (chunk) => {
      size += chunk.length;
      if (size <= 80_000) chunks.push(chunk);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const finish = (code, extra = "") => {
      clearTimeout(timer);
      const output = `${decodeBuffer(Buffer.concat(chunks))}${extra}`.trim();
      resolve({ code, output });
    };
    timer = setTimeout(() => {
      child.kill();
      finish(-1, "\n命令超时");
    }, 15_000);
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", (error) => finish(-1, `\n${error.message}`));
  });
}
