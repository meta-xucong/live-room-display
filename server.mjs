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
const integrationTokens = db.prepare("SELECT id,name FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL");
const failures = new Map();
const uploadWindows = new Map();
const integrationWindows = new Map();
const cookieName = "lrd_session";
const cookieSecure = process.env.NODE_ENV === "production" && process.env.SECURE_COOKIES !== "false";
const previewCleanup = setInterval(() => {
  try { db.prepare("DELETE FROM mcp_previews WHERE expires_at<=?").run(Date.now()); } catch {}
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
  if (sections.length < 2) fixedTextError("请先填写直播间信息，再用单独一行“---”分隔排班时段");
  if (sections.length > 101) fixedTextError("一次最多提交 100 个排班时段");

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

  const slotFields = ["时段", "导演", "主播", "助播", "主推商品", "目标销售额", "备注"];
  const headers = ["日期", "开始时间", "结束时间", "导演", "主播", "助播", "主播照片", "主推商品", "目标销售额", "备注"];
  const rows = new Map([
    [1, new Map([["B", { value: roomName }], ["E", { value: roomCode }]])],
    [3, new Map(headers.map((label, index) => [String.fromCharCode(65 + index), { value: label }]))],
  ]);

  sections.slice(1).forEach((section, index) => {
    const rowNumber = index + 4;
    const fields = parseFixedFields(section, index + 2, slotFields, slotFields);
    const period = fields.get("时段");
    const range = period.match(/^(\d{1,2}:\d{2})\s*(?:-|–|—|至|到)\s*(\d{1,2}:\d{2})$/);
    if (!range) fixedTextError("时段请按“07:00-11:00”填写", "时段", rowNumber);
    const products = fields.get("主推商品").replace(/[；;、]/g, "\n");
    const values = [date, range[1], range[2], fields.get("导演"), fields.get("主播"), fields.get("助播"), "", products, fields.get("目标销售额"), fields.get("备注")];
    rows.set(rowNumber, new Map(values.map((value, column) => [String.fromCharCode(65 + column), { value }])));
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
    sheet: parsed.sheet.name, row: "", field: "主播照片",
    message: "文本接口不上传照片；相同时段和主播的既有照片会保留，新增或更换主播请通过 Excel 上传照片",
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
  return {
    id: slot.id, date: slot.date, start: slot.start_time, end: slot.end_time,
    director: slot.director, host: slot.host, assistant: slot.assistant,
    featuredProducts: products, salesTarget: salesDisplay(slot.sales_target_cents),
    photo: slot.photo_type ? `/api/v1/media/${encodeURIComponent(slot.id)}` : null,
    startsAt: slot.starts_at, endsAt: slot.ends_at,
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
    description: "查看指定直播间某一天的完整排班。日期必须由用户提供或确认。只读。",
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
    description: "按自然语言整理好的直播间和排班内容生成预览，不会写入数据。必须先展示预览并等待用户明确确认，才能调用 commit_schedule_update。不得补造用户没有提供的日期、时段或人员。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["roomCode", "date", "slots"],
      properties: {
        roomCode: { type: "string", description: "直播间编号" },
        roomName: { type: "string", description: "新增直播间时必填；已有直播间会使用系统中的名称" },
        date: { type: "string", description: "排班日期，格式 YYYY-MM-DD" },
        slots: {
          type: "array", minItems: 1, maxItems: 100,
          description: "该直播间该日期的全部时段；提交会替换这一天的完整排班",
          items: {
            type: "object", additionalProperties: false, required: ["start", "end"],
            properties: {
              start: { type: "string", description: "开始时间，24 小时制，例如 07:00" },
              end: { type: "string", description: "结束时间，24 小时制，例如 11:00" },
              director: { type: "string" }, host: { type: "string" }, assistant: { type: "string" },
              featuredProducts: { type: "array", items: { type: "string" }, maxItems: 30 },
              salesTarget: { oneOf: [{ type: "string" }, { type: "number" }] },
              notes: { type: "string" },
            },
          },
        },
      },
    },
    annotations: { title: "预览排班修改", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "commit_schedule_update",
    title: "确认并提交排班",
    description: "提交 preview_schedule_update 返回的预览编号。仅当用户在看到目标直播间、日期、替换时段数和完整排班预览后明确同意，才能调用。一次性预览编号 10 分钟有效；期间任何排班数据更新都会使其失效。",
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

function mcpPreviewFor(parsed) {
  const slots = parsed.result.rooms[0].slots;
  if (parsed.result.errors.length) {
    const cause = new Error("排班内容未通过校验，请根据错误修正后重新预览");
    cause.details = parsed.result.errors;
    throw cause;
  }
  const adjacentSlots = db.prepare("SELECT date,start_time,end_time,starts_at,ends_at FROM slots WHERE room_code=? AND date IN (?,?)")
    .all(parsed.roomCode, calendarDayOffset(parsed.date, -1), calendarDayOffset(parsed.date, 1));
  const conflicts = slots.flatMap((slot, index) => adjacentSlots
    .filter((existing) => slot.startAt < existing.ends_at && existing.starts_at < slot.endAt)
    .map((existing) => ({
      sheet: parsed.sheet.name, row: index + 4, field: "排班时间",
      message: `与相邻日期 ${existing.date} ${existing.start_time}-${existing.end_time} 的现有排班重叠`,
    })));
  if (conflicts.length) {
    const cause = new Error("排班与相邻日期的跨日时段冲突，请先处理冲突后重新预览");
    cause.details = conflicts;
    throw cause;
  }
  const replacingSlots = db.prepare("SELECT COUNT(*) AS count FROM slots WHERE room_code=? AND date=?").get(parsed.roomCode, parsed.date).count;
  return {
    roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
    replacingSlots, scheduleCount: slots.length,
    schedule: slots.map((slot) => ({
      start: slot.start, end: slot.end, director: slot.director, host: slot.host,
      assistant: slot.assistant, featuredProducts: slot.products,
      salesTarget: salesDisplay(slot.salesTargetCents), notes: slot.notes,
    })),
    warnings: parsed.warnings,
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
  if (!Array.isArray(args.slots) || args.slots.length < 1 || args.slots.length > 100) throw new Error("请提供 1 至 100 个时段，并包含这一天的全部排班");
  const existingRoom = db.prepare("SELECT code,name FROM rooms WHERE code=?").get(roomCode);
  const roomName = existingRoom?.name ?? cleanMcpField(args.roomName, "直播间名称", 120);
  if (!roomName) throw new Error("新增直播间时请补充直播间名称");
  const lines = [`直播间编号：${roomCode}`, `直播间名称：${roomName}`, `排班日期：${date}`];
  for (const [index, slot] of args.slots.entries()) {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) throw new Error(`第 ${index + 1} 个时段格式不正确`);
    const start = excelTime(slot.start);
    const end = excelTime(slot.end);
    if (!start || !end) throw new Error(`第 ${index + 1} 个时段的开始或结束时间无效`);
    const products = slot.featuredProducts ?? [];
    if (!Array.isArray(products) || products.length > 30) throw new Error(`第 ${index + 1} 个时段的商品列表格式不正确`);
    const productText = products.map((product) => cleanMcpField(product, "商品名称", 200)).filter(Boolean).join("；");
    const rawSalesTarget = slot.salesTarget == null ? "" : slot.salesTarget;
    if (!["string", "number"].includes(typeof rawSalesTarget)) throw new Error(`第 ${index + 1} 个时段的目标销售额格式不正确`);
    const salesTarget = cleanMcpField(rawSalesTarget, "目标销售额", 32);
    lines.push("---", `时段：${start}-${end}`,
      `导演：${cleanMcpField(slot.director, "导演", 80)}`,
      `主播：${cleanMcpField(slot.host, "主播", 80)}`,
      `助播：${cleanMcpField(slot.assistant, "助播", 80)}`,
      `主推商品：${productText}`, `目标销售额：${salesTarget}`,
      `备注：${cleanMcpField(slot.notes, "备注", 500)}`);
  }
  return lines.join("\n");
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

function commitMcpPreview(previewId, tokenId) {
  if (!/^[a-f\d]{48}$/i.test(previewId)) throw new Error("预览编号无效，请重新预览");
  const now = Date.now();
  const row = db.prepare("SELECT * FROM mcp_previews WHERE id=? AND token_id=? AND expires_at>? ").get(previewId, tokenId, now);
  if (!row) throw new Error("预览编号不存在、已使用或已过期，请重新预览");
  if (row.data_updated_at !== updatedAtValue()) throw new Error("预览后排班数据有更新，为避免覆盖新内容，请重新预览");
  const parsed = validateFixedScheduleText(row.schedule_text);
  const preview = mcpPreviewFor(parsed);
  let preservedPhotos = 0;
  const updateAt = new Date().toISOString();
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
    const insertSlot = db.prepare(`INSERT INTO slots(
      id,room_code,date,start_time,end_time,starts_at,ends_at,director,host,assistant,
      products_json,sales_target_cents,notes,photo_type,photo_blob
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const slot of parsed.result.rooms[0].slots) {
      const previous = previousByKey.get(`${slot.start}\u0000${slot.end}\u0000${slot.host}`);
      if (previous?.photo_blob) preservedPhotos += 1;
      insertSlot.run(
        previous?.id ?? slot.id, parsed.roomCode, slot.date, slot.start, slot.end, slot.startAt, slot.endAt,
        slot.director, slot.host, slot.assistant, JSON.stringify(slot.products),
        slot.salesTargetCents, slot.notes, previous?.photo_type ?? null, previous?.photo_blob ?? null,
      );
    }
    db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(updateAt);
    db.prepare("DELETE FROM mcp_previews WHERE id=?").run(previewId);
    db.exec("COMMIT");
  } catch (cause) {
    try { db.exec("ROLLBACK"); } catch {}
    throw new Error(cause.message === "预览已失效，请重新预览" ? cause.message : "提交失败，排班数据没有完成修改");
  }
  return {
    ok: true, roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
    scheduleCount: preview.scheduleCount, preservedPhotos, warnings: parsed.warnings, dataUpdatedAt: updateAt,
  };
}

async function callMcpTool(name, args, token) {
  if (name === "list_rooms") {
    const rooms = db.prepare(`SELECT r.code,r.name,r.sort_order AS sortOrder,
      (SELECT COUNT(*) FROM slots s WHERE s.room_code=r.code) AS scheduleCount
      FROM rooms r ORDER BY r.sort_order`).all();
    return mcpToolResult({ rooms });
  }
  if (name === "get_room_schedule") {
    const roomCode = cleanMcpField(args?.roomCode, "直播间编号", 40);
    const date = cleanMcpField(args?.date, "日期", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || excelDate(date) !== date) throw new Error("日期格式应为 YYYY-MM-DD");
    const room = db.prepare("SELECT code,name FROM rooms WHERE code=?").get(roomCode);
    if (!room) throw new Error(`直播间编号 ${roomCode} 不存在，请先查看直播间列表`);
    const schedule = db.prepare("SELECT * FROM slots WHERE room_code=? AND date=? ORDER BY starts_at").all(roomCode, date).map((slot) => ({
      start: slot.start_time, end: slot.end_time, director: slot.director, host: slot.host, assistant: slot.assistant,
      featuredProducts: JSON.parse(slot.products_json), salesTarget: salesDisplay(slot.sales_target_cents),
      notes: slot.notes, hasPhoto: Boolean(slot.photo_blob),
    }));
    return mcpToolResult({ room, date, schedule });
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
      instructions: "用自然语言协助用户查看与更新直播间排班。修改时先调用预览工具并把目标直播间、日期、替换数量和完整时段摘要展示给用户；只有用户明确确认后才提交。信息缺失时先询问，不得猜测。",
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
      instructions: "用自然语言协助用户查看与更新直播间排班。修改时先调用预览工具并把目标直播间、日期、替换数量和完整时段摘要展示给用户；只有用户明确确认后才提交。信息缺失时先询问，不得猜测。",
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
    const slotCount = result.rooms.reduce((count, room) => count + room.slots.length, 0);
    if (result.errors.length) {
      return json(response, 422, {
        ok: false, roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
        scheduleCount: slotCount, errors: result.errors, warnings: parsed.warnings,
      });
    }

    const slots = result.rooms[0].slots;
    const adjacentSlots = db.prepare("SELECT date,start_time,end_time,starts_at,ends_at FROM slots WHERE room_code=? AND date IN (?,?)")
      .all(parsed.roomCode, calendarDayOffset(parsed.date, -1), calendarDayOffset(parsed.date, 1));
    const boundaryConflicts = slots.flatMap((slot, index) => adjacentSlots
      .filter((existing) => slot.startAt < existing.ends_at && existing.starts_at < slot.endAt)
      .map((existing) => ({
        sheet: parsed.sheet.name, row: index + 4, field: "排班时间",
        message: `与相邻日期 ${existing.date} ${existing.start_time}-${existing.end_time} 的现有排班重叠`,
      })));
    if (boundaryConflicts.length) {
      return json(response, 422, {
        ok: false, roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
        scheduleCount: slots.length, errors: boundaryConflicts, warnings: parsed.warnings,
      });
    }
    const existingCount = db.prepare("SELECT COUNT(*) AS count FROM slots WHERE room_code=? AND date=?").get(parsed.roomCode, parsed.date).count;
    if (pathname.endsWith("/preview")) {
      return json(response, 200, {
        ok: true,
        preview: {
          roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
          replacingSlots: existingCount, scheduleCount: slots.length,
          schedule: slots.map((slot) => ({
            start: slot.start, end: slot.end, director: slot.director, host: slot.host,
            assistant: slot.assistant, featuredProducts: slot.products,
            salesTarget: salesDisplay(slot.salesTargetCents), notes: slot.notes,
          })),
          warnings: parsed.warnings,
        },
      });
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
    let preservedPhotos = 0;
    const updateAt = new Date().toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      if (existingRoom) {
        db.prepare("UPDATE rooms SET name=?,sheet_name=? WHERE code=?").run(parsed.roomName, "API 文本更新", parsed.roomCode);
      } else {
        const order = db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM rooms").get().next;
        db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)").run(parsed.roomCode, parsed.roomName, "API 文本更新", order);
      }
      db.prepare("DELETE FROM slots WHERE room_code=? AND date=?").run(parsed.roomCode, parsed.date);
      const insertSlot = db.prepare(`INSERT INTO slots(
        id,room_code,date,start_time,end_time,starts_at,ends_at,director,host,assistant,
        products_json,sales_target_cents,notes,photo_type,photo_blob
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const slot of slots) {
        const previous = previousByKey.get(`${slot.start}\u0000${slot.end}\u0000${slot.host}`);
        if (previous?.photo_blob) preservedPhotos += 1;
        insertSlot.run(
          previous?.id ?? slot.id, parsed.roomCode, slot.date, slot.start, slot.end, slot.startAt, slot.endAt,
          slot.director, slot.host, slot.assistant, JSON.stringify(slot.products),
          slot.salesTargetCents, slot.notes, previous?.photo_type ?? null, previous?.photo_blob ?? null,
        );
      }
      db.prepare("UPDATE app_state SET value=? WHERE key='data_updated_at'").run(updateAt);
      db.exec("COMMIT");
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch {}
      console.error("API 排班更新失败:", cause.message);
      return error(response, 500, "SCHEDULE_UPDATE_FAILED", "更新失败，现有排班数据已保留");
    }
    return json(response, 200, {
      ok: true, roomCode: parsed.roomCode, roomName: parsed.roomName, date: parsed.date,
      scheduleCount: slots.length, preservedPhotos, warnings: parsed.warnings, dataUpdatedAt: updateAt,
    });
  }

  if (pathname === "/mcp") return handleMcpRequest(request, response);

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
