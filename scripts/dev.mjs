import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
const children = [
  spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "development", HOST: "127.0.0.1", PORT: "4174" },
  }),
  spawn(process.execPath, [viteCli, "--host", "127.0.0.1"], { cwd: root, stdio: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill();
  process.exitCode = code;
}
for (const child of children) child.on("exit", (code) => {
  if (!stopping && code !== 0) stop(code || 1);
});
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
