import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binarySource = path.join(root, "node_modules", "@esbuild", "win32-x64", "esbuild.exe");
const binaryTarget = path.join(os.tmpdir(), "openworkbuddy-esbuild.exe");
if (fs.existsSync(binarySource)) {
  fs.writeFileSync(binaryTarget, fs.readFileSync(binarySource));
  process.env.ESBUILD_BINARY_PATH = binaryTarget;
}
const esbuild = await import("esbuild");
const outdir = path.join(root, "client", "dist");
fs.mkdirSync(outdir, { recursive: true });
fs.copyFileSync(path.join(root, "client", "index.html"), path.join(outdir, "index.html"));
fs.copyFileSync(path.join(root, "client", "src", "styles.css"), path.join(outdir, "app.css"));

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["client/src/main.tsx"],
  bundle: true,
  outfile: path.join(outdir, "app.js"),
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: "var process = globalThis.process || { env: { NODE_ENV: 'production' } };" },
  logLevel: "info",
});
