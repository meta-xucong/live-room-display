import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "live-room.sqlite"));
db.exec(`CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
)`);

const nameIndex = process.argv.indexOf("--name");
const name = nameIndex >= 0 ? process.argv[nameIndex + 1]?.trim() : "";
if (!name || name.length > 80 || /[\r\n]/.test(name)) {
  console.error("用法：npm run create-api-token -- --name <用途名称（最多 80 字符）>");
  db.close();
  process.exit(2);
}

const id = randomBytes(16).toString("hex");
const token = `lrd_live_${randomBytes(32).toString("base64url")}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
db.prepare("INSERT INTO api_tokens(id,name,token_hash,created_at) VALUES (?,?,?,?)").run(id, name, tokenHash, Date.now());
db.close();
console.log(`已创建 API 密钥：${name}`);
console.log(`密钥 ID：${id}`);
console.log("API 密钥（只显示这一次，请立即保存）：");
console.log(token);
