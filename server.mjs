import { createServer } from "node:http";
import { createReadStream, mkdirSync } from "node:fs";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseXlsx, cellHasFormula, cellValue } from "./server/xlsx.mjs";

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
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, sheet_name TEXT NOT NULL, sort_order INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
    director TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '', assistant TEXT NOT NULL DEFAULT '',
    products_json TEXT NOT NULL DEFAULT '[]', sales_target_cents INTEGER,
    notes TEXT NOT NULL DEFAULT '', photo_type TEXT, photo_blob BLOB
  );
  CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO app_state(key, value) VALUES ('data_updated_at', '');
`);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const sessions = db.prepare("SELECT s.token_hash,s.csrf_token,s.expires_at,u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND u.enabled=1");
const failures = new Map();
const uploadWindows = new Map();
const cookieName = "lrd_session";
const cookieSecure = process.env.NODE_ENV === "production" && process.env.SECURE_COOKIES !== "false";

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  response.end(JSON.stringify(value));
}

function error(response, status, code, message, details = []) {
  json(response, status, { error: { code, message, details } });
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
      const file = body.subarray(headerEnd + 4, dataEnd);
      if (!filename.toLowerCase().endsWith(".xlsx")) throw Object.assign(new Error("只支持 .xlsx 文件"), { status: 415 });
      if (file.length === 0) throw Object.assign(new Error("所选文件为空"), { status: 400 });
      return file;
    }
    cursor = next;
  }
  throw Object.assign(new Error("没有找到待上传的工作簿"), { status: 400 });
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

function parseMoney(value) {
  if (value === "" || value == null) return null;
  const text = String(value).trim().replace(/,/g, "");
  const match = text.match(/^(?:¥|￥)?\s*(\d+(?:\.\d+)?)\s*(万元|万|元)?$/);
  if (!match) return NaN;
  const number = Number(match[1]);
  const multiplier = match[2]?.startsWith("万") ? 10_000 : 1;
  return Math.round(number * multiplier * 100);
}

function shanghaiDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function salesDisplay(cents) {
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

    const headers = new Map();
    for (const [column, cell] of sheet.rows.get(3) ?? []) {
      const label = String(cell.value ?? "").trim();
      if (label) headers.set(label, column);
    }
    const requiredHeaders = ["日期", "开始时间", "结束时间", "导演", "主播", "助播", "主播照片", "主推商品", "目标销售额", "备注"];
    for (const label of requiredHeaders) {
      if (!headers.has(label)) pushError(sheet.name, 3, label, `第 3 行缺少“${label}”列`);
    }
    const column = (label) => headers.get(label) ?? "";
    const slots = [];
    for (const [rowNumber, cells] of [...sheet.rows.entries()].filter(([row]) => row >= 4).sort(([a], [b]) => a - b)) {
      const hasValues = [...cells.values()].some((cell) => String(cell.value ?? "").trim() !== "");
      const rowImages = sheet.images.get(rowNumber) ?? [];
      if (!hasValues && !rowImages.length) continue;
      const read = (label) => column(label) ? cellValue(sheet, rowNumber, column(label)) : "";
      for (const label of requiredHeaders) {
        const col = column(label);
        if (col && cellHasFormula(sheet, rowNumber, col)) pushError(sheet.name, rowNumber, label, "请使用固定值，不支持公式");
      }
      const date = excelDate(read("日期"));
      const start = excelTime(read("开始时间"));
      const end = excelTime(read("结束时间"));
      if (!date) pushError(sheet.name, rowNumber, "日期", "请填写有效日期，例如 2026-11-10");
      if (!start) pushError(sheet.name, rowNumber, "开始时间", "请填写有效时间，例如 07:00");
      if (!end) pushError(sheet.name, rowNumber, "结束时间", "请填写有效时间，例如 11:00");
      const startAt = date && start ? Date.parse(`${date}T${start}:00+08:00`) : 0;
      let endAt = date && end ? Date.parse(`${date}T${end}:00+08:00`) : 0;
      if (date && start && end && endAt <= startAt) {
        if (endAt === startAt) pushError(sheet.name, rowNumber, "结束时间", "开始和结束时间不能相同");
        else endAt += 86_400_000;
      }
      const director = String(read("导演") ?? "").trim();
      const host = String(read("主播") ?? "").trim();
      const assistant = String(read("助播") ?? "").trim();
      const products = String(read("主推商品") ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      const salesTargetCents = parseMoney(read("目标销售额"));
      if (Number.isNaN(salesTargetCents)) pushError(sheet.name, rowNumber, "目标销售额", "金额请填写数字、元或万元，例如 200000 或 20万");
      if (!director) pushWarning(sheet.name, rowNumber, "导演", "未填写导演");
      if (!host) pushWarning(sheet.name, rowNumber, "主播", "未填写主播");
      if (!assistant) pushWarning(sheet.name, rowNumber, "助播", "未填写助播");
      if (!rowImages.length) pushWarning(sheet.name, rowNumber, "主播照片", "未添加主播照片");
      if (!products.length) pushWarning(sheet.name, rowNumber, "主推商品", "未填写主推商品");
      if (salesTargetCents == null) pushWarning(sheet.name, rowNumber, "目标销售额", "未填写目标销售额");
      if (rowImages.length > 1) pushError(sheet.name, rowNumber, "主播照片", "每场排班最多添加一张照片");
      if (rowImages.some((image) => image.columnNumber !== 6)) pushError(sheet.name, rowNumber, "主播照片", "请将照片锚定在 G 列对应排班行");
      const image = rowImages[0] ?? null;
      if (date && start && end) {
        slots.push({
          id: randomBytes(16).toString("hex"), sourceRow: rowNumber, date, start, end, startAt, endAt,
          director, host, assistant, products, salesTargetCents,
          notes: String(read("备注") ?? "").trim(), photo: image,
        });
      }
    }
    slots.sort((a, b) => a.startAt - b.startAt);
    for (let index = 1; index < slots.length; index += 1) {
      if (slots[index].startAt < slots[index - 1].endAt) {
        pushError(sheet.name, slots[index].sourceRow, "排班时间", "同一直播间的排班时间发生重叠");
      }
    }
    for (const [rowNumber, images] of sheet.images) {
      if (rowNumber >= 4 && !sheet.rows.has(rowNumber)) pushError(sheet.name, rowNumber, "主播照片", "照片所在行没有排班单元格");
    }
    if (name && code) rooms.push({ code, name, sheetName: sheet.name, slots });
  }
  return { rooms, errors, warnings };
}

function currentShanghaiDay() {
  const today = shanghaiDate(new Date());
  const yesterday = new Date(`${today}T00:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return { today, yesterday: shanghaiDate(yesterday) };
}

function publicSlot(slot) {
  const products = JSON.parse(slot.products_json);
  return {
    id: slot.id, date: slot.date, start: slot.start_time, end: slot.end_time,
    director: slot.director, host: slot.host, assistant: slot.assistant,
    featuredProducts: products, salesTarget: salesDisplay(slot.sales_target_cents),
    photo: slot.photo_type ? `/api/v1/media/${encodeURIComponent(slot.id)}` : null,
    startsAt: slot.starts_at, endsAt: slot.ends_at,
  };
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
    failures.delete(ip);
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
    const slot = db.prepare("SELECT photo_type,photo_blob FROM slots WHERE id=?").get(mediaMatch[1]);
    if (!slot?.photo_blob) return error(response, 404, "MEDIA_NOT_FOUND", "照片不存在");
    response.writeHead(200, { "content-type": slot.photo_type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
    return response.end(slot.photo_blob);
  }

  if (request.method === "GET" && pathname === "/api/v1/rooms") {
    if (!requireUser(request, response)) return;
    return json(response, 200, { rooms: db.prepare("SELECT code,name,sort_order AS sortOrder FROM rooms ORDER BY sort_order").all() });
  }

  const displayMatch = pathname.match(/^\/api\/v1\/rooms\/([^/]+)\/display$/);
  if (request.method === "GET" && displayMatch) {
    if (!requireUser(request, response)) return;
    const code = displayMatch[1];
    const room = db.prepare("SELECT code,name FROM rooms WHERE code=?").get(code);
    if (!room) return error(response, 404, "ROOM_NOT_FOUND", "直播间不存在");
    const { today, yesterday } = currentShanghaiDay();
    const schedule = db.prepare("SELECT * FROM slots WHERE room_code=? AND date IN (?,?) ORDER BY starts_at").all(code, today, yesterday).map(publicSlot);
    const dataUpdatedAt = db.prepare("SELECT value FROM app_state WHERE key='data_updated_at'").get().value;
    const transitions = schedule.flatMap((slot) => [slot.startsAt, slot.endsAt]).filter((value) => value > Date.now());
    return json(response, 200, {
      dataUpdatedAt, serverNow: new Date().toISOString(), timeZone: "Asia/Shanghai",
      room, schedule, nextTransitionAt: transitions.length ? Math.min(...transitions) : null,
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
    return json(response, 200, { date, schedule });
  }

  if (request.method === "POST" && pathname === "/api/v1/admin/schedule-upload") {
    const user = requireUser(request, response, "admin");
    if (!user) return;
    if (!csrfValid(request, user)) return error(response, 403, "CSRF_FAILED", "请求校验失败，请刷新页面后重试");
    const uploadWindow = uploadWindows.get(user.id);
    if (uploadWindow && uploadWindow.until > Date.now() && uploadWindow.count >= 8) {
      return error(response, 429, "UPLOAD_RATE_LIMIT", "上传次数过多，请稍后再试");
    }
    uploadWindows.set(user.id, uploadWindow?.until > Date.now()
      ? { count: uploadWindow.count + 1, until: uploadWindow.until }
      : { count: 1, until: Date.now() + 10 * 60_000 });
    let workbook;
    try {
      const bytes = await readUpload(request);
      workbook = parseXlsx(bytes);
    } catch (cause) {
      return error(response, cause.status ?? 422, "WORKBOOK_READ_FAILED", cause.message, []);
    }
    const result = validateWorkbook(workbook);
    const slotCount = result.rooms.reduce((count, room) => count + room.slots.length, 0);
    if (result.errors.length) {
      return json(response, 422, {
        ok: false, roomCount: result.rooms.length, scheduleCount: slotCount,
        errors: result.errors, warnings: result.warnings,
      });
    }
    const updateAt = new Date().toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("DELETE FROM rooms");
      const insertRoom = db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)");
      const insertSlot = db.prepare(`INSERT INTO slots(
        id,room_code,date,start_time,end_time,starts_at,ends_at,director,host,assistant,
        products_json,sales_target_cents,notes,photo_type,photo_blob
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      result.rooms.forEach((room, order) => {
        insertRoom.run(room.code, room.name, room.sheetName, order);
        for (const slot of room.slots) {
          insertSlot.run(
            slot.id, room.code, slot.date, slot.start, slot.end, slot.startAt, slot.endAt,
            slot.director, slot.host, slot.assistant, JSON.stringify(slot.products),
            slot.salesTargetCents, slot.notes, slot.photo?.contentType ?? null, slot.photo?.bytes ?? null,
          );
        }
      });
      db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(updateAt);
      db.exec("COMMIT");
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch {}
      console.error("工作簿更新失败:", cause.message);
      return error(response, 500, "IMPORT_FAILED", "更新失败，现有排班数据已保留");
    }
    return json(response, 200, {
      ok: true, roomCount: result.rooms.length, scheduleCount: slotCount,
      warnings: result.warnings, dataUpdatedAt: updateAt,
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
server.listen(port, host, () => console.log(`直播间信息服务已启动：http://${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => {
    db.close();
    process.exit(0);
  }));
}
