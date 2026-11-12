import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(project, "dist");
const rooms = JSON.parse(await fs.readFile(path.join(project, "src", "rooms.json"), "utf8"));
const css = await fs.readFile(path.join(project, "src", "styles.css"), "utf8");
const script = await fs.readFile(path.join(project, "public", "live-room-demo.js"), "utf8");
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f7fa">
  <title>直播间信息展示示例</title>
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script>window.LIVE_ROOMS=${JSON.stringify(rooms)};</script>
  <script>${script}</script>
</body>
</html>
`;
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "直播间信息展示示例.html"), html, "utf8");
console.log("Generated dist/直播间信息展示示例.html");
