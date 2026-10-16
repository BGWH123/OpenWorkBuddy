import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { createServer } from "../server/index.mjs";

const edge = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => fs.existsSync(candidate));
if (!edge) throw new Error("没有找到 Microsoft Edge，无法做界面验证");

const shots = path.join("Z:\\OpenWorkBuddy", "docs", "screenshots");
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ui-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ui-box-"));
const app = createServer({ dataDir });
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const port = app.server.address().port;
const browser = await puppeteer.launch({
  executablePath: edge,
  headless: true,
  args: ["--disable-gpu", "--font-render-hinting=none"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") {
    const location = message.location();
    errors.push(`${message.text()} ${location?.url || ""}`.trim());
  }
});

async function clickButton(label) {
  const clicked = await page.evaluate((text) => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text && !item.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`没有可点击的按钮：${label}`);
}

async function shot(name) {
  await page.screenshot({ path: path.join(shots, name), fullPage: true });
}

try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("h1");
  const title = await page.$eval("h1", (element) => element.textContent);
  if (title !== "OpenWorkBuddy") throw new Error(`标题不对：${title}`);
  await page.type("input[aria-label='工作区路径']", workspace);
  await Promise.all([
    page.waitForSelector("textarea[aria-label='任务内容']"),
    clickButton("打开工作区"),
  ]);
  await shot("01-workspace.png");

  await page.type("textarea[aria-label='任务内容']", "创建一个文件 output/hello.md，内容是 OpenWorkBuddy");
  await clickButton("开始执行");
  await page.waitForFunction(() => document.body.textContent.includes("已写入") && document.body.textContent.includes("output/hello.md"), { timeout: 15000 });
  await clickButton("产物");
  await page.waitForSelector("[data-testid=artifact]");
  await page.click("[data-testid=artifact]");
  await page.waitForFunction(() => document.querySelector("[data-testid=preview]")?.textContent?.includes("OpenWorkBuddy"), { timeout: 10000 });
  await clickButton("变更");
  await page.waitForFunction(() => document.querySelector("[data-testid=diff]")?.textContent?.includes("OpenWorkBuddy"), { timeout: 10000 });
  await clickButton("文件");
  await page.waitForSelector("[data-testid=file-tree]");
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll("[data-testid=file-tree] button")].find((item) => item.textContent.trim() === "hello.md");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  if (!opened) throw new Error("文件树里没有 hello.md");
  await page.waitForFunction(() => {
    const editor = document.querySelector("textarea[aria-label='文件内容']");
    return editor instanceof HTMLTextAreaElement && editor.value === "OpenWorkBuddy";
  }, { timeout: 10000 });
  await shot("02-artifact.png");

  await clickButton("新建任务");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "开始执行" && !button.disabled));
  await clickButton("计划");
  await page.waitForSelector("button[data-mode=plan][aria-pressed=true]");
  await page.type("textarea[aria-label='任务内容']", "创建一个文件 output/plan.txt，内容是 尚未执行");
  await clickButton("开始执行");
  await page.waitForFunction(() => document.body.textContent.includes("未确认前不会修改文件"), { timeout: 10000 });
  if (fs.existsSync(path.join(workspace, "output", "plan.txt"))) throw new Error("确认前不应该写文件");
  await shot("03-plan.png");
  await clickButton("确认执行");
  await page.waitForFunction(() => document.body.textContent.includes("已写入"), { timeout: 15000 });
  const planText = fs.readFileSync(path.join(workspace, "output", "plan.txt"), "utf8");
  if (planText !== "尚未执行") throw new Error(`计划执行结果不对：${planText}`);

  await clickButton("新建任务");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "开始执行" && !button.disabled));
  await clickButton("仅问答");
  await page.waitForSelector("button[data-mode=ask][aria-pressed=true]");
  await page.type("textarea[aria-label='任务内容']", "工作区里有哪些文件");
  await clickButton("开始执行");
  await page.waitForFunction(() => {
    const text = document.body.textContent || "";
    return text.includes("工作区里有这些文件") && text.includes("output/hello.md") && text.includes("output/plan.txt");
  }, { timeout: 15000 });
  if (fs.existsSync(path.join(workspace, "output", "nope.txt"))) throw new Error("仅问答不应该写文件");
  await shot("04-ask.png");

  await page.setViewport({ width: 390, height: 844 });
  await page.waitForSelector("h1");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await shot("05-mobile.png");
  if (overflow > 1) throw new Error(`窄屏出现横向溢出：${overflow}px`);
  if (errors.length) throw new Error(errors.join("\n"));
  process.stdout.write("界面验证通过\n");
} catch (error) {
  await shot("failure.png").catch(() => {});
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => app.server.close(resolve));
}
