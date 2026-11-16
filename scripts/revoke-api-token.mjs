import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
const idIndex = process.argv.indexOf("--id");
const id = idIndex >= 0 ? process.argv[idIndex + 1]?.trim() : "";
if (!/^[a-f\d]{32}$/i.test(id)) {
  console.error("用法：npm run revoke-api-token -- --id <密钥 ID>");
  process.exit(2);
}

const db = new DatabaseSync(path.join(dataDir, "live-room.sqlite"));
const result = db.prepare("UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(Date.now(), id);
db.close();
if (!result.changes) {
  console.error("密钥不存在或已经撤销");
  process.exit(1);
}
console.log(`已撤销 API 密钥：${id}`);
