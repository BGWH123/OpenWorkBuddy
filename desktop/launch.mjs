import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/index.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4186);

const browsers = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function findBrowser() {
  return browsers.find((candidate) => fs.existsSync(candidate)) || "";
}

async function alreadyRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function openWindow(url) {
  const browser = findBrowser();
  if (!browser) throw new Error("没有找到 Edge 或 Chrome，无法打开应用窗口");
  const profile = path.join(appRoot, "data", "window-profile");
  fs.mkdirSync(profile, { recursive: true });
  return spawn(browser, [
    `--app=${url}`,
    "--new-window",
    `--user-data-dir=${profile}`,
    "--disable-extensions",
    "--window-size=1440,900",
  ], { stdio: "ignore" });
}

const owned = !(await alreadyRunning());
let server = null;
if (owned) {
  const app = createServer();
  server = app.server;
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

const windowProcess = openWindow(`http://127.0.0.1:${port}/`);
process.stdout.write("OpenWorkBuddy 窗口已打开\n");
windowProcess.on("exit", () => {
  if (owned) server?.close();
  process.exit(0);
});
