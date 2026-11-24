import { createServer } from "node:http";
import { createReadStream, mkdirSync } from "node:fs";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseXlsx, cellHasFormula, cellValue } from "./server/xlsx.mjs";
import { NUMBERED_ROOM_CODES, normalizeStaffShifts, parseStaffSchedule, roomNameKey } from "./server/staff-schedule.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "live-room.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','viewer')), enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS mcp_previews (
    id TEXT PRIMARY KEY, token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    schedule_text TEXT NOT NULL, data_updated_at TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, sheet_name TEXT NOT NULL, sort_order INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_avatars (
    room_code TEXT PRIMARY KEY REFERENCES rooms(code) ON DELETE CASCADE,
    photo_type TEXT NOT NULL, photo_blob BLOB NOT NULL, version TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_aliases (
    name_key TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS staff_import_receipts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, result_json TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
    director TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '', assistant TEXT NOT NULL DEFAULT '',
    products_json TEXT NOT NULL DEFAULT '[]', sales_target_cents INTEGER, sales_target_text TEXT,
    notes TEXT NOT NULL DEFAULT '', photo_type TEXT, photo_blob BLOB
  );
  CREATE TABLE IF NOT EXISTS director_shifts (
    id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
    director TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS director_shifts_room_date_start ON director_shifts(room_code,date,starts_at);
  CREATE TABLE IF NOT EXISTS host_avatars (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
    photo_type TEXT, photo_blob BLOB, photo_hash TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deleted_host_avatar_names (name_key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO app_state(key, value) VALUES ('data_updated_at', '');
`);

const salesTextColumn = db.prepare("SELECT 1 FROM pragma_table_info('slots') WHERE name='sales_target_text'");
if (!salesTextColumn.get()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!salesTextColumn.get()) {
      db.exec("ALTER TABLE slots ADD COLUMN sales_target_text TEXT");
      db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(nextDataUpdatedAt());
    }
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const STAFF_PREVIEW_TTL = 10 * 60_000;
const staffPreviews = new Map();
const MCP_ROOM_BATCH_PREVIEW_PREFIX = "mcp-room-schedules-v1\n";
const sessions = db.prepare("SELECT s.token_hash,s.csrf_token,s.expires_at,u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND u.enabled=1");
const integrationTokens = db.prepare("SELECT id,name FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL");
const hostAvatarByNameKey = db.prepare("SELECT id,name,photo_type,updated_at FROM host_avatars WHERE name_key=?");
const hostAvatarById = db.prepare("SELECT id,name,photo_type,photo_blob,updated_at FROM host_avatars WHERE id=?");
const deletedHostAvatarByNameKey = db.prepare("SELECT 1 FROM deleted_host_avatar_names WHERE name_key=?");
const restoreHostAvatarName = db.prepare("DELETE FROM deleted_host_avatar_names WHERE name_key=?");
const failures = new Map();
const uploadWindows = new Map();
const integrationWindows = new Map();
const cookieName = "lrd_session";
const cookieSecure = process.env.NODE_ENV === "production" && process.env.SECURE_COOKIES !== "false";
const previewCleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, preview] of staffPreviews) if (preview.expiresAt <= now) staffPreviews.delete(id);
  try {
    db.prepare("DELETE FROM mcp_previews WHERE expires_at<=?").run(now);
    db.prepare("DELETE FROM staff_import_receipts WHERE expires_at<=?").run(now);
  } catch {}
}, 60_000);
previewCleanup.unref();

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  response.end(JSON.stringify(value));
}

function error(response, status, code, message, details = [], extraHeaders = {}) {
  json(response, status, { error: { code, message, details } }, extraHeaders);
}

function cookieValue(header, name) {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function hostNameKey(name) {
  return String(name ?? "").normalize("NFKC").trim().replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

function slotHostAvatar(slot, legacyPhoto = slot.photo_type) {
  const key = hostNameKey(slot.host);
  const avatar = hostAvatarByNameKey.get(key);
  const hasLegacyPhoto = !avatar && Boolean(legacyPhoto) && !deletedHostAvatarByNameKey.get(key);
  return { avatar, hasLegacyPhoto };
}

function imageTypeForBytes(bytes) {
  const buffer = Buffer.from(bytes ?? []);
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return "";
}

function seedUniqueHostAvatars(items) {
  const groups = new Map();
  for (const item of items) {
    const name = String(item.host ?? "").trim();
    const nameKey = hostNameKey(name);
    const bytes = item.photo?.bytes ?? item.photo_blob;
    const type = item.photo?.contentType ?? item.photo_type ?? imageTypeForBytes(bytes);
    if (!nameKey) continue;
    if (!groups.has(nameKey)) groups.set(nameKey, { name, photos: new Map() });
    if (bytes && type) {
      const photoHash = createHash("sha256").update(bytes).digest("hex");
      groups.get(nameKey).photos.set(photoHash, { type, bytes, photoHash });
    }
  }
  const now = Date.now();
  const insert = db.prepare(`INSERT OR IGNORE INTO host_avatars(
    id,name,name_key,photo_type,photo_blob,photo_hash,created_at,updated_at
  ) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM deleted_host_avatar_names WHERE name_key=?)`);
  for (const [nameKey, group] of groups) {
    const photo = group.photos.size === 1 ? group.photos.values().next().value : null;
    insert.run(randomBytes(16).toString("hex"), group.name, nameKey, photo?.type ?? null, photo?.bytes ?? null, photo?.photoHash ?? null, now, now, nameKey);
  }
}

function migrateLegacyHostAvatars() {
  const scheduleHosts = db.prepare("SELECT host,photo_type,photo_blob FROM slots WHERE host<>''").all();
  if (scheduleHosts.length) seedUniqueHostAvatars(scheduleHosts);
}

migrateLegacyHostAvatars();

function migrateLegacyDirectorShifts() {
  if (db.prepare("SELECT value FROM app_state WHERE key='independent_director_shifts_v1'").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT value FROM app_state WHERE key='independent_director_shifts_v1'").get()) {
      const rows = db.prepare(`SELECT room_code,date,start_time,end_time,starts_at,ends_at,director
        FROM slots WHERE TRIM(director)<>'' ORDER BY room_code,date,starts_at`).all();
      const insert = db.prepare(`INSERT INTO director_shifts(
        id,room_code,date,start_time,end_time,starts_at,ends_at,director
      ) VALUES (?,?,?,?,?,?,?,?)`);
      const grouped = new Map();
      for (const row of rows) {
        const key = `${row.room_code}\u0000${row.date}\u0000${row.director}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
      }
      for (const shifts of grouped.values()) {
        shifts.sort((a, b) => a.starts_at - b.starts_at);
        const merged = [];
        for (const shift of shifts) {
          const previous = merged.at(-1);
          if (previous && shift.starts_at <= previous.ends_at) {
            if (shift.ends_at > previous.ends_at) {
              previous.ends_at = shift.ends_at;
              previous.end_time = shift.end_time;
            }
          } else merged.push({ ...shift });
        }
        for (const shift of merged) insert.run(
          randomBytes(16).toString("hex"), shift.room_code, shift.date, shift.start_time, shift.end_time,
          shift.starts_at, shift.ends_at, shift.director,
        );
      }
      const updateAt = nextDataUpdatedAt();
      db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(updateAt);
      db.prepare("INSERT INTO app_state(key,value) VALUES ('independent_director_shifts_v1',?)")
        .run(new Date().toISOString());
    }
    db.exec("COMMIT");
  } catch (cause) {
    try { db.exec("ROLLBACK"); } catch {}
    throw cause;
  }
}

migrateLegacyDirectorShifts();

function authenticateIntegrationToken(authorization) {
  const match = authorization.match(/^Bearer\s+(lrd_live_[A-Za-z0-9_-]{43})$/);
  if (!match) return { status: 401, code: "API_TOKEN_REQUIRED", message: "请提供有效的 Bearer API 密钥" };
  const token = integrationTokens.get(hashToken(match[1]));
  if (!token) return { status: 401, code: "API_TOKEN_INVALID", message: "API 密钥无效或已撤销" };
  const now = Date.now();
  const window = integrationWindows.get(token.id);
  if (window && window.until > now && window.count >= 30) return { status: 429, code: "API_RATE_LIMIT", message: "接口调用过于频繁，请稍后重试" };
  integrationWindows.set(token.id, window?.until > now
    ? { count: window.count + 1, until: window.until }
    : { count: 1, until: now + 10 * 60_000 });
  db.prepare("UPDATE api_tokens SET last_used_at=? WHERE id=?").run(now, token.id);
  return { token };
}

function requireIntegrationToken(request, response) {
  const result = authenticateIntegrationToken(request.headers.authorization ?? "");
  if (result.token) return result.token;
  error(response, result.status, result.code, result.message);
  return null;
}

function userFor(request) {
  const raw = cookieValue(request.headers.cookie, cookieName);
  if (!raw) return null;
  const user = sessions.get(hashToken(raw));
  if (!user || user.expires_at < Date.now()) {
    if (user) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(user.token_hash);
    return null;
  }
  return user;
}

function requireUser(request, response, role) {
  const user = userFor(request);
  if (!user) {
    error(response, 401, "AUTH_REQUIRED", "请先登录");
    return null;
  }
  if (role && user.role !== role) {
    error(response, 403, "FORBIDDEN", "当前账号没有此操作权限");
    return null;
  }
  return user;
}

function csrfValid(request, user) {
  return Boolean(user && request.headers["x-csrf-token"] && request.headers["x-csrf-token"] === user.csrf_token);
}

function apiTokenLibraryPayload() {
  const tokens = db.prepare(`SELECT id,name,created_at,last_used_at,revoked_at
    FROM api_tokens ORDER BY created_at DESC`).all().map((item) => ({
    id: item.id,
    name: item.name,
    createdAt: new Date(item.created_at).toISOString(),
    lastUsedAt: item.last_used_at ? new Date(item.last_used_at).toISOString() : null,
    revokedAt: item.revoked_at ? new Date(item.revoked_at).toISOString() : null,
  }));
  return { tokens };
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("上传内容过大"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request) {
  const body = await readBody(request, 1024 * 1024);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求内容格式错误"), { status: 400 });
  }
}

async function readUpload(request) {
  const contentType = request.headers["content-type"] ?? "";
  const boundaryMatch = contentType.match(/multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundaryMatch) throw Object.assign(new Error("请用表单上传 .xlsx 文件"), { status: 400 });
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
  const body = await readBody(request, 30 * 1024 * 1024);
  let file = null;
  let roomBindings = null;
  let cursor = 0;
  while (true) {
    const start = body.indexOf(boundary, cursor);
    if (start < 0) break;
    const headerStart = start + boundary.length + 2;
    if (body.subarray(start + boundary.length, start + boundary.length + 2).equals(Buffer.from("--"))) break;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const headers = body.subarray(headerStart, headerEnd).toString("latin1");
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] ?? "";
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const dataEnd = next >= 2 && body.subarray(next - 2, next).toString() === "\r\n" ? next - 2 : next;
    const name = disposition.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1];
    const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1] ?? "";
    if (name === "file" && filename) {
      if (file) throw Object.assign(new Error("每次只能上传一个工作簿"), { status: 400 });
      file = body.subarray(headerEnd + 4, dataEnd);
      if (!filename.toLowerCase().endsWith(".xlsx")) throw Object.assign(new Error("只支持 .xlsx 文件"), { status: 415 });
      if (file.length === 0) throw Object.assign(new Error("所选文件为空"), { status: 400 });
    } else if (name === "roomBindings") {
      if (roomBindings !== null || dataEnd - headerEnd - 4 > 16_384) {
        throw Object.assign(new Error("直播间匹配数据无效"), { status: 400 });
      }
      roomBindings = body.subarray(headerEnd + 4, dataEnd).toString("utf8");
    }
    cursor = next;
  }
  if (!file) throw Object.assign(new Error("没有找到待上传的工作簿"), { status: 400 });
  let bindings = {};
  if (roomBindings !== null) {
    try { bindings = JSON.parse(roomBindings); } catch { bindings = null; }
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
      throw Object.assign(new Error("直播间匹配数据无效"), { status: 400 });
    }
  }
  return { file, bindings };
}

async function readAvatarUpload(request) {
  const contentType = request.headers["content-type"] ?? "";
  const boundaryMatch = contentType.match(/multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundaryMatch) throw Object.assign(new Error("请通过表单上传主播照片"), { status: 400 });
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
  const body = await readBody(request, 30 * 1024 * 1024);
  const files = [];
  let names = [];
  let replaceExisting = false;
  let cursor = 0;
  while (true) {
    const start = body.indexOf(boundary, cursor);
    if (start < 0) break;
    const headerStart = start + boundary.length + 2;
    if (body.subarray(start + boundary.length, start + boundary.length + 2).equals(Buffer.from("--"))) break;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const headers = body.subarray(headerStart, headerEnd).toString("latin1");
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] ?? "";
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const dataEnd = next >= 2 && body.subarray(next - 2, next).toString() === "\r\n" ? next - 2 : next;
    const name = disposition.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1];
    const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1] ?? "";
    const data = body.subarray(headerEnd + 4, dataEnd);
    if (name === "photos" && filename) files.push({ filename, bytes: Buffer.from(data) });
    else if (name === "names") {
      try { names = JSON.parse(data.toString("utf8")); } catch { throw Object.assign(new Error("主播姓名清单格式错误"), { status: 400 }); }
    } else if (name === "replaceExisting") replaceExisting = data.toString("utf8") === "true";
    cursor = next;
  }
  if (!files.length) throw Object.assign(new Error("请选择至少一张照片"), { status: 400 });
  if (files.length > 20) throw Object.assign(new Error("一次最多上传 20 张照片"), { status: 413 });
  if (!Array.isArray(names) || names.length !== files.length) throw Object.assign(new Error("每张照片都需要对应的主播姓名"), { status: 400 });
  const prepared = files.map((file, index) => {
    const name = String(names[index] ?? "").normalize("NFKC").trim();
    if (!name || name.length > 80 || /[\r\n]/.test(name)) throw Object.assign(new Error(`第 ${index + 1} 张照片的主播姓名无效`), { status: 422 });
    if (!/\.(?:jpe?g|png)$/i.test(file.filename)) throw Object.assign(new Error(`“${name}”的照片请使用 JPG 或 PNG 文件`), { status: 415 });
    if (!file.bytes.length || file.bytes.length > 8 * 1024 * 1024) throw Object.assign(new Error(`“${name}”的照片为空或超过 8 MB`), { status: file.bytes.length ? 413 : 400 });
    const photoType = imageTypeForBytes(file.bytes);
    if (!photoType) throw Object.assign(new Error(`“${name}”的文件内容不是有效的 JPG 或 PNG 图片`), { status: 415 });
    return { name, nameKey: hostNameKey(name), photoType, bytes: file.bytes, photoHash: createHash("sha256").update(file.bytes).digest("hex") };
  });
  if (new Set(prepared.map((item) => item.nameKey)).size !== prepared.length) {
    throw Object.assign(new Error("本次上传中有重复的主播姓名，请合并为一张头像后再上传"), { status: 422 });
  }
  return { prepared, replaceExisting };
}

function excelDate(value) {
  if (typeof value === "number" || (/^\d+(?:\.\d+)?$/.test(String(value).trim()) && Number(value) > 20000)) {
    const serial = Number(value);
    const days = Math.floor(serial);
    const date = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?$/);
  if (!match) return "";
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return "";
  return `${y}-${String(Number(m)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
}

function excelTime(value) {
  let minutes;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value ?? "").trim())) {
    const serial = Number(value);
    if (!Number.isFinite(serial) || serial < 0 || serial >= 2) return "";
    minutes = Math.round((serial % 1) * 24 * 60);
  } else {
    const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!match) return "";
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return "";
    minutes = hour * 60 + minute;
  }
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function shanghaiDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function slotSalesTarget(slot) {
  if (slot?.sales_target_text != null) return slot.sales_target_text;
  const cents = slot?.sales_target_cents;
  if (cents == null) return "";
  const yuan = cents / 100;
  if (yuan >= 100_000) {
    const wan = yuan / 10_000;
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万元`;
  }
  return `¥${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(yuan)}`;
}

function validateWorkbook(sheets) {
  const errors = [];
  const warnings = [];
  const rooms = [];
  const seenCodes = new Set();
  const pushError = (sheet, row, field, message) => errors.push({ sheet, row, field, message });
  const pushWarning = (sheet, row, field, message) => warnings.push({ sheet, row, field, message });
  if (!sheets.length) return { rooms, errors: [{ sheet: "", row: "", field: "工作簿", message: "没有可读取的直播间工作表" }], warnings };

  for (const sheet of sheets) {
    const name = String(cellValue(sheet, 1, "B") ?? "").trim();
    const code = String(cellValue(sheet, 1, "E") ?? "").trim();
    if (cellHasFormula(sheet, 1, "B") || !name) pushError(sheet.name, 1, "直播间名称", "请在 B1 填写直播间名称");
    if (cellHasFormula(sheet, 1, "E") || !code) pushError(sheet.name, 1, "直播间编号", "请在 E1 填写直播间编号");
    if (code && seenCodes.has(code)) pushError(sheet.name, 1, "直播间编号", `编号“${code}”重复`);
    if (code) seenCodes.add(code);

    const directorHeaders = { A: "日期", B: "导演开始时间", C: "导演结束时间", D: "导演" };
    const hostHeaders = {
      F: "日期", G: "主播开始时间", H: "主播结束时间", I: "主播", J: "助播",
      K: "主播照片", L: "主推商品", M: "目标销售额", N: "备注",
    };
    for (const [column, label] of Object.entries({ ...directorHeaders, ...hostHeaders })) {
      if (String(cellValue(sheet, 3, column) ?? "").trim() !== label) {
        pushError(sheet.name, 3, label, `第 3 行 ${column} 列应为“${label}”`);
      }
    }

    const directorShifts = [];
    const hostShifts = [];
    const formulasByColumn = {
      A: "导演日期", B: "导演开始时间", C: "导演结束时间", D: "导演",
      F: "主播日期", G: "主播开始时间", H: "主播结束时间", I: "主播", J: "助播",
      L: "主推商品", M: "目标销售额", N: "备注",
    };
    const read = (rowNumber, column) => cellValue(sheet, rowNumber, column);
    const validateRange = (rowNumber, role, dateValue, startValue, endValue) => {
      const date = excelDate(dateValue);
      const start = excelTime(startValue);
      const end = excelTime(endValue);
      if (!date) pushError(sheet.name, rowNumber, `${role}日期`, "请填写有效日期，例如 2026-11-18");
      if (!start) pushError(sheet.name, rowNumber, `${role}开始时间`, "请填写有效时间，例如 07:00");
      if (!end) pushError(sheet.name, rowNumber, `${role}结束时间`, "请填写有效时间，例如 11:00");
      const startAt = date && start ? Date.parse(`${date}T${start}:00+08:00`) : 0;
      let endAt = date && end ? Date.parse(`${date}T${end}:00+08:00`) : 0;
      if (date && start && end && endAt <= startAt) {
        if (endAt === startAt) pushError(sheet.name, rowNumber, `${role}结束时间`, "开始和结束时间不能相同");
        else endAt += 86_400_000;
      }
      return { date, start, end, startAt, endAt };
    };

    for (const [rowNumber, cells] of [...sheet.rows.entries()].filter(([row]) => row >= 4).sort(([a], [b]) => a - b)) {
      const rowImages = sheet.images.get(rowNumber) ?? [];
      const directorHasValues = ["A", "B", "C", "D"].some((column) => String(read(rowNumber, column) ?? "").trim() !== "");
      const hostHasValues = ["F", "G", "H", "I", "J", "L", "M", "N"].some((column) => String(read(rowNumber, column) ?? "").trim() !== "");
      if (!directorHasValues && !hostHasValues && !rowImages.length) continue;
      for (const [column, label] of Object.entries(formulasByColumn)) {
        if (cellHasFormula(sheet, rowNumber, column)) pushError(sheet.name, rowNumber, label, "请使用固定值，不支持公式");
      }

      if (directorHasValues) {
        const range = validateRange(rowNumber, "导演", read(rowNumber, "A"), read(rowNumber, "B"), read(rowNumber, "C"));
        const director = String(read(rowNumber, "D") ?? "").trim();
        if (!director) pushWarning(sheet.name, rowNumber, "导演", "未填写导演");
        if (range.date && range.start && range.end) directorShifts.push({
          id: randomBytes(16).toString("hex"), sourceRow: rowNumber, ...range, director,
        });
      }

      if (hostHasValues || rowImages.length) {
        const range = validateRange(rowNumber, "主播", read(rowNumber, "F"), read(rowNumber, "G"), read(rowNumber, "H"));
        const host = String(read(rowNumber, "I") ?? "").trim();
        const assistant = String(read(rowNumber, "J") ?? "").trim();
        const products = String(read(rowNumber, "L") ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
        const salesTarget = String(read(rowNumber, "M") ?? "");
        if (!host) pushWarning(sheet.name, rowNumber, "主播", "未填写主播");
        if (!assistant) pushWarning(sheet.name, rowNumber, "助播", "未填写助播");
        if (!rowImages.length) pushWarning(sheet.name, rowNumber, "主播照片", "未添加主播照片");
        if (!products.length) pushWarning(sheet.name, rowNumber, "主推商品", "未填写主推商品");
        if (!salesTarget) pushWarning(sheet.name, rowNumber, "目标销售额", "未填写目标销售额");
        if (rowImages.length > 1) pushError(sheet.name, rowNumber, "主播照片", "每个主播时段最多添加一张照片");
        if (rowImages.some((image) => image.columnNumber !== 10)) pushError(sheet.name, rowNumber, "主播照片", "请将照片锚定在 K 列对应主播排班行");
        if (!hostHasValues && rowImages.length) pushError(sheet.name, rowNumber, "主播照片", "照片所在行没有主播排班信息");
        if (range.date && range.start && range.end) hostShifts.push({
          id: randomBytes(16).toString("hex"), sourceRow: rowNumber, ...range,
          host, assistant, products, salesTarget,
          notes: String(read(rowNumber, "N") ?? "").trim(), photo: rowImages[0] ?? null,
        });
      }
    }

    for (const [shifts, role] of [[directorShifts, "导演"], [hostShifts, "主播"]]) {
      shifts.sort((a, b) => a.startAt - b.startAt);
      let furthestEnd = 0;
      for (const shift of shifts) {
        if (shift.startAt < furthestEnd) {
          pushError(sheet.name, shift.sourceRow, `${role}排班时间`, `同一直播间的${role}排班时间发生重叠`);
        }
        furthestEnd = Math.max(furthestEnd, shift.endAt);
      }
    }
    for (const [rowNumber] of sheet.images) {
      if (rowNumber >= 4 && !sheet.rows.has(rowNumber)) pushError(sheet.name, rowNumber, "主播照片", "照片所在行没有排班单元格");
    }
    if (name && code) rooms.push({ code, name, sheetName: sheet.name, directorShifts, hostShifts });
  }
  return { rooms, errors, warnings };
}

function staffRoomCatalog() {
  const names = new Map(db.prepare("SELECT code,name FROM rooms").all().map(({ code, name }) => [code, name]));
  return NUMBERED_ROOM_CODES.map((code) => ({ code, name: names.get(code) ?? null }));
}

function resolveStaffRooms(source, bindings) {
  const existing = db.prepare("SELECT code,name FROM rooms").all();
  const named = new Map();
  const byCode = new Map(existing.map((room) => [room.code, room]));
  const aliases = new Map(db.prepare("SELECT name_key,room_code FROM room_aliases").all()
    .map(({ name_key, room_code }) => [name_key, room_code]));
  for (const { code, name } of existing) {
    const key = roomNameKey(name);
    if (!named.has(key)) named.set(key, []);
    named.get(key).push(code);
  }
  const keys = new Set(source.map((room) => room.key));
  const errors = [];
  for (const [key, code] of Object.entries(bindings)) {
    if (!keys.has(key) || !NUMBERED_ROOM_CODES.includes(code)) {
      errors.push({ field: "直播间匹配", message: "匹配项不属于当前文件或直播间编号无效" });
    }
  }

  const targets = new Map();
  const unmatchedRooms = [];
  const sourceRooms = source.map((room) => {
    const candidates = named.get(room.key) ?? [];
    const known = room.numberOnly ? null : aliases.get(room.key) ?? (candidates.length === 1 ? candidates[0] : null);
    const chosen = Object.hasOwn(bindings, room.key) ? bindings[room.key] : null;
    const automatic = Boolean(room.code || known);
    const code = room.code ?? known ?? chosen;
    const otherCodes = room.code && !room.numberOnly ? (known ? [known] : candidates).filter((item) => item !== room.code) : [];
    const issue = (message) =>
      errors.push({ sheet: room.sheetName, row: room.sourceRow, field: "直播间匹配", room: room.name, message });
    if (automatic && chosen && code !== chosen) issue("房间匹配已变化，请重新核对当前编号");
    if (!code) unmatchedRooms.push(room);
    else {
      let target = targets.get(code);
      if (target && (!automatic || !target.automatic)) {
        issue(`与“${target.sourceName}”选中了同一编号，请为相关名称填写正确的直播间号码或更正匹配`);
      }
      if (!target) {
        target = {
          code, name: byCode.get(code)?.name ?? room.name, sourceName: room.name, sheetName: room.sheetName,
          isNew: !byCode.has(code), automatic, sourceNames: [], aliasKeys: [], numberConflicts: [],
          dates: new Map(), hostShifts: [], directorShifts: [],
        };
        targets.set(code, target);
      }
      if (!room.numberOnly) {
        if (!target.sourceNames.length) {
          target.sourceName = room.name;
          if (target.isNew) target.name = room.name;
        }
        target.sourceNames.push(room.name);
        if (otherCodes.length) target.numberConflicts.push({ name: room.name, codes: otherCodes, ...room.codeSource });
        if (!known && !otherCodes.length) target.aliasKeys.push(room.key);
      }
      for (const [date, group] of room.dates) target.dates.set(date, group);
      target.hostShifts.push(...room.hostShifts);
      target.directorShifts.push(...room.directorShifts);
    }
    return {
      sourceRoomKey: room.key, name: room.name, sheet: room.sheetName, row: room.sourceRow,
      dateCount: room.dates.size, code, automatic, ambiguous: !automatic && candidates.length > 1,
    };
  });
  return { sourceRooms, rooms: [...targets.values()], unmatchedRooms, errors };
}

function staffImportConflicts(rooms) {
  const errors = [];
  for (const room of rooms) {
    for (const [incoming, table, role] of [
      [room.directorShifts, "director_shifts", "导演"],
      [room.hostShifts, "slots", "主播"],
    ]) {
      const query = db.prepare("SELECT date,start_time,end_time FROM " + table
        + " WHERE room_code=? AND starts_at<? AND ends_at>?");
      for (const shift of incoming) {
        const conflict = query.all(room.code, shift.endAt, shift.startAt).find((previous) => !room.dates.has(previous.date));
        if (conflict) errors.push({
          sheet: shift.sourceSheet, row: shift.sourceRow, field: role + "时间", room: room.sourceName, date: shift.date,
          message: "与未更新日期的现有排班 " + conflict.date + " " + conflict.start_time + "–" + conflict.end_time + " 重叠",
        });
      }
    }
  }
  return errors;
}

function staffImportSummary(rooms, warnings) {
  const days = [...new Set(rooms.flatMap((room) => [...room.dates.keys()]))].sort();
  return {
    roomCount: rooms.length,
    dateCount: rooms.reduce((sum, room) => sum + room.dates.size, 0),
    firstDate: days[0],
    lastDate: days.at(-1),
    scheduleCount: rooms.reduce((sum, room) => sum + room.hostShifts.length, 0),
    directorShiftCount: rooms.reduce((sum, room) => sum + room.directorShifts.length, 0),
    skippedCount: warnings.length,
  };
}

const shiftKey = (start, end, person) => JSON.stringify([start, end, person]);

function staffPreviewRooms(rooms) {
  const findHosts = db.prepare(`SELECT start_time,end_time,host,assistant,products_json,sales_target_cents,sales_target_text
    FROM slots WHERE room_code=? AND date=?`);
  const oldDirectorCount = db.prepare("SELECT COUNT(*) AS count FROM director_shifts WHERE room_code=? AND date=?");
  const displayShift = ({ host, director, start, end, overnight, sourceSheet, sourceRow }) =>
    ({ person: host ?? director, start, end, overnight, sourceSheet, sourceRow });
  return rooms.map((room) => ({
    code: room.code, name: room.name, sourceName: room.sourceName, sourceNames: room.sourceNames,
    isNew: room.isNew, numberConflicts: room.numberConflicts,
    dates: [...room.dates.keys()].sort().map((date) => {
      const previousHosts = findHosts.all(room.code, date);
      const byHost = new Map(previousHosts.map((slot) => [shiftKey(slot.start_time, slot.end_time, slot.host), slot]));
      return {
        date,
        previousHostCount: previousHosts.length,
        previousDirectorCount: oldDirectorCount.get(room.code, date).count,
        hostShifts: room.hostShifts.filter((shift) => shift.date === date).map((shift) => {
          const old = byHost.get(shiftKey(shift.start, shift.end, shift.host));
          return {
            ...displayShift(shift),
            assistant: shift.assistant ?? old?.assistant ?? "",
            featuredProducts: shift.products ?? JSON.parse(old?.products_json ?? "[]"),
            salesTarget: shift.salesTarget ?? slotSalesTarget(old),
          };
        }),
        directorShifts: room.directorShifts.filter((shift) => shift.date === date).map(displayShift),
      };
    }),
  }));
}

function staffImportReceipt(id, userId) {
  const row = db.prepare("SELECT result_json FROM staff_import_receipts WHERE id=? AND user_id=? AND expires_at>?")
    .get(id, userId, Date.now());
  return row ? JSON.parse(row.result_json) : null;
}

function commitStaffImport(id, userId) {
  const receipt = staffImportReceipt(id, userId);
  if (receipt) return receipt;
  const preview = staffPreviews.get(id);
  if (!preview || preview.userId !== userId || preview.expiresAt <= Date.now()) {
    throw Object.assign(new Error("预览已失效，请重新生成预览"), { status: 409 });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const existingReceipt = staffImportReceipt(id, userId);
    if (existingReceipt) {
      db.exec("COMMIT");
      return existingReceipt;
    }
    if (updatedAtValue() !== preview.version) {
      throw Object.assign(new Error("排班或直播间资料已更新，请重新生成预览"), { status: 409 });
    }
    const updateAt = nextDataUpdatedAt();
    let roomOrder = db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM rooms").get().next;
    const insertRoom = db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)");
    const insertAlias = db.prepare("INSERT INTO room_aliases(name_key,room_code) VALUES (?,?)");
    const findHosts = db.prepare("SELECT * FROM slots WHERE room_code=? AND date=?");
    const findDirectors = db.prepare("SELECT * FROM director_shifts WHERE room_code=? AND date=?");
    const deleteHosts = db.prepare("DELETE FROM slots WHERE room_code=? AND date=?");
    const deleteDirectors = db.prepare("DELETE FROM director_shifts WHERE room_code=? AND date=?");
    const insertHost = db.prepare(`INSERT INTO slots(
      id,room_code,date,start_time,end_time,starts_at,ends_at,host,assistant,
      products_json,sales_target_cents,sales_target_text,notes,photo_type,photo_blob
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertDirector = db.prepare(`INSERT INTO director_shifts(
      id,room_code,date,start_time,end_time,starts_at,ends_at,director
    ) VALUES (?,?,?,?,?,?,?,?)`);
    for (const room of preview.rooms) {
      if (room.isNew) insertRoom.run(room.code, room.name, room.sheetName, roomOrder++);
      for (const key of room.aliasKeys) insertAlias.run(key, room.code);
      for (const date of room.dates.keys()) {
        const oldHosts = new Map(findHosts.all(room.code, date).map((slot) => [
          shiftKey(slot.start_time, slot.end_time, slot.host), slot,
        ]));
        const oldDirectors = new Map(findDirectors.all(room.code, date).map((shift) => [
          shiftKey(shift.start_time, shift.end_time, shift.director), shift,
        ]));
        deleteHosts.run(room.code, date);
        deleteDirectors.run(room.code, date);
        for (const slot of room.hostShifts.filter((shift) => shift.date === date)) {
          const old = oldHosts.get(shiftKey(slot.start, slot.end, slot.host));
          insertHost.run(
            old?.id ?? slot.id, room.code, date, slot.start, slot.end, slot.startAt, slot.endAt,
            slot.host, slot.assistant ?? old?.assistant ?? "",
            slot.products === undefined ? old?.products_json ?? "[]" : JSON.stringify(slot.products),
            slot.salesTarget === undefined ? old?.sales_target_cents ?? null : null,
            slot.salesTarget ?? old?.sales_target_text ?? null,
            old?.notes ?? "", old?.photo_type ?? null, old?.photo_blob ?? null,
          );
        }
        for (const shift of room.directorShifts.filter((item) => item.date === date)) {
          const old = oldDirectors.get(shiftKey(shift.start, shift.end, shift.director));
          insertDirector.run(old?.id ?? shift.id, room.code, date, shift.start, shift.end, shift.startAt, shift.endAt, shift.director);
        }
      }
    }
    seedUniqueHostAvatars(preview.rooms.flatMap((room) => room.hostShifts));
    db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(updateAt);
    const result = { ok: true, ...preview.summary, dataUpdatedAt: updateAt };
    db.prepare("INSERT INTO staff_import_receipts(id,user_id,result_json,expires_at) VALUES (?,?,?,?)")
      .run(id, userId, JSON.stringify(result), Date.now() + 24 * 60 * 60_000);
    db.exec("COMMIT");
    staffPreviews.delete(id);
    return result;
  } catch (cause) {
    try { db.exec("ROLLBACK"); } catch {}
    throw cause;
  }
}

function fixedTextError(message, field = "格式", row = "") {
  const cause = new Error(message);
  cause.details = [{ sheet: "文本输入", row, field, message }];
  throw cause;
}

function parseFixedFields(section, blockNumber, allowed, required) {
  const fields = new Map();
  for (const [index, rawLine] of section.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([^：:]+)[：:](.*)$/);
    if (!match) fixedTextError("每行请按“字段：内容”填写", "格式", index + 1);
    const key = match[1].trim();
    if (!allowed.includes(key)) fixedTextError(`不支持字段“${key}”`, key, index + 1);
    if (fields.has(key)) fixedTextError(`字段“${key}”重复填写`, key, index + 1);
    fields.set(key, match[2].trim());
  }
  for (const key of required) {
    if (!fields.has(key)) fixedTextError(`第 ${blockNumber} 段缺少“${key}”字段`, key, blockNumber);
  }
  return fields;
}

function parseFixedScheduleText(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!text) fixedTextError("请提供排班文本");
  if (text.length > 60_000) fixedTextError("排班文本不能超过 60,000 个字符");
  const sections = text.split(/^[ \t]*---[ \t]*$/m);
  while (sections.length && !sections.at(-1).trim()) sections.pop();
  if (sections.length < 2) fixedTextError("请先填写直播间信息，再分别填写导演排班和主播排班");
  if (sections.length > 101) fixedTextError("一次最多提交 100 个导演或主播时段");

  const metadata = parseFixedFields(
    sections[0], 1,
    ["直播间编号", "直播间名称", "排班日期"],
    ["直播间编号", "直播间名称", "排班日期"],
  );
  const roomCode = metadata.get("直播间编号");
  const roomName = metadata.get("直播间名称");
  const dateInput = metadata.get("排班日期");
  const date = excelDate(dateInput);
  if (!roomCode || roomCode.length > 40) fixedTextError("直播间编号不能为空且不能超过 40 个字符", "直播间编号", 1);
  if (!roomName || roomName.length > 120) fixedTextError("直播间名称不能为空且不能超过 120 个字符", "直播间名称", 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput) || date !== dateInput) fixedTextError("排班日期请按 YYYY-MM-DD 填写有效日期", "排班日期", 1);

  const directorHeaders = ["日期", "导演开始时间", "导演结束时间", "导演"];
  const hostHeaders = ["日期", "主播开始时间", "主播结束时间", "主播", "助播", "主播照片", "主推商品", "目标销售额", "备注"];
  const columns = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
  const headerValues = [...directorHeaders, "", ...hostHeaders];
  const rows = new Map([
    [1, new Map([["B", { value: roomName }], ["E", { value: roomCode }]])],
    [3, new Map(headerValues.map((label, index) => [columns[index], { value: label }]))],
  ]);
  const allowedFields = ["排班类型", "时段", "导演", "主播", "助播", "主推商品", "目标销售额", "备注"];
  let directorRow = 4;
  let hostRow = 4;
  const writeRow = (rowNumber, rowValues) => {
    const row = rows.get(rowNumber) ?? new Map();
    for (const [column, value] of Object.entries(rowValues)) row.set(column, { value });
    rows.set(rowNumber, row);
  };

  sections.slice(1).forEach((section, index) => {
    const fields = parseFixedFields(section, index + 2, allowedFields, ["排班类型", "时段"]);
    const role = fields.get("排班类型");
    const period = fields.get("时段");
    const range = period.match(/^(\d{1,2}:\d{2})\s*(?:-|–|—|至|到)\s*(\d{1,2}:\d{2})$/);
    if (!range) fixedTextError("时段请按“07:00-11:00”填写", "时段", index + 4);
    if (role === "导演") {
      if (!fields.has("导演")) fixedTextError(`第 ${index + 2} 段缺少“导演”字段`, "导演", index + 4);
      if (["主播", "助播", "主推商品", "目标销售额", "备注"].some((key) => fields.has(key))) {
        fixedTextError("导演排班段只填写导演姓名和时段", "排班类型", index + 4);
      }
      writeRow(directorRow++, { A: date, B: range[1], C: range[2], D: fields.get("导演") });
      return;
    }
    if (role !== "主播") fixedTextError("排班类型请填写“导演”或“主播”", "排班类型", index + 4);
    for (const key of ["主播", "助播", "主推商品", "目标销售额", "备注"]) {
      if (!fields.has(key)) fixedTextError(`第 ${index + 2} 段缺少“${key}”字段`, key, index + 4);
    }
    if (fields.has("导演")) fixedTextError("主播排班段请勿填写导演；导演时间在独立排班段填写", "导演", index + 4);
    const products = fields.get("主推商品").replace(/[；;、]/g, "\n");
    writeRow(hostRow++, {
      F: date, G: range[1], H: range[2], I: fields.get("主播"), J: fields.get("助播"), K: "",
      L: products, M: fields.get("目标销售额"), N: fields.get("备注"),
    });
  });

  return {
    roomCode, roomName, date,
    sheet: { name: `API-${roomCode}`, rows, images: new Map() },
  };
}

function validateFixedScheduleText(text) {
  const parsed = parseFixedScheduleText(text);
  const result = validateWorkbook([parsed.sheet]);
  const warnings = result.warnings.filter((warning) => warning.field !== "主播照片");
  warnings.push({
    sheet: parsed.sheet.name, row: "", field: "主播头像",
    message: "系统会按主播姓名匹配头像库；未匹配到的主播会在预览中提示管理员补充头像",
  });
  return { ...parsed, result, warnings };
}

function calendarDayOffset(date, offset) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function currentShanghaiDay() {
  const today = shanghaiDate(new Date());
  const yesterday = new Date(`${today}T00:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return { today, yesterday: shanghaiDate(yesterday) };
}

function publicSlot(slot) {
  const products = JSON.parse(slot.products_json);
  const { avatar, hasLegacyPhoto } = slotHostAvatar(slot);
  const photo = avatar?.photo_type
    ? `/api/v1/host-avatars/${encodeURIComponent(avatar.id)}/media?v=${avatar.updated_at}`
    : hasLegacyPhoto ? `/api/v1/media/${encodeURIComponent(slot.id)}` : null;
  return {
    id: slot.id, date: slot.date, start: slot.start_time, end: slot.end_time,
    host: slot.host, assistant: slot.assistant,
    featuredProducts: products, salesTarget: slotSalesTarget(slot),
    photo,
    startsAt: slot.starts_at, endsAt: slot.ends_at,
  };
}

function publicDirectorShift(shift) {
  return {
    id: shift.id, date: shift.date, start: shift.start_time, end: shift.end_time,
    director: shift.director, startsAt: shift.starts_at, endsAt: shift.ends_at,
  };
}

function avatarLibraryPayload() {
  const usage = new Map();
  for (const row of db.prepare("SELECT host,COUNT(*) AS count FROM slots WHERE host<>'' GROUP BY host").all()) {
    const key = hostNameKey(row.host);
    usage.set(key, (usage.get(key) ?? 0) + row.count);
  }
  const profiles = db.prepare("SELECT id,name,photo_type,updated_at FROM host_avatars ORDER BY name COLLATE NOCASE").all().map((profile) => ({
    id: profile.id, name: profile.name, hasPhoto: Boolean(profile.photo_type),
    photoUrl: profile.photo_type ? `/api/v1/host-avatars/${encodeURIComponent(profile.id)}/media?v=${profile.updated_at}` : null,
    updatedAt: new Date(profile.updated_at).toISOString(), usedSlots: usage.get(hostNameKey(profile.name)) ?? 0,
  }));
  const legacyGroups = new Map();
  for (const row of db.prepare("SELECT host,photo_blob FROM slots WHERE host<>'' AND photo_blob IS NOT NULL").all()) {
    const nameKey = hostNameKey(row.host);
    const photoHash = createHash("sha256").update(row.photo_blob).digest("hex");
    if (!legacyGroups.has(nameKey)) legacyGroups.set(nameKey, { name: row.host, photos: new Set() });
    legacyGroups.get(nameKey).photos.add(photoHash);
  }
  const conflicts = [...legacyGroups.entries()].flatMap(([nameKey, group]) => {
    if (group.photos.size <= 1 || deletedHostAvatarByNameKey.get(nameKey)) return [];
    const avatar = hostAvatarByNameKey.get(nameKey);
    return avatar?.photo_type ? [] : [{ name: group.name, photoCount: group.photos.size }];
  });
  const withPhoto = profiles.filter((profile) => profile.hasPhoto).length;
  return { profiles, conflicts, summary: { total: profiles.length, withPhoto, missingPhoto: profiles.length - withPhoto } };
}

function adminSchedulePayload() {
  const rooms = db.prepare("SELECT code,name,sort_order AS sortOrder FROM rooms ORDER BY sort_order").all();
  const rows = db.prepare(`SELECT s.*,r.name AS room_name,r.sort_order AS room_sort_order
    FROM slots s JOIN rooms r ON r.code=s.room_code
    ORDER BY s.date DESC,r.sort_order,s.start_time`).all();
  const directorRows = db.prepare(`SELECT d.*,r.name AS room_name,r.sort_order AS room_sort_order
    FROM director_shifts d JOIN rooms r ON r.code=d.room_code
    ORDER BY d.date DESC,r.sort_order,d.start_time`).all();
  const groups = new Map();
  const groupFor = (row) => {
    const key = `${row.room_code}\u0000${row.date}`;
    if (!groups.has(key)) groups.set(key, {
      roomCode: row.room_code, roomName: row.room_name, date: row.date, slots: [],
    });
    return groups.get(key);
  };
  for (const row of rows) {
    const { avatar, hasLegacyPhoto } = slotHostAvatar(row);
    groupFor(row).slots.push({
      id: row.id, kind: "host", start: row.start_time, end: row.end_time,
      host: row.host, assistant: row.assistant,
      featuredProducts: JSON.parse(row.products_json), salesTarget: slotSalesTarget(row), notes: row.notes,
      hasAvatar: Boolean(avatar?.photo_type) || hasLegacyPhoto,
      avatarSource: avatar?.photo_type ? "头像库" : hasLegacyPhoto ? "本场照片" : "未配置",
    });
  }
  for (const row of directorRows) {
    groupFor(row).slots.push({
      id: row.id, kind: "director", start: row.start_time, end: row.end_time,
      director: row.director, host: "", assistant: "", featuredProducts: [], salesTarget: "", notes: "",
      hasAvatar: false, avatarSource: "未配置",
    });
  }
  for (const group of groups.values()) group.slots.sort((a, b) => a.start.localeCompare(b.start) || a.kind.localeCompare(b.kind));
  return {
    rooms, groups: [...groups.values()], scheduleCount: rows.length,
    directorShiftCount: directorRows.length, dataUpdatedAt: updatedAtValue(),
  };
}

const mcpTools = [
  {
    name: "list_rooms",
    title: "查看直播间",
    description: "列出已录入的直播间编号和名称，先用它确认用户说的是哪个直播间。只读。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "查看直播间", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_room_schedule",
    title: "查看当日排班",
    description: "查看指定直播间某一天独立的导演排班与主播排班。导演和主播时段不要求一一对应；助播跟随主播。主播头像会按姓名从头像库匹配。日期必须由用户提供或确认。只读。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["roomCode", "date"],
      properties: {
        roomCode: { type: "string", description: "直播间编号，先通过 list_rooms 确认" },
        date: { type: "string", description: "排班日期，格式 YYYY-MM-DD" },
      },
    },
    annotations: { title: "查看当日排班", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "preview_schedule_update",
    title: "预览排班修改",
    description: "预览一个直播间单个日期的完整排班，不会写入数据。导演排班与主播排班分别填写、分别校验，不需要一一对应；助播跟随主播时段。同一直播间多日更新请调用 preview_room_schedules_update。必须先展示预览并等待用户明确确认，才能调用 commit_schedule_update。不得补造用户没有提供的日期、时段或人员。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["roomCode", "date", "directorShifts", "hostShifts"],
      properties: {
        roomCode: { type: "string", description: "直播间编号" },
        roomName: { type: "string", description: "新增直播间时必填；已有直播间会使用系统中的名称" },
        date: { type: "string", description: "排班日期，格式 YYYY-MM-DD" },
        directorShifts: {
          type: "array", maxItems: 100,
          description: "该日期完整的导演排班列表，与主播时段相互独立",
          items: {
            type: "object", additionalProperties: false, required: ["start", "end", "director"],
            properties: {
              start: { type: "string", description: "开始时间，24 小时制，例如 07:00" },
              end: { type: "string", description: "结束时间，24 小时制，例如 11:00" },
              director: { type: "string", description: "导演姓名" },
            },
          },
        },
        hostShifts: {
          type: "array", maxItems: 100,
          description: "该日期完整的主播排班列表；助播跟随主播时段",
          items: {
            type: "object", additionalProperties: false, required: ["start", "end", "host"],
            properties: {
              start: { type: "string", description: "主播开始时间，24 小时制" },
              end: { type: "string", description: "主播结束时间，24 小时制" },
              host: { type: "string", description: "主播姓名；系统按姓名自动匹配头像库" },
              assistant: { type: "string", description: "助播，随主播排班" },
              featuredProducts: { type: "array", items: { type: "string" }, maxItems: 30 },
              salesTarget: { description: "目标销售额原文，按填写内容显示", oneOf: [{ type: "string" }, { type: "number" }] },
              notes: { type: "string" },
            },
          },
        },
      },
    },
    annotations: { title: "预览排班修改", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "preview_room_schedules_update",
    title: "预览单直播间多日期排班",
    description: "一次整理一个直播间多个日期的完整排班。每个日期分别包含完整的导演排班和主播排班；两类时段相互独立，助播跟随主播。只预览不写入；必须先展示每一天的完整预览并等待用户明确确认，才能调用 commit_schedule_update。不得补造用户没有提供的日期、时段或人员。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["roomCode", "schedules"],
      properties: {
        roomCode: { type: "string", description: "直播间编号；一个请求只能处理这个直播间" },
        roomName: { type: "string", description: "新增直播间时必填；已有直播间会使用系统中的名称" },
        schedules: {
          type: "array", minItems: 1, maxItems: 100,
          description: "该直播间要更新的日期列表；每个日期的 directorShifts 与 hostShifts 都是当天完整列表，未列出的日期保持不变",
          items: {
            type: "object", additionalProperties: false, required: ["date", "directorShifts", "hostShifts"],
            properties: {
              date: { type: "string", description: "排班日期，格式 YYYY-MM-DD" },
              directorShifts: {
                type: "array", maxItems: 100,
                description: "该日期的完整导演排班列表",
                items: {
                  type: "object", additionalProperties: false, required: ["start", "end", "director"],
                  properties: {
                    start: { type: "string", description: "开始时间，24 小时制，例如 07:00" },
                    end: { type: "string", description: "结束时间，24 小时制，例如 11:00" },
                    director: { type: "string", description: "导演姓名" },
                  },
                },
              },
              hostShifts: {
                type: "array", maxItems: 100,
                description: "该日期的完整主播排班列表；助播跟随主播时段",
                items: {
                  type: "object", additionalProperties: false, required: ["start", "end", "host"],
                  properties: {
                    start: { type: "string", description: "主播开始时间，24 小时制" },
                    end: { type: "string", description: "主播结束时间，24 小时制" },
                    host: { type: "string", description: "主播姓名；系统按姓名自动匹配头像库" },
                    assistant: { type: "string", description: "助播，随主播排班" },
                    featuredProducts: { type: "array", items: { type: "string" }, maxItems: 30 },
                    salesTarget: { description: "目标销售额原文，按填写内容显示", oneOf: [{ type: "string" }, { type: "number" }] },
                    notes: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    annotations: { title: "预览单直播间多日期排班", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "commit_schedule_update",
    title: "确认并提交排班",
    description: "提交 preview_schedule_update 或 preview_room_schedules_update 返回的预览编号。仅当用户看到目标直播间、所有日期、替换场次数和完整排班预览并明确同意后才能调用。一次性预览编号 10 分钟有效；期间任何排班数据更新都会使其失效。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["previewId"],
      properties: { previewId: { type: "string", description: "预览工具返回的一次性编号" } },
    },
    annotations: { title: "确认并提交排班", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

function updatedAtValue() {
  return db.prepare("SELECT value FROM app_state WHERE key='data_updated_at'").get().value;
}

function nextDataUpdatedAt() {
  return new Date(Math.max(Date.now(), (Date.parse(updatedAtValue()) || 0) + 1)).toISOString();
}

function roomList(includeCounts = false) {
  const counts = includeCounts ? `,
    (SELECT COUNT(*) FROM slots s WHERE s.room_code=r.code) AS scheduleCount,
    (SELECT COUNT(*) FROM director_shifts d WHERE d.room_code=r.code) AS directorShiftCount` : "";
  return db.prepare(`SELECT r.code,r.name,r.sort_order AS sortOrder,a.version AS avatarVersion${counts}
    FROM rooms r LEFT JOIN room_avatars a ON a.room_code=r.code ORDER BY r.sort_order,r.code`).all()
    .map(({ avatarVersion, ...room }) => ({
      ...room, avatarUrl: avatarVersion ? `/api/v1/rooms/${encodeURIComponent(room.code)}/avatar?v=${avatarVersion}` : null,
    }));
}

function adminRoomsPayload() {
  return { rooms: roomList(true), dataUpdatedAt: updatedAtValue() };
}

function renameRoom(room, name) {
  const key = roomNameKey(name);
  const oldKey = roomNameKey(room.name);
  if (key !== oldKey) {
    const otherNames = new Set(db.prepare("SELECT name FROM rooms WHERE code<>?").all(room.code)
      .map(({ name }) => roomNameKey(name)));
    const otherAlias = db.prepare("SELECT room_code FROM room_aliases WHERE name_key=? AND room_code<>?").get(key, room.code);
    if (otherNames.has(key) || otherAlias) {
      throw Object.assign(new Error("该名称已用于其他直播间，请换一个名称"), { status: 409, code: "ROOM_NAME_CONFLICT" });
    }
    if (oldKey && !otherNames.has(oldKey)) {
      db.prepare("INSERT OR IGNORE INTO room_aliases(name_key,room_code) VALUES (?,?)").run(oldKey, room.code);
    }
  }
  db.prepare("UPDATE rooms SET name=? WHERE code=?").run(name, room.code);
}

async function manageRoom(request, response, code, isAvatar) {
  const user = requireUser(request, response, "admin");
  if (!user) return;
  if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");

  let name, photo, photoType;
  try {
    if (request.method === "PATCH") {
      const input = await readJson(request);
      name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!roomNameKey(name) || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
        return error(response, 422, "ROOM_NAME_INVALID", "请填写有效的直播间名称，最多 120 个字符");
      }
    }
    if (request.method === "PUT") {
      photo = await readBody(request, 8 * 1024 * 1024);
      photoType = imageTypeForBytes(photo);
      if (!photoType) return error(response, 415, "ROOM_AVATAR_INVALID", "请选择有效的 JPG 或 PNG 图片");
    }
  } catch (cause) {
    return error(response, cause.status ?? 400, "INVALID_REQUEST", cause.message);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const room = db.prepare("SELECT code,name FROM rooms WHERE code=?").get(code);
    if (!room) throw Object.assign(new Error("直播间不存在"), { status: 404, code: "ROOM_NOT_FOUND" });
    if (request.headers["if-match"] !== JSON.stringify(updatedAtValue())) {
      throw Object.assign(new Error("直播间或排班已更新，请核对后重试"), { status: 409, code: "ROOMS_CHANGED" });
    }
    if (request.method === "PATCH") renameRoom(room, name);
    else if (request.method === "PUT") {
      db.prepare(`INSERT INTO room_avatars(room_code,photo_type,photo_blob,version) VALUES (?,?,?,?)
        ON CONFLICT(room_code) DO UPDATE SET photo_type=excluded.photo_type,photo_blob=excluded.photo_blob,version=excluded.version`)
        .run(code, photoType, photo, randomBytes(16).toString("hex"));
    } else if (isAvatar) db.prepare("DELETE FROM room_avatars WHERE room_code=?").run(code);
    else db.prepare("DELETE FROM rooms WHERE code=?").run(code);
    db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(nextDataUpdatedAt());
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    if (cause.status) return error(response, cause.status, cause.code, cause.message);
    throw cause;
  }
  return json(response, 200, adminRoomsPayload());
}

function mcpPreviewFor(parsed, replacedDates = new Set([parsed.date])) {
  const roomSchedule = parsed.result.rooms[0];
  const directorShifts = roomSchedule.directorShifts;
  const hostShifts = roomSchedule.hostShifts;
  if (parsed.result.errors.length) {
    const cause = new Error("排班内容未通过校验，请根据错误修正后重新预览");
    cause.details = parsed.result.errors;
    throw cause;
  }
  const conflicts = [];
  for (const [shifts, table, role] of [
    [directorShifts, "director_shifts", "导演"],
    [hostShifts, "slots", "主播"],
  ]) {
    const adjacent = db.prepare(`SELECT date,start_time,end_time,starts_at,ends_at FROM ${table}
      WHERE room_code=? AND date IN (?,?)`).all(
      parsed.roomCode, calendarDayOffset(parsed.date, -1), calendarDayOffset(parsed.date, 1),
    ).filter((shift) => !replacedDates.has(shift.date));
    for (const shift of shifts) {
      for (const existing of adjacent) {
        if (shift.startAt < existing.ends_at && existing.starts_at < shift.endAt) conflicts.push({
          sheet: parsed.sheet.name, row: shift.sourceRow, field: `${role}排班时间`,
          message: `与相邻日期 ${existing.date} 的现有${role}排班 ${existing.start_time}-${existing.end_time} 重叠`,
        });
      }
    }
  }
  if (conflicts.length) {
    const cause = new Error("导演或主播排班与相邻日期的跨日时段冲突，请先处理冲突后重新预览");
    cause.details = conflicts;
    throw cause;
  }
  const replacingSlots = db.prepare("SELECT COUNT(*) AS count FROM slots WHERE room_code=? AND date=?").get(parsed.roomCode, parsed.date).count;
  const replacingDirectorShifts = db.prepare("SELECT COUNT(*) AS count FROM director_shifts WHERE room_code=? AND date=?").get(parsed.roomCode, parsed.date).count;
  const scheduleRows = hostShifts.map((slot, index) => {
    const previous = db.prepare("SELECT photo_blob FROM slots WHERE room_code=? AND date=? AND start_time=? AND end_time=? AND host=?")
      .get(parsed.roomCode, parsed.date, slot.start, slot.end, slot.host);
    const { avatar, hasLegacyPhoto } = slotHostAvatar(slot, previous?.photo_blob);
    const hasAvatar = Boolean(avatar?.photo_type) || hasLegacyPhoto;
    return {
      start: slot.start, end: slot.end, host: slot.host,
      assistant: slot.assistant, featuredProducts: slot.products,
      salesTarget: slot.salesTarget, notes: slot.notes,
      hasAvatar, avatarSource: avatar?.photo_type ? "头像库" : hasAvatar ? "本场已有照片" : "未配置",
      row: index + 4,
    };
  });
  const directorRows = directorShifts.map((shift) => ({
    start: shift.start, end: shift.end, director: shift.director,
  }));
  return {
    roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
    replacingSlots, replacingDirectorShifts,
    scheduleCount: hostShifts.length, directorShiftCount: directorShifts.length,
    assignmentCount: hostShifts.length + directorShifts.length,
    directorShifts: directorRows,
    hostShifts: scheduleRows.map(({ row, ...slot }) => slot),
    warnings: [
      ...parsed.warnings.filter((warning) => warning.field !== "主播头像"),
      ...scheduleRows.filter((slot) => !slot.hasAvatar).map((slot) => ({
        sheet: `API-${parsed.roomCode}`, row: slot.row, field: "主播头像",
        message: slot.host ? `头像库中没有“${slot.host}”的头像，管理员可在主播头像库上传` : "本时段未填写主播，无法关联头像",
      })),
    ],
  };
}

function cleanMcpField(value, label, maxLength = 500) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength || /[\r\n]/.test(text)) throw new Error(`${label}不能超过 ${maxLength} 个字符，也不能包含换行`);
  return text;
}

function fixedScheduleTextFromMcp(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("请提供排班内容");
  const roomCode = cleanMcpField(args.roomCode, "直播间编号", 40);
  const date = cleanMcpField(args.date, "日期", 10);
  if (!roomCode) throw new Error("请先确认直播间编号");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || excelDate(date) !== date) throw new Error("请提供有效排班日期，格式为 YYYY-MM-DD");
  if (!Array.isArray(args.directorShifts) || !Array.isArray(args.hostShifts)) throw new Error("请分别提供 directorShifts 和 hostShifts 两份完整排班");
  const assignmentCount = args.directorShifts.length + args.hostShifts.length;
  if (assignmentCount < 1 || assignmentCount > 100) throw new Error("导演和主播排班合计请提供 1 至 100 个时段");
  const existingRoom = db.prepare("SELECT code,name FROM rooms WHERE code=?").get(roomCode);
  const roomName = existingRoom?.name ?? cleanMcpField(args.roomName, "直播间名称", 120);
  if (!roomName) throw new Error("新增直播间时请补充直播间名称");
  const lines = [`直播间编号：${roomCode}`, `直播间名称：${roomName}`, `排班日期：${date}`];
  for (const [index, shift] of args.directorShifts.entries()) {
    if (!shift || typeof shift !== "object" || Array.isArray(shift)) throw new Error(`第 ${index + 1} 个导演时段格式不正确`);
    const start = excelTime(shift.start);
    const end = excelTime(shift.end);
    if (!start || !end) throw new Error(`第 ${index + 1} 个导演时段的开始或结束时间无效`);
    lines.push("---", "排班类型：导演", `时段：${start}-${end}`, `导演：${cleanMcpField(shift.director, "导演", 80)}`);
  }
  for (const [index, shift] of args.hostShifts.entries()) {
    if (!shift || typeof shift !== "object" || Array.isArray(shift)) throw new Error(`第 ${index + 1} 个主播时段格式不正确`);
    const start = excelTime(shift.start);
    const end = excelTime(shift.end);
    if (!start || !end) throw new Error(`第 ${index + 1} 个主播时段的开始或结束时间无效`);
    const products = shift.featuredProducts ?? [];
    if (!Array.isArray(products) || products.length > 30) throw new Error(`第 ${index + 1} 个主播时段的商品列表格式不正确`);
    const productText = products.map((product) => cleanMcpField(product, "商品名称", 200)).filter(Boolean).join("；");
    const rawSalesTarget = shift.salesTarget == null ? "" : shift.salesTarget;
    if (!["string", "number"].includes(typeof rawSalesTarget)) throw new Error(`第 ${index + 1} 个主播时段的目标销售额格式不正确`);
    const salesTarget = cleanMcpField(rawSalesTarget, "目标销售额", 32);
    lines.push("---", "排班类型：主播", `时段：${start}-${end}`,
      `主播：${cleanMcpField(shift.host, "主播", 80)}`,
      `助播：${cleanMcpField(shift.assistant, "助播", 80)}`,
      `主推商品：${productText}`, `目标销售额：${salesTarget}`,
      `备注：${cleanMcpField(shift.notes, "备注", 500)}`);
  }
  return lines.join("\n");
}

function validateMcpRoomSchedulesPayload(payload) {
  const roomCode = cleanMcpField(payload?.roomCode, "直播间编号", 40);
  const roomName = cleanMcpField(payload?.roomName, "直播间名称", 120);
  if (!roomCode || !roomName) throw new Error("单直播间多日期预览信息不完整，请重新预览");
  if (!Array.isArray(payload?.schedules) || payload.schedules.length < 1 || payload.schedules.length > 100) {
    throw new Error("一次请提供 1 至 100 个日期的完整排班");
  }
  const seenDates = new Set();
  const parsedSchedules = payload.schedules.map((item) => {
    const date = cleanMcpField(item?.date, "日期", 10);
    if (seenDates.has(date)) throw new Error(`日期 ${date} 重复，请合并为一份完整日程`);
    seenDates.add(date);
    const text = String(item?.text ?? "");
    if (!text.trim() || text.length > 60_000) throw new Error("单个日期的排班内容为空或超过 60,000 个字符");
    const parsed = validateFixedScheduleText(text);
    if (parsed.roomCode !== roomCode || parsed.date !== date || parsed.roomName !== roomName) {
      throw new Error("多日期排班预览与目标直播间信息不一致，请重新预览");
    }
    if (parsed.result.errors.length) {
      const cause = new Error("排班内容未通过校验，请根据错误修正后重新预览");
      cause.details = parsed.result.errors;
      throw cause;
    }
    return { date, text, parsed };
  }).sort((a, b) => a.date.localeCompare(b.date));

  for (const [role, selectShifts] of [
    ["导演", (parsed) => parsed.result.rooms[0].directorShifts],
    ["主播", (parsed) => parsed.result.rooms[0].hostShifts],
  ]) {
    const incoming = parsedSchedules.flatMap(({ date, parsed }) => selectShifts(parsed).map((shift) => ({ ...shift, date })));
    incoming.sort((a, b) => a.startAt - b.startAt);
    const active = [];
    for (const shift of incoming) {
      for (let index = active.length - 1; index >= 0; index -= 1) {
        if (active[index].endAt <= shift.startAt) active.splice(index, 1);
      }
      const conflict = active.find((previous) => previous.date !== shift.date);
      if (conflict) {
        const cause = new Error(`提交的多日期${role}排班存在跨日时段重叠`);
        cause.details = [{
          sheet: `API-${roomCode}`, row: shift.sourceRow, field: `${role}排班时间`,
          message: `与 ${conflict.date} ${conflict.start}-${conflict.end} 重叠`,
        }];
        throw cause;
      }
      active.push(shift);
    }
  }

  const replacedDates = new Set(seenDates);
  const dates = parsedSchedules.map(({ parsed }) => mcpPreviewFor(parsed, replacedDates));
  return {
    roomCode,
    roomName,
    parsedSchedules,
    preview: {
      roomCode,
      roomName,
      dateCount: dates.length,
      scheduleCount: dates.reduce((count, day) => count + day.scheduleCount, 0),
      hostShiftCount: dates.reduce((count, day) => count + day.scheduleCount, 0),
      directorShiftCount: dates.reduce((count, day) => count + day.directorShiftCount, 0),
      assignmentCount: dates.reduce((count, day) => count + day.assignmentCount, 0),
      replacingSlots: dates.reduce((count, day) => count + day.replacingSlots, 0),
      replacingDirectorShifts: dates.reduce((count, day) => count + day.replacingDirectorShifts, 0),
      dates,
      warnings: dates.flatMap((day) => day.warnings),
    },
  };
}

function buildMcpRoomSchedulesPayload(args) {
  const roomCode = cleanMcpField(args?.roomCode, "直播间编号", 40);
  if (!roomCode) throw new Error("请先确认直播间编号");
  if (!Array.isArray(args?.schedules) || args.schedules.length < 1 || args.schedules.length > 100) {
    throw new Error("请提供 1 至 100 个日期的完整排班");
  }
  const existingRoom = db.prepare("SELECT name FROM rooms WHERE code=?").get(roomCode);
  const roomName = existingRoom?.name ?? cleanMcpField(args.roomName, "直播间名称", 120);
  if (!roomName) throw new Error("新增直播间时请补充直播间名称");
  const schedules = args.schedules.map((item) => {
    const date = cleanMcpField(item?.date, "日期", 10);
    return {
      date,
      text: fixedScheduleTextFromMcp({
        roomCode, roomName, date,
        directorShifts: item?.directorShifts,
        hostShifts: item?.hostShifts,
      }),
    };
  });
  const payload = { roomCode, roomName, schedules };
  return { payload, ...validateMcpRoomSchedulesPayload(payload) };
}

function mcpToolResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function mcpToolFailure(cause) {
  return mcpToolResult({ error: cause.message, details: cause.details ?? [] }, true);
}

function commitMcpRoomSchedulesPreview(row, tokenId) {
  let payload;
  try {
    payload = JSON.parse(row.schedule_text.slice(MCP_ROOM_BATCH_PREVIEW_PREFIX.length));
  } catch {
    throw new Error("多日期预览已损坏，请重新预览");
  }
  const { roomCode, roomName, parsedSchedules, preview } = validateMcpRoomSchedulesPayload(payload);
  const updateAt = nextDataUpdatedAt();
  let preservedPhotos = 0;
  const preservedByDate = new Map();
  try {
    db.exec("BEGIN IMMEDIATE");
    const currentTicket = db.prepare("SELECT id FROM mcp_previews WHERE id=? AND token_id=? AND expires_at>? ").get(row.id, tokenId, Date.now());
    if (!currentTicket || row.data_updated_at !== updatedAtValue()) throw new Error("预览已失效，请重新预览");
    const existingRoom = db.prepare("SELECT sort_order FROM rooms WHERE code=?").get(roomCode);
    if (existingRoom) {
      db.prepare("UPDATE rooms SET name=?,sheet_name=? WHERE code=?").run(roomName, "MCP 多日期排班更新", roomCode);
    } else {
      const order = db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM rooms").get().next;
      db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)").run(roomCode, roomName, "MCP 多日期排班更新", order);
    }
    const insertSlot = db.prepare(`INSERT INTO slots(
      id,room_code,date,start_time,end_time,starts_at,ends_at,director,host,assistant,
      products_json,sales_target_text,notes,photo_type,photo_blob
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertDirector = db.prepare(`INSERT INTO director_shifts(
      id,room_code,date,start_time,end_time,starts_at,ends_at,director
    ) VALUES (?,?,?,?,?,?,?,?)`);
    for (const { date, parsed } of parsedSchedules) {
      const previousSlots = db.prepare("SELECT * FROM slots WHERE room_code=? AND date=?").all(roomCode, date);
      const previousByKey = new Map(previousSlots.map((slot) => [`${slot.start_time}\u0000${slot.end_time}\u0000${slot.host}`, slot]));
      db.prepare("DELETE FROM slots WHERE room_code=? AND date=?").run(roomCode, date);
      db.prepare("DELETE FROM director_shifts WHERE room_code=? AND date=?").run(roomCode, date);
      let dayPreservedPhotos = 0;
      const schedule = parsed.result.rooms[0];
      for (const slot of schedule.hostShifts) {
        const previous = previousByKey.get(`${slot.start}\u0000${slot.end}\u0000${slot.host}`);
        if (previous?.photo_blob) {
          preservedPhotos += 1;
          dayPreservedPhotos += 1;
        }
        insertSlot.run(
          previous?.id ?? slot.id, roomCode, slot.date, slot.start, slot.end, slot.startAt, slot.endAt,
          "", slot.host, slot.assistant, JSON.stringify(slot.products), slot.salesTarget,
          slot.notes, previous?.photo_type ?? null, previous?.photo_blob ?? null,
        );
      }
      for (const shift of schedule.directorShifts) insertDirector.run(
        shift.id, roomCode, shift.date, shift.start, shift.end, shift.startAt, shift.endAt, shift.director,
      );
      preservedByDate.set(date, dayPreservedPhotos);
    }
    seedUniqueHostAvatars(parsedSchedules.flatMap(({ parsed }) => parsed.result.rooms[0].hostShifts));
    db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(updateAt);
    db.prepare("DELETE FROM mcp_previews WHERE id=?").run(row.id);
    db.exec("COMMIT");
  } catch (cause) {
    try { db.exec("ROLLBACK"); } catch {}
    throw new Error(cause.message === "预览已失效，请重新预览" ? cause.message : "提交失败，排班数据没有完成修改");
  }
  return {
    ok: true,
    roomCode,
    roomName,
    dateCount: preview.dateCount,
    scheduleCount: preview.scheduleCount,
    hostShiftCount: preview.hostShiftCount,
    directorShiftCount: preview.directorShiftCount,
    assignmentCount: preview.assignmentCount,
    preservedPhotos,
    dates: preview.dates.map((day) => ({
      date: day.date,
      replacingSlots: day.replacingSlots,
      replacingDirectorShifts: day.replacingDirectorShifts,
      scheduleCount: day.scheduleCount,
      directorShiftCount: day.directorShiftCount,
      assignmentCount: day.assignmentCount,
      preservedPhotos: preservedByDate.get(day.date) ?? 0,
    })),
    warnings: preview.warnings,
    dataUpdatedAt: updateAt,
  };
}

function commitMcpPreview(previewId, tokenId) {
  if (!/^[a-f\d]{48}$/i.test(previewId)) throw new Error("预览编号无效，请重新预览");
  const now = Date.now();
  const row = db.prepare("SELECT * FROM mcp_previews WHERE id=? AND token_id=? AND expires_at>? ").get(previewId, tokenId, now);
  if (!row) throw new Error("预览编号不存在、已使用或已过期，请重新预览");
  if (row.data_updated_at !== updatedAtValue()) throw new Error("预览后排班数据有更新，为避免覆盖新内容，请重新预览");
  if (row.schedule_text.startsWith(MCP_ROOM_BATCH_PREVIEW_PREFIX)) return commitMcpRoomSchedulesPreview(row, tokenId);
  const parsed = validateFixedScheduleText(row.schedule_text);
  const preview = mcpPreviewFor(parsed);
  let preservedPhotos = 0;
  const updateAt = nextDataUpdatedAt();
  try {
    db.exec("BEGIN IMMEDIATE");
    const currentTicket = db.prepare("SELECT id FROM mcp_previews WHERE id=? AND token_id=? AND expires_at>? ").get(previewId, tokenId, Date.now());
    if (!currentTicket || row.data_updated_at !== updatedAtValue()) throw new Error("预览已失效，请重新预览");
    const existingRoom = db.prepare("SELECT sort_order FROM rooms WHERE code=?").get(parsed.roomCode);
    const previousSlots = db.prepare("SELECT * FROM slots WHERE room_code=? AND date=?").all(parsed.roomCode, parsed.date);
    const previousByKey = new Map(previousSlots.map((slot) => [`${slot.start_time}\u0000${slot.end_time}\u0000${slot.host}`, slot]));
    if (existingRoom) {
      db.prepare("UPDATE rooms SET name=?,sheet_name=? WHERE code=?").run(parsed.roomName, "MCP 自然语言更新", parsed.roomCode);
    } else {
      const order = db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM rooms").get().next;
      db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)").run(parsed.roomCode, parsed.roomName, "MCP 自然语言更新", order);
    }
    db.prepare("DELETE FROM slots WHERE room_code=? AND date=?").run(parsed.roomCode, parsed.date);
    db.prepare("DELETE FROM director_shifts WHERE room_code=? AND date=?").run(parsed.roomCode, parsed.date);
    const insertSlot = db.prepare(`INSERT INTO slots(
      id,room_code,date,start_time,end_time,starts_at,ends_at,director,host,assistant,
      products_json,sales_target_text,notes,photo_type,photo_blob
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertDirector = db.prepare(`INSERT INTO director_shifts(
      id,room_code,date,start_time,end_time,starts_at,ends_at,director
    ) VALUES (?,?,?,?,?,?,?,?)`);
    const schedule = parsed.result.rooms[0];
    for (const slot of schedule.hostShifts) {
      const previous = previousByKey.get(`${slot.start}\u0000${slot.end}\u0000${slot.host}`);
      if (previous?.photo_blob) preservedPhotos += 1;
      insertSlot.run(
        previous?.id ?? slot.id, parsed.roomCode, slot.date, slot.start, slot.end, slot.startAt, slot.endAt,
        "", slot.host, slot.assistant, JSON.stringify(slot.products),
        slot.salesTarget, slot.notes, previous?.photo_type ?? null, previous?.photo_blob ?? null,
      );
    }
    for (const shift of schedule.directorShifts) insertDirector.run(
      shift.id, parsed.roomCode, shift.date, shift.start, shift.end, shift.startAt, shift.endAt, shift.director,
    );
    seedUniqueHostAvatars(schedule.hostShifts);
    db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(updateAt);
    db.prepare("DELETE FROM mcp_previews WHERE id=?").run(previewId);
    db.exec("COMMIT");
  } catch (cause) {
    try { db.exec("ROLLBACK"); } catch {}
    throw new Error(cause.message === "预览已失效，请重新预览" ? cause.message : "提交失败，排班数据没有完成修改");
  }
  return {
    ok: true, roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
    scheduleCount: preview.scheduleCount, directorShiftCount: preview.directorShiftCount,
    assignmentCount: preview.assignmentCount, preservedPhotos, warnings: preview.warnings, dataUpdatedAt: updateAt,
  };
}

async function callMcpTool(name, args, token) {
  if (name === "list_rooms") {
    const rooms = db.prepare(`SELECT r.code,r.name,r.sort_order AS sortOrder,
      (SELECT COUNT(*) FROM slots s WHERE s.room_code=r.code) AS scheduleCount,
      (SELECT COUNT(*) FROM director_shifts d WHERE d.room_code=r.code) AS directorShiftCount
      FROM rooms r ORDER BY r.sort_order`).all();
    return mcpToolResult({ rooms });
  }
  if (name === "get_room_schedule") {
    const roomCode = cleanMcpField(args?.roomCode, "直播间编号", 40);
    const date = cleanMcpField(args?.date, "日期", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || excelDate(date) !== date) throw new Error("日期格式应为 YYYY-MM-DD");
    const room = db.prepare("SELECT code,name FROM rooms WHERE code=?").get(roomCode);
    if (!room) throw new Error(`直播间编号 ${roomCode} 不存在，请先查看直播间列表`);
    const hostShifts = db.prepare("SELECT * FROM slots WHERE room_code=? AND date=? ORDER BY starts_at").all(roomCode, date).map((slot) => {
      const { avatar, hasLegacyPhoto } = slotHostAvatar(slot, slot.photo_blob);
      const hasPhoto = Boolean(avatar?.photo_type) || hasLegacyPhoto;
      return {
        start: slot.start_time, end: slot.end_time, host: slot.host, assistant: slot.assistant,
        featuredProducts: JSON.parse(slot.products_json), salesTarget: slotSalesTarget(slot),
        notes: slot.notes, hasPhoto, avatarSource: avatar?.photo_type ? "头像库" : hasPhoto ? "本场已有照片" : "未配置",
      };
    });
    const directorShifts = db.prepare("SELECT * FROM director_shifts WHERE room_code=? AND date=? ORDER BY starts_at").all(roomCode, date).map((shift) => ({
      start: shift.start_time, end: shift.end_time, director: shift.director,
    }));
    return mcpToolResult({ room, date, directorShifts, hostShifts });
  }
  if (name === "preview_schedule_update") {
    const scheduleText = fixedScheduleTextFromMcp(args);
    const parsed = validateFixedScheduleText(scheduleText);
    const preview = mcpPreviewFor(parsed);
    const now = Date.now();
    db.prepare("DELETE FROM mcp_previews WHERE expires_at<=?").run(now);
    db.prepare("DELETE FROM mcp_previews WHERE token_id=? AND id IN (SELECT id FROM mcp_previews WHERE token_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 20)").run(token.id, token.id);
    const previewId = randomBytes(24).toString("hex");
    const expiresAt = now + 10 * 60_000;
    db.prepare("INSERT INTO mcp_previews(id,token_id,schedule_text,data_updated_at,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .run(previewId, token.id, scheduleText, updatedAtValue(), now, expiresAt);
    return mcpToolResult({ previewId, expiresAt: new Date(expiresAt).toISOString(), preview });
  }
  if (name === "preview_room_schedules_update") {
    const { payload, preview } = buildMcpRoomSchedulesPayload(args);
    const now = Date.now();
    db.prepare("DELETE FROM mcp_previews WHERE expires_at<=?").run(now);
    db.prepare("DELETE FROM mcp_previews WHERE token_id=? AND id IN (SELECT id FROM mcp_previews WHERE token_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 20)").run(token.id, token.id);
    const previewId = randomBytes(24).toString("hex");
    const expiresAt = now + 10 * 60_000;
    db.prepare("INSERT INTO mcp_previews(id,token_id,schedule_text,data_updated_at,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .run(previewId, token.id, `${MCP_ROOM_BATCH_PREVIEW_PREFIX}${JSON.stringify(payload)}`, updatedAtValue(), now, expiresAt);
    return mcpToolResult({ previewId, expiresAt: new Date(expiresAt).toISOString(), preview });
  }
  if (name === "commit_schedule_update") {
    return mcpToolResult(commitMcpPreview(cleanMcpField(args?.previewId, "预览编号", 48), token.id));
  }
  throw Object.assign(new Error(`未知工具：${name}`), { rpcCode: -32602 });
}

function mcpRpcResponse(response, id, result, modern = false, cacheable = false) {
  const payload = modern ? {
    ...result,
    resultType: "complete",
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "live-room-display", version: "1.0.0" } },
    ...(cacheable ? { ttlMs: 0, cacheScope: "private" } : {}),
  } : result;
  return json(response, 200, { jsonrpc: "2.0", id, result: payload });
}

function decodeMcpHeaderValue(value) {
  const match = String(value ?? "").match(/^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/);
  if (!match) return String(value ?? "");
  const decoded = Buffer.from(match[1], "base64");
  if (decoded.toString("base64") !== match[1]) return "\u0000";
  return decoded.toString("utf8");
}

async function handleMcpRequest(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return response.end(JSON.stringify({ error: "MCP endpoint accepts POST requests only" }));
  }
  const origin = request.headers.origin;
  if (origin) {
    let originHost = "";
    try { originHost = new URL(origin).host; } catch {}
    const allowed = new Set([request.headers.host, ...(process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((value) => {
      try { return new URL(value.trim()).host; } catch { return ""; }
    })].filter(Boolean));
    if (!allowed.has(originHost)) return error(response, 403, "ORIGIN_REJECTED", "请求来源不允许");
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    return error(response, 415, "UNSUPPORTED_MEDIA_TYPE", "MCP 请求必须使用 application/json");
  }
  const authentication = authenticateIntegrationToken(request.headers.authorization ?? "");
  if (!authentication.token) {
    return error(response, authentication.status, authentication.code, authentication.message, [], { "www-authenticate": "Bearer" });
  }
  let message;
  try { message = await readJson(request); } catch (cause) {
    return error(response, cause.status ?? 400, "INVALID_REQUEST", cause.message);
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return json(response, 400, { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } });
  }
  const requestMeta = message.params?._meta;
  const requestedModernVersion = requestMeta?.["io.modelcontextprotocol/protocolVersion"];
  const modern = typeof requestedModernVersion === "string";
  if (!modern && request.headers["mcp-protocol-version"] === "2026-07-28") {
    return json(response, 400, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32020, message: "Header mismatch: the modern protocol version must also appear in request metadata" } });
  }
  if (modern) {
    const id = message.id ?? null;
    const protocolHeader = request.headers["mcp-protocol-version"] ?? "";
    const methodHeader = request.headers["mcp-method"] ?? "";
    const nameHeader = decodeMcpHeaderValue(request.headers["mcp-name"] ?? "");
    const expectedName = ["tools/call", "resources/read", "prompts/get"].includes(message.method)
      ? message.params?.name ?? message.params?.uri ?? "" : "";
    const headerMismatch = protocolHeader !== requestedModernVersion || methodHeader !== message.method ||
      (expectedName && nameHeader !== expectedName) || (!expectedName && nameHeader);
    if (headerMismatch) {
      return json(response, 400, { jsonrpc: "2.0", id, error: { code: -32020, message: "Header mismatch: MCP request headers must match the request body" } });
    }
    if (requestedModernVersion !== "2026-07-28") {
      return json(response, 400, { jsonrpc: "2.0", id, error: {
        code: -32022, message: "Unsupported protocol version",
        data: { supported: ["2026-07-28"], requested: requestedModernVersion },
      } });
    }
  }
  const id = message.id;
  const isNotification = id === undefined;
  if (isNotification && message.method.startsWith("notifications/")) {
    response.writeHead(202, { "cache-control": "no-store" });
    return response.end();
  }
  if (modern && message.method === "server/discover") {
    return mcpRpcResponse(response, id, {
      supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
      instructions: "用自然语言协助用户查看与更新直播间排班。主播头像由系统按姓名从头像库自动匹配；预览中的头像缺失警告需告知用户。修改时先调用预览工具并把目标直播间、日期、替换数量和完整时段摘要展示给用户；只有用户明确确认后才提交。信息缺失时先询问，不得猜测。",
    }, true, true);
  }
  if (message.method === "initialize" && !modern) {
    const supported = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
    const requested = message.params?.protocolVersion;
    if (typeof requested !== "string") return json(response, 400, { jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message: "protocolVersion is required" } });
    return mcpRpcResponse(response, id, {
      protocolVersion: supported.includes(requested) ? requested : "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "live-room-display", version: "1.0.0" },
      instructions: "用自然语言协助用户查看与更新直播间排班。主播头像由系统按姓名从头像库自动匹配；预览中的头像缺失警告需告知用户。修改时先调用预览工具并把目标直播间、日期、替换数量和完整时段摘要展示给用户；只有用户明确确认后才提交。信息缺失时先询问，不得猜测。",
    });
  }
  if (!modern && message.method === "ping") return mcpRpcResponse(response, id, {});
  if (message.method === "tools/list") return mcpRpcResponse(response, id, { tools: mcpTools }, modern, true);
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (typeof name !== "string" || !mcpTools.some((tool) => tool.name === name)) {
      return json(response, 200, { jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message: "Unknown tool" } });
    }
    try {
      const result = await callMcpTool(name, message.params?.arguments ?? {}, authentication.token);
      return mcpRpcResponse(response, id, result, modern);
    } catch (cause) {
      if (cause.rpcCode) return json(response, 200, { jsonrpc: "2.0", id: id ?? null, error: { code: cause.rpcCode, message: cause.message } });
      return mcpRpcResponse(response, id, mcpToolFailure(cause), modern);
    }
  }
  if (isNotification) {
    response.writeHead(202, { "cache-control": "no-store" });
    return response.end();
  }
  return json(response, modern ? 404 : 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

async function handle(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  if (request.method === "POST" && pathname === "/api/v1/auth/login") {
    let input;
    try { input = await readJson(request); } catch (cause) { return error(response, cause.status ?? 400, "INVALID_REQUEST", cause.message); }
    const username = String(input.username ?? "").trim();
    const loginKey = username.toLocaleLowerCase("zh-CN");
    const current = failures.get(loginKey);
    if (current && current.count >= 8 && current.until > Date.now()) return error(response, 429, "LOGIN_RATE_LIMIT", "尝试次数过多，请稍后再试");
    const user = db.prepare("SELECT id,username,role,password_hash FROM users WHERE username=? AND enabled=1").get(username);
    let valid = false;
    if (user) {
      const [, salt, expected] = user.password_hash.split("$");
      const actual = scryptSync(String(input.password ?? ""), Buffer.from(salt, "hex"), 64);
      const target = Buffer.from(expected, "hex");
      valid = actual.length === target.length && timingSafeEqual(actual, target);
    }
    if (!valid) {
      const next = current?.until > Date.now() ? { count: current.count + 1, until: current.until } : { count: 1, until: Date.now() + 15 * 60_000 };
      failures.set(loginKey, next);
      return error(response, 401, "LOGIN_FAILED", "用户名或密码不正确");
    }
    failures.delete(loginKey);
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 12 * 60 * 60_000;
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    db.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)").run(hashToken(token), user.id, csrf, expiresAt);
    const cookie = `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${cookieSecure ? "; Secure" : ""}`;
    return json(response, 200, { user: { id: user.id, username: user.username, role: user.role }, csrfToken: csrf }, { "set-cookie": cookie });
  }

  if (request.method === "GET" && pathname === "/api/v1/auth/me") {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200, { user: { id: user.id, username: user.username, role: user.role }, csrfToken: user.csrf_token });
  }

  if (request.method === "POST" && pathname === "/api/v1/auth/logout") {
    const user = requireUser(request, response);
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(user.token_hash);
    return json(response, 200, { ok: true }, { "set-cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure ? "; Secure" : ""}` });
  }

  const mediaMatch = pathname.match(/^\/api\/v1\/media\/([a-f\d]{32})$/i);
  if (request.method === "GET" && mediaMatch) {
    if (!requireUser(request, response)) return;
    const slot = db.prepare("SELECT host,photo_type,photo_blob FROM slots WHERE id=?").get(mediaMatch[1]);
    if (!slot?.photo_blob || deletedHostAvatarByNameKey.get(hostNameKey(slot.host))) {
      return error(response, 404, "MEDIA_NOT_FOUND", "照片不存在");
    }
    response.writeHead(200, { "content-type": slot.photo_type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
    return response.end(slot.photo_blob);
  }

  const avatarMediaMatch = pathname.match(/^\/api\/v1\/host-avatars\/([a-f\d]{32})\/media$/i);
  if (request.method === "GET" && avatarMediaMatch) {
    if (!requireUser(request, response)) return;
    const avatar = hostAvatarById.get(avatarMediaMatch[1]);
    if (!avatar?.photo_blob) return error(response, 404, "MEDIA_NOT_FOUND", "主播头像不存在");
    response.writeHead(200, { "content-type": avatar.photo_type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
    return response.end(avatar.photo_blob);
  }

  if (request.method === "GET" && pathname === "/api/v1/admin/host-avatars") {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    return json(response, 200, avatarLibraryPayload());
  }

  if (request.method === "GET" && pathname === "/api/v1/admin/schedules") {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    return json(response, 200, adminSchedulePayload());
  }

  if (request.method === "PUT" && pathname === "/api/v1/admin/schedules") {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    let input;
    try { input = await readJson(request); } catch (cause) {
      return error(response, cause.status ?? 400, "INVALID_REQUEST", cause.message);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return error(response, 400, "INVALID_REQUEST", "请求正文必须是 JSON 对象");
    }
    if (!Array.isArray(input.directorShifts) || !Array.isArray(input.hostShifts)) {
      return error(response, 400, "INVALID_REQUEST", "必须分别提供完整的导演班次和主播场次列表");
    }
    if (typeof input.dataUpdatedAt !== "string" || input.dataUpdatedAt !== updatedAtValue()) {
      return error(response, 409, "SCHEDULES_CHANGED", "排班数据已被其他操作更新，请刷新列表后重新修改");
    }

    const hostInput = Array.isArray(input.hostShifts) ? input.hostShifts : [];
    const directorInput = Array.isArray(input.directorShifts) ? input.directorShifts : [];
    const originalNotes = hostInput.map((slot) => typeof slot?.notes === "string" ? slot.notes.trim() : "");
    if (hostInput.some((slot) =>
      (slot?.salesTarget != null && !["string", "number"].includes(typeof slot.salesTarget)) ||
      (slot?.featuredProducts != null && (!Array.isArray(slot.featuredProducts) ||
        slot.featuredProducts.some((product) => typeof product !== "string")))
    )) {
      return error(response, 422, "SCHEDULE_INVALID", "主推商品和目标销售额格式不正确");
    }
    const editPayload = {
      ...input,
      directorShifts: directorInput.map((shift) => ({ ...shift })),
      hostShifts: hostInput.map((slot, index) => ({
        ...slot,
        // Keep merchandise values and multiline notes outside the line-based schedule parser.
        featuredProducts: [],
        salesTarget: "",
        notes: originalNotes[index].replace(/\r\n?/g, " ").replace(/\n/g, " ").trim(),
      })),
    };
    if (originalNotes.some((notes) => notes.length > 500)) {
      return error(response, 422, "SCHEDULE_INVALID", "备注不能超过 500 个字符");
    }
    let parsed;
    let preview;
    let sourceHostByKey;
    let sourceDirectorByKey;
    try {
      const scheduleText = fixedScheduleTextFromMcp(editPayload);
      parsed = validateFixedScheduleText(scheduleText);
      if (parsed.result.errors.length) {
        return json(response, 422, { error: { code: "SCHEDULE_INVALID", message: "排班内容未通过校验，请修正后重试", details: parsed.result.errors } });
      }
      if (!db.prepare("SELECT code FROM rooms WHERE code=?").get(parsed.roomCode)) {
        return error(response, 404, "ROOM_NOT_FOUND", "直播间不存在");
      }
      preview = mcpPreviewFor(parsed);
      sourceHostByKey = new Map(hostInput.map((slot, index) => [
        `${excelTime(slot.start)}\u0000${excelTime(slot.end)}\u0000${String(slot.host ?? "").trim()}`,
        { id: slot.id, products: slot.featuredProducts ?? [], salesTarget: String(slot.salesTarget ?? ""), notes: originalNotes[index] },
      ]));
      sourceDirectorByKey = new Map(editPayload.directorShifts.map((shift) => [
        `${excelTime(shift.start)}\u0000${excelTime(shift.end)}\u0000${String(shift.director ?? "").trim()}`,
        { id: shift.id },
      ]));
    } catch (cause) {
      return error(response, 422, "SCHEDULE_INVALID", cause.message, cause.details ?? []);
    }

    const updateAt = nextDataUpdatedAt();
    try {
      db.exec("BEGIN IMMEDIATE");
      if (input.dataUpdatedAt !== updatedAtValue()) throw new Error("SCHEDULES_CHANGED");
      const previousSlots = db.prepare("SELECT * FROM slots WHERE room_code=? AND date=?").all(parsed.roomCode, parsed.date);
      const previousByHostKey = new Map(previousSlots.map((slot) => [
        `${slot.start_time}\u0000${slot.end_time}\u0000${slot.host}`, slot,
      ]));
      const previousSlotById = new Map(previousSlots.map((slot) => [slot.id, slot]));
      const previousDirectors = db.prepare("SELECT * FROM director_shifts WHERE room_code=? AND date=?").all(parsed.roomCode, parsed.date);
      const previousDirectorByKey = new Map(previousDirectors.map((shift) => [
        `${shift.start_time}\u0000${shift.end_time}\u0000${shift.director}`, shift,
      ]));
      const previousDirectorById = new Map(previousDirectors.map((shift) => [shift.id, shift]));
      db.prepare("DELETE FROM slots WHERE room_code=? AND date=?").run(parsed.roomCode, parsed.date);
      db.prepare("DELETE FROM director_shifts WHERE room_code=? AND date=?").run(parsed.roomCode, parsed.date);
      const insertSlot = db.prepare(`INSERT INTO slots(
        id,room_code,date,start_time,end_time,starts_at,ends_at,director,host,assistant,
        products_json,sales_target_text,notes,photo_type,photo_blob
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertDirector = db.prepare(`INSERT INTO director_shifts(
        id,room_code,date,start_time,end_time,starts_at,ends_at,director
      ) VALUES (?,?,?,?,?,?,?,?)`);
      const schedule = parsed.result.rooms[0];
      for (const slot of schedule.hostShifts) {
        const source = sourceHostByKey.get(`${slot.start}\u0000${slot.end}\u0000${slot.host}`);
        const priorById = source?.id ? previousSlotById.get(source.id) : null;
        const previous = (priorById?.host === slot.host ? priorById : null)
          ?? previousByHostKey.get(`${slot.start}\u0000${slot.end}\u0000${slot.host}`);
        insertSlot.run(
          previous?.id ?? priorById?.id ?? slot.id, parsed.roomCode, slot.date, slot.start, slot.end, slot.startAt, slot.endAt,
          "", slot.host, slot.assistant, JSON.stringify(source?.products ?? slot.products), source?.salesTarget ?? slot.salesTarget,
          source?.notes ?? slot.notes, previous?.photo_type ?? null, previous?.photo_blob ?? null,
        );
      }
      for (const shift of schedule.directorShifts) {
        const source = sourceDirectorByKey.get(`${shift.start}\u0000${shift.end}\u0000${shift.director}`);
        const priorById = source?.id ? previousDirectorById.get(source.id) : null;
        const previous = (priorById?.director === shift.director ? priorById : null)
          ?? previousDirectorByKey.get(`${shift.start}\u0000${shift.end}\u0000${shift.director}`);
        insertDirector.run(
          previous?.id ?? priorById?.id ?? shift.id, parsed.roomCode, shift.date, shift.start, shift.end, shift.startAt, shift.endAt, shift.director,
        );
      }
      seedUniqueHostAvatars(schedule.hostShifts);
      db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(updateAt);
      db.exec("COMMIT");
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch {}
      if (cause.message === "SCHEDULES_CHANGED") {
        return error(response, 409, "SCHEDULES_CHANGED", "排班数据已被其他操作更新，请刷新列表后重新修改");
      }
      console.error("网页排班修改失败:", cause.message);
      return error(response, 500, "SCHEDULE_SAVE_FAILED", "保存失败，原有排班数据保持不变");
    }
    return json(response, 200, {
      ok: true, roomCode: parsed.roomCode, date: parsed.date,
      scheduleCount: preview.scheduleCount, directorShiftCount: preview.directorShiftCount, dataUpdatedAt: updateAt,
    });

  }

  if (request.method === "GET" && pathname === "/api/v1/admin/api-tokens") {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    return json(response, 200, apiTokenLibraryPayload());
  }

  if (request.method === "POST" && pathname === "/api/v1/admin/api-tokens") {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    const createWindow = uploadWindows.get(`api-tokens:${user.id}`);
    if (createWindow && createWindow.until > Date.now() && createWindow.count >= 5) {
      return error(response, 429, "TOKEN_CREATE_RATE_LIMIT", "密钥创建次数过多，请稍后再试");
    }
    let input;
    try { input = await readJson(request); } catch (cause) {
      return error(response, cause.status ?? 400, "INVALID_REQUEST", cause.message);
    }
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 80 || /[\r\n]/.test(name)) {
      return error(response, 400, "INVALID_TOKEN_NAME", "请输入密钥用途名称，最多 80 个字符且不能换行");
    }
    uploadWindows.set(`api-tokens:${user.id}`, createWindow?.until > Date.now()
      ? { count: createWindow.count + 1, until: createWindow.until }
      : { count: 1, until: Date.now() + 10 * 60_000 });
    const id = randomBytes(16).toString("hex");
    const token = `lrd_live_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    db.prepare("INSERT INTO api_tokens(id,name,token_hash,created_at) VALUES (?,?,?,?)")
      .run(id, name, hashToken(token), now);
    return json(response, 201, { ok: true, id, name, token, createdAt: new Date(now).toISOString(), ...apiTokenLibraryPayload() });
  }

  const adminApiTokenMatch = pathname.match(/^\/api\/v1\/admin\/api-tokens\/([a-f\d]{32})$/i);
  if (request.method === "DELETE" && adminApiTokenMatch) {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    const id = adminApiTokenMatch[1];
    const result = db.prepare("UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(Date.now(), id);
    if (!result.changes) return error(response, 404, "API_TOKEN_NOT_FOUND", "密钥不存在或已撤销");
    db.prepare("DELETE FROM mcp_previews WHERE token_id=?").run(id);
    return json(response, 200, { ok: true, ...apiTokenLibraryPayload() });
  }

  if (request.method === "POST" && pathname === "/api/v1/admin/host-avatars") {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    const uploadWindow = uploadWindows.get(`avatars:${user.id}`);
    if (uploadWindow && uploadWindow.until > Date.now() && uploadWindow.count >= 8) {
      return error(response, 429, "UPLOAD_RATE_LIMIT", "头像上传次数过多，请稍后再试");
    }
    uploadWindows.set(`avatars:${user.id}`, uploadWindow?.until > Date.now()
      ? { count: uploadWindow.count + 1, until: uploadWindow.until }
      : { count: 1, until: Date.now() + 10 * 60_000 });
    let upload;
    try { upload = await readAvatarUpload(request); } catch (cause) {
      return error(response, cause.status ?? 400, "AVATAR_UPLOAD_INVALID", cause.message);
    }
    const existing = upload.prepared.filter((item) => hostAvatarByNameKey.get(item.nameKey)?.photo_type);
    if (existing.length && !upload.replaceExisting) {
      return error(response, 409, "AVATAR_REPLACEMENT_CONFIRMATION_REQUIRED", "部分主播已有头像，请确认是否替换", existing.map((item) => ({ name: item.name })));
    }
    const now = Date.now();
    const createdCount = upload.prepared.filter((item) => !hostAvatarByNameKey.get(item.nameKey)?.photo_type).length;
    const updatedCount = upload.prepared.length - createdCount;
    try {
      db.exec("BEGIN IMMEDIATE");
      const saveAvatar = db.prepare(`INSERT INTO host_avatars(
        id,name,name_key,photo_type,photo_blob,photo_hash,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(name_key) DO UPDATE SET
        name=excluded.name,photo_type=excluded.photo_type,photo_blob=excluded.photo_blob,
        photo_hash=excluded.photo_hash,updated_at=excluded.updated_at`);
      for (const item of upload.prepared) {
        saveAvatar.run(randomBytes(16).toString("hex"), item.name, item.nameKey, item.photoType, item.bytes, item.photoHash, now, now);
        restoreHostAvatarName.run(item.nameKey);
      }
      db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(nextDataUpdatedAt());
      db.exec("COMMIT");
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch {}
      console.error("主播头像库更新失败:", cause.message);
      return error(response, 500, "AVATAR_SAVE_FAILED", "头像保存失败，现有头像保持不变");
    }
    return json(response, 200, { ok: true, createdCount, updatedCount, dataUpdatedAt: new Date(now).toISOString(), ...avatarLibraryPayload() });
  }

  const adminAvatarMatch = pathname.match(/^\/api\/v1\/admin\/host-avatars\/([a-f\d]{32})$/i);
  if (request.method === "PATCH" && adminAvatarMatch) {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    let input;
    try { input = await readJson(request); } catch (cause) {
      return error(response, cause.status ?? 400, "INVALID_REQUEST", cause.message);
    }
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    const key = hostNameKey(name);
    if (!key || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || typeof input?.expectedName !== "string") {
      return error(response, 422, "AVATAR_NAME_INVALID", "请填写有效的主播姓名，最多 80 个字符");
    }
    const id = adminAvatarMatch[1];
    let result;
    try {
      db.exec("BEGIN IMMEDIATE");
      const avatar = db.prepare("SELECT name,name_key,updated_at FROM host_avatars WHERE id=?").get(id);
      const reject = (status, code, message) => Object.assign(new Error(message), { status, code });
      if (!avatar) throw reject(404, "AVATAR_NOT_FOUND", "主播档案不存在");
      if (avatar.name !== input.expectedName) {
        throw reject(409, "AVATAR_NAME_CHANGED", "主播姓名已更新，请刷新头像库后再编辑");
      }
      result = { ok: true, updatedScheduleCount: 0, dataUpdatedAt: updatedAtValue() };
      if (avatar.name !== name) {
        const other = hostAvatarByNameKey.get(key);
        const hosts = db.prepare("SELECT DISTINCT host FROM slots WHERE host<>''").all().map(({ host }) => host);
        if ((other && other.id !== id) || (key !== avatar.name_key && hosts.some((host) => hostNameKey(host) === key))) {
          throw reject(409, "AVATAR_NAME_CONFLICT", "这个姓名已被其他主播档案或排班使用，请填写可区分的姓名");
        }
        const updateHost = db.prepare("UPDATE slots SET host=? WHERE host=?");
        for (const host of hosts) {
          if (host !== name && hostNameKey(host) === avatar.name_key) {
            result.updatedScheduleCount += Number(updateHost.run(name, host).changes);
          }
        }
        db.prepare("UPDATE host_avatars SET name=?,name_key=?,updated_at=? WHERE id=?")
          .run(name, key, Math.max(Date.now(), avatar.updated_at + 1), id);
        restoreHostAvatarName.run(key);
        result.dataUpdatedAt = nextDataUpdatedAt();
        db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(result.dataUpdatedAt);
      }
      db.exec("COMMIT");
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch {}
      if (cause.status) return error(response, cause.status, cause.code, cause.message);
      console.error("主播改名失败:", cause.code ?? "AVATAR_RENAME_FAILED");
      return error(response, 500, "AVATAR_RENAME_FAILED", "保存姓名失败，请稍后重试");
    }
    return json(response, 200, { ...result, ...avatarLibraryPayload() });
  }
  if (request.method === "DELETE" && adminAvatarMatch) {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    const avatar = hostAvatarById.get(adminAvatarMatch[1]);
    if (!avatar) return error(response, 404, "AVATAR_NOT_FOUND", "没有找到这位主播");
    const now = Date.now();
    db.prepare("UPDATE host_avatars SET photo_type=NULL,photo_blob=NULL,photo_hash=NULL,updated_at=? WHERE id=?").run(now, avatar.id);
    db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(nextDataUpdatedAt());
    return json(response, 200, { ok: true, dataUpdatedAt: new Date(now).toISOString(), ...avatarLibraryPayload() });
  }

  const adminHostProfileMatch = pathname.match(/^\/api\/v1\/admin\/host-avatars\/([a-f\d]{32})\/profile$/i);
  if (request.method === "DELETE" && adminHostProfileMatch) {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    let input;
    try { input = await readJson(request); } catch (cause) {
      return error(response, cause.status ?? 400, "INVALID_REQUEST", cause.message);
    }
    if (typeof input?.expectedName !== "string") {
      return error(response, 422, "AVATAR_NAME_INVALID", "请确认要删除的主播姓名");
    }
    const id = adminHostProfileMatch[1];
    let dataUpdatedAt;
    try {
      db.exec("BEGIN IMMEDIATE");
      const avatar = db.prepare("SELECT name,name_key FROM host_avatars WHERE id=?").get(id);
      if (!avatar || avatar.name !== input.expectedName) {
        db.exec("ROLLBACK");
        if (!avatar) return error(response, 404, "AVATAR_NOT_FOUND", "主播档案不存在");
        return error(response, 409, "AVATAR_NAME_CHANGED", "主播姓名已更新，请刷新头像库后再删除");
      }
      db.prepare("INSERT OR IGNORE INTO deleted_host_avatar_names(name_key) VALUES (?)").run(avatar.name_key);
      db.prepare("DELETE FROM host_avatars WHERE id=?").run(id);
      dataUpdatedAt = nextDataUpdatedAt();
      db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(dataUpdatedAt);
      db.exec("COMMIT");
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch {}
      console.error("删除主播失败:", cause.code ?? "AVATAR_DELETE_FAILED");
      return error(response, 500, "AVATAR_DELETE_FAILED", "删除主播失败，请稍后重试");
    }
    return json(response, 200, { ok: true, dataUpdatedAt, ...avatarLibraryPayload() });
  }

  if (request.method === "GET" && pathname === "/api/v1/rooms") {
    if (!requireUser(request, response)) return;
    return json(response, 200, { rooms: roomList() });
  }
  if (request.method === "GET" && pathname === "/api/v1/admin/rooms") {
    if (!requireUser(request, response, "admin")) return;
    return json(response, 200, adminRoomsPayload());
  }
  const adminRoomMatch = pathname.match(/^\/api\/v1\/admin\/rooms\/([^/]+)(\/avatar)?$/);
  if (adminRoomMatch) {
    const isAvatar = Boolean(adminRoomMatch[2]);
    if (request.method === "DELETE" || request.method === (isAvatar ? "PUT" : "PATCH")) {
      return manageRoom(request, response, adminRoomMatch[1], isAvatar);
    }
  }
  const roomAvatarMatch = pathname.match(/^\/api\/v1\/rooms\/([^/]+)\/avatar$/);
  if (request.method === "GET" && roomAvatarMatch) {
    if (!requireUser(request, response)) return;
    const avatar = db.prepare("SELECT photo_type,photo_blob FROM room_avatars WHERE room_code=?").get(roomAvatarMatch[1]);
    if (!avatar) return error(response, 404, "MEDIA_NOT_FOUND", "直播间未配置头像");
    response.writeHead(200, { "content-type": avatar.photo_type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
    return response.end(avatar.photo_blob);
  }

  const displayMatch = pathname.match(/^\/api\/v1\/rooms\/([^/]+)\/display$/);
  if (request.method === "GET" && displayMatch) {
    if (!requireUser(request, response)) return;
    const code = displayMatch[1];
    const room = db.prepare("SELECT code,name FROM rooms WHERE code=?").get(code);
    if (!room) return error(response, 404, "ROOM_NOT_FOUND", "直播间不存在");
    const { today, yesterday } = currentShanghaiDay();
    const schedule = db.prepare("SELECT * FROM slots WHERE room_code=? AND date IN (?,?) ORDER BY starts_at").all(code, today, yesterday).map(publicSlot);
    const directorShifts = db.prepare("SELECT * FROM director_shifts WHERE room_code=? AND date IN (?,?) ORDER BY starts_at").all(code, today, yesterday).map(publicDirectorShift);
    const dataUpdatedAt = db.prepare("SELECT value FROM app_state WHERE key='data_updated_at'").get().value;
    const transitions = [...schedule, ...directorShifts].flatMap((shift) => [shift.startsAt, shift.endsAt]).filter((value) => value > Date.now());
    return json(response, 200, {
      dataUpdatedAt, serverNow: new Date().toISOString(), timeZone: "Asia/Shanghai",
      room, schedule, directorShifts, nextTransitionAt: transitions.length ? Math.min(...transitions) : null,
    });
  }

  const scheduleMatch = pathname.match(/^\/api\/v1\/rooms\/([^/]+)\/schedule$/);
  if (request.method === "GET" && scheduleMatch) {
    if (!requireUser(request, response)) return;
    const date = url.searchParams.get("date") ?? shanghaiDate(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return error(response, 400, "INVALID_DATE", "日期格式应为 YYYY-MM-DD");
    const room = db.prepare("SELECT code FROM rooms WHERE code=?").get(scheduleMatch[1]);
    if (!room) return error(response, 404, "ROOM_NOT_FOUND", "直播间不存在");
    const schedule = db.prepare("SELECT * FROM slots WHERE room_code=? AND date=? ORDER BY starts_at").all(room.code, date).map(publicSlot);
    const directorShifts = db.prepare("SELECT * FROM director_shifts WHERE room_code=? AND date=? ORDER BY starts_at").all(room.code, date).map(publicDirectorShift);
    return json(response, 200, { date, schedule, directorShifts });
  }

  if (request.method === "POST" && ["/api/v1/integrations/schedule-text/preview", "/api/v1/integrations/schedule-text/commit"].includes(pathname)) {
    const token = requireIntegrationToken(request, response);
    if (!token) return;
    let input;
    try { input = await readJson(request); } catch (cause) {
      return error(response, cause.status ?? 400, "INVALID_REQUEST", cause.message);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return error(response, 400, "INVALID_REQUEST", "请求正文必须是 JSON 对象");
    if (typeof input.text !== "string") return error(response, 400, "TEXT_REQUIRED", "请在 text 字段中提供排班文本");

    let parsed;
    try { parsed = validateFixedScheduleText(input.text); } catch (cause) {
      return error(response, 422, "TEXT_FORMAT_INVALID", cause.message, cause.details ?? []);
    }
    const { result } = parsed;
    const hostShiftCount = result.rooms.reduce((count, room) => count + room.hostShifts.length, 0);
    const directorShiftCount = result.rooms.reduce((count, room) => count + room.directorShifts.length, 0);
    if (result.errors.length) {
      return json(response, 422, {
        ok: false, roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
        scheduleCount: hostShiftCount, directorShiftCount, errors: result.errors, warnings: parsed.warnings,
      });
    }

    const schedule = result.rooms[0];
    const schedulePreview = mcpPreviewFor(parsed);
    if (pathname.endsWith("/preview")) {
      return json(response, 200, { ok: true, preview: schedulePreview });
    }
    if (input.confirmReplace !== true) {
      return error(response, 409, "REPLACEMENT_CONFIRMATION_REQUIRED", "提交前请先预览内容，并在用户确认后设置 confirmReplace=true");
    }

    const existingRoom = db.prepare("SELECT sort_order FROM rooms WHERE code=?").get(parsed.roomCode);
    const previousSlots = db.prepare("SELECT * FROM slots WHERE room_code=? AND date=?").all(parsed.roomCode, parsed.date);
    const previousByKey = new Map(previousSlots.map((slot) => [
      `${slot.start_time}\u0000${slot.end_time}\u0000${slot.host}`,
      slot,
    ]));
    const previousDirectors = db.prepare("SELECT * FROM director_shifts WHERE room_code=? AND date=?").all(parsed.roomCode, parsed.date);
    const previousDirectorByKey = new Map(previousDirectors.map((shift) => [
      `${shift.start_time}\u0000${shift.end_time}\u0000${shift.director}`, shift,
    ]));
    let preservedPhotos = 0;
    const updateAt = nextDataUpdatedAt();
    try {
      db.exec("BEGIN IMMEDIATE");
      if (existingRoom) {
        db.prepare("UPDATE rooms SET name=?,sheet_name=? WHERE code=?").run(parsed.roomName, "API 文本更新", parsed.roomCode);
      } else {
        const order = db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM rooms").get().next;
        db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)").run(parsed.roomCode, parsed.roomName, "API 文本更新", order);
      }
      db.prepare("DELETE FROM slots WHERE room_code=? AND date=?").run(parsed.roomCode, parsed.date);
      db.prepare("DELETE FROM director_shifts WHERE room_code=? AND date=?").run(parsed.roomCode, parsed.date);
      const insertSlot = db.prepare(`INSERT INTO slots(
        id,room_code,date,start_time,end_time,starts_at,ends_at,director,host,assistant,
        products_json,sales_target_text,notes,photo_type,photo_blob
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertDirector = db.prepare(`INSERT INTO director_shifts(
        id,room_code,date,start_time,end_time,starts_at,ends_at,director
      ) VALUES (?,?,?,?,?,?,?,?)`);
      for (const slot of schedule.hostShifts) {
        const previous = previousByKey.get(`${slot.start}\u0000${slot.end}\u0000${slot.host}`);
        if (previous?.photo_blob) preservedPhotos += 1;
        insertSlot.run(
          previous?.id ?? slot.id, parsed.roomCode, slot.date, slot.start, slot.end, slot.startAt, slot.endAt,
          "", slot.host, slot.assistant, JSON.stringify(slot.products),
          slot.salesTarget, slot.notes, previous?.photo_type ?? null, previous?.photo_blob ?? null,
        );
      }
      for (const shift of schedule.directorShifts) {
        const previous = previousDirectorByKey.get(`${shift.start}\u0000${shift.end}\u0000${shift.director}`);
        insertDirector.run(previous?.id ?? shift.id, parsed.roomCode, shift.date, shift.start, shift.end, shift.startAt, shift.endAt, shift.director);
      }
      seedUniqueHostAvatars(schedule.hostShifts);
      db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(updateAt);
      db.exec("COMMIT");
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch {}
      console.error("API 排班更新失败:", cause.message);
      return error(response, 500, "SCHEDULE_UPDATE_FAILED", "更新失败，现有排班数据已保留");
    }
    return json(response, 200, {
      ok: true, roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
      scheduleCount: schedule.hostShifts.length, directorShiftCount: schedule.directorShifts.length,
      preservedPhotos, warnings: schedulePreview.warnings, dataUpdatedAt: updateAt,
    });
  }

  if (pathname === "/mcp") return handleMcpRequest(request, response);

  if (request.method === "GET" && pathname === "/api/v1/admin/schedule-upload/rooms") {
    if (!requireUser(request, response, "admin")) return;
    return json(response, 200, { rooms: staffRoomCatalog() });
  }

  if (request.method === "POST" && pathname === "/api/v1/admin/schedule-upload") {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    const action = url.searchParams.get("action");
    if (url.searchParams.get("mode") !== "room-name" || !["preview", "commit"].includes(action)) {
      return error(response, 400, "UPLOAD_MODE_INVALID", "请刷新页面后使用员工排班表导入");
    }
    if (action === "commit") {
      let input;
      try { input = await readJson(request); } catch (cause) {
        return error(response, cause.status ?? 400, "INVALID_REQUEST", cause.message);
      }
      if (typeof input?.previewId !== "string" || !/^[a-f0-9]{48}$/.test(input.previewId)) {
        return error(response, 400, "INVALID_PREVIEW", "请先生成排班预览");
      }
      try {
        return json(response, 200, commitStaffImport(input.previewId, user.id));
      } catch (cause) {
        if (cause.status === 409) return error(response, 409, "PREVIEW_EXPIRED", cause.message);
        console.error("员工排班表导入失败:", cause.code ?? "IMPORT_FAILED");
        return error(response, 500, "IMPORT_FAILED", "更新失败，请重新预览后再试");
      }
    }

    const now = Date.now();
    let uploadWindow = uploadWindows.get(user.id);
    if (!uploadWindow || uploadWindow.until <= now) {
      uploadWindow = { count: 0, until: now + 10 * 60_000 };
      uploadWindows.set(user.id, uploadWindow);
    }
    if (uploadWindow.count >= 20) return error(response, 429, "UPLOAD_RATE_LIMIT", "上传次数过多，请稍后再试");
    uploadWindow.count += 1;
    let workbook, bindings;
    try {
      const upload = await readUpload(request);
      workbook = parseXlsx(upload.file);
      bindings = upload.bindings;
    } catch (cause) {
      return error(response, cause.status ?? 422, "WORKBOOK_READ_FAILED", cause.message);
    }
    const parsed = parseStaffSchedule(workbook, excelDate);
    if (parsed.errors.length) return json(response, 422, { errors: parsed.errors, warnings: parsed.warnings });
    const { sourceRooms, rooms, unmatchedRooms, errors } = resolveStaffRooms(parsed.rooms, bindings);
    const grouped = [...rooms, ...unmatchedRooms];
    if (grouped.length > NUMBERED_ROOM_CODES.length) {
      errors.push({ field: "直播间", message: "一次最多导入 27 个直播间" });
    }
    const conflicts = errors.length ? errors : normalizeStaffShifts(grouped, parsed.warnings);
    if (conflicts.length) return json(response, 422, {
      errors: conflicts, warnings: parsed.warnings, sourceRooms, roomOptions: staffRoomCatalog(),
    });
    const summary = staffImportSummary(grouped, parsed.warnings);
    if (unmatchedRooms.length) return json(response, 200, {
      status: "needs_mapping", sourceRooms, roomOptions: staffRoomCatalog(), summary, warnings: parsed.warnings,
    });
    const existingConflicts = staffImportConflicts(rooms);
    if (existingConflicts.length) return json(response, 422, { errors: existingConflicts, warnings: parsed.warnings });
    const previewId = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + STAFF_PREVIEW_TTL;
    if (staffPreviews.size >= 64) staffPreviews.delete(staffPreviews.keys().next().value);
    staffPreviews.set(previewId, { userId: user.id, version: updatedAtValue(), rooms, summary, expiresAt });
    return json(response, 200, {
      status: "ready", previewId, expiresAt, sourceRooms, roomOptions: staffRoomCatalog(),
      rooms: staffPreviewRooms(rooms), summary, warnings: parsed.warnings,
    });
  }

  if (pathname.startsWith("/api/")) return error(response, 404, "NOT_FOUND", "接口不存在");

  if (request.method.startsWith("GET") && process.env.NODE_ENV === "production") {
    const distRoot = path.resolve(root, "dist");
    const requested = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.resolve(distRoot, `.${requested}`);
    if (!filePath.startsWith(`${distRoot}${path.sep}`) && filePath !== distRoot) return error(response, 403, "FORBIDDEN", "无权访问");
    const selected = filePath.endsWith(path.sep) ? path.join(filePath, "index.html") : filePath;
    try {
      const stat = await import("node:fs/promises").then(({ stat }) => stat(selected));
      if (!stat.isFile()) return error(response, 404, "NOT_FOUND", "页面不存在");
      response.writeHead(200, {
        "content-type": MIME[path.extname(selected).toLowerCase()] ?? "application/octet-stream",
        "content-length": stat.size, "x-content-type-options": "nosniff",
      });
      return createReadStream(selected).pipe(response);
    } catch {
      const selectedIndex = path.join(distRoot, "index.html");
      try {
        const stat = await import("node:fs/promises").then(({ stat }) => stat(selectedIndex));
        response.writeHead(200, { "content-type": MIME[".html"], "content-length": stat.size });
        return createReadStream(selectedIndex).pipe(response);
      } catch {
        return error(response, 404, "NOT_FOUND", "页面文件尚未构建");
      }
    }
  }

  return error(response, 404, "NOT_FOUND", "接口不存在");
}

const server = createServer((request, response) => {
  handle(request, response).catch((cause) => {
    console.error("请求处理失败:", cause.message);
    if (!response.headersSent) error(response, 500, "INTERNAL_ERROR", "服务暂时不可用");
    else response.destroy();
  });
});

const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => console.log(`直播间信息服务已启动：http://${host}:${server.address().port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => {
    db.close();
    process.exit(0);
  }));
}
