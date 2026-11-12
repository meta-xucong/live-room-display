import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "live-room.sqlite"));
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')), enabled INTEGER NOT NULL DEFAULT 1
)`);

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function hiddenPrompt(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      reject(new Error("请在交互式终端运行，以便安全输入密码"));
      return;
    }
    let value = "";
    process.stdout.write(label);
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          reject(new Error("已取消"));
          return;
        }
        if (character === "\r" || character === "\n") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\b" || character === "\u007f") {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (character >= " ") {
          value += character;
          process.stdout.write("•");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

const username = option("--username").trim();
const role = option("--role");
if (!username || !["admin", "viewer"].includes(role)) {
  console.error("用法：npm run create-user -- --username <账号> --role admin|viewer");
  process.exitCode = 2;
} else {
  try {
    if (username.length > 80) throw new Error("账号长度不能超过 80 个字符");
    if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw new Error("该账号已存在");
    const password = await hiddenPrompt("输入初始密码（至少 12 位）：");
    if (password.length < 12) throw new Error("密码至少需要 12 位");
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex");
    const id = randomBytes(16).toString("hex");
    db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES (?,?,?,?)").run(id, username, `scrypt$${salt}$${hash}`, role);
    console.log(`已创建${role === "admin" ? "管理员" : "普通用户"}账号：${username}`);
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}

db.close();
