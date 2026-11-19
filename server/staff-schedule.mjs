import { randomBytes } from "node:crypto";
import { cellHasFormula, cellValue } from "./xlsx.mjs";

const required = ["日期", "直播间", "主播时间", "主播", "导演时间", "导演"];
const roles = [
  { role: "主播", name: "host", records: "hostShifts" },
  { role: "导演", name: "director", records: "directorShifts" },
];

export function roomNameKey(name) {
  return String(name ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function scheduleRange(value, date) {
  const range = value.normalize("NFKC").match(/^(\d{1,2}:\d{2})\s*[-–—－~至到]\s*(\d{1,2}:\d{2})$/);
  if (!range) return null;
  const [, startText, endText] = range;
  const start = startText.padStart(5, "0");
  const end = endText.padStart(5, "0").replace(/^24:00$/, "00:00");
  if (![start, end].every((time) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) || start === end) return null;
  const startAt = Date.parse(`${date}T${start}:00+08:00`);
  const overnight = end < start;
  const endAt = Date.parse(`${date}T${end}:00+08:00`) + (overnight ? 86_400_000 : 0);
  return { start, end, startAt, endAt, overnight };
}

export function parseStaffSchedule(sheets, parseDate) {
  const rooms = new Map();
  const errors = [];
  const warnings = [];
  let rowCount = 0;
  const report = (list, sheet, row, column, field, message, date = "", room = "") =>
    list.push({ sheet, row, column, field, message, date, room });

  for (const sheet of sheets) {
    const rows = [...sheet.rows.entries()].filter(([, cells]) => [...cells.values()].some(
      (cell) => cell.formula || String(cell.value ?? "").trim(),
    )).sort(([a], [b]) => a - b);
    if (!rows.length) continue;
    rowCount += rows.length - 1;
    if (rowCount > 5000) {
      report(errors, sheet.name, "", "", "排班行数", "一次最多导入 5,000 行排班，请拆成多个工作簿");
      break;
    }
    const [headerRow, cells] = rows[0];
    const columns = new Map();
    for (const [column, cell] of cells) {
      const label = String(cell.value ?? "").trim();
      if (!required.includes(label)) continue;
      if (columns.has(label) || cell.formula) {
        report(errors, sheet.name, headerRow, column, label, "表头必须唯一并使用固定文字");
      }
      columns.set(label, column);
    }
    const missing = required.filter((label) => !columns.has(label));
    if (missing.length) {
      report(errors, sheet.name, headerRow, "", "表头", `缺少：${missing.join("、")}`);
      continue;
    }

    let date = "";
    let room = null;
    for (const [row] of rows.slice(1)) {
      const raw = (field) => cellValue(sheet, row, columns.get(field));
      const text = (field) => String(raw(field)).trim();
      const issue = (list, field, message) => report(list, sheet.name, row, columns.get(field), field, message, date, room?.name);
      const formulas = required.filter((field) => cellHasFormula(sheet, row, columns.get(field)));
      if (formulas.length) {
        for (const field of formulas) issue(errors, field, "请填写固定值");
        if (formulas.includes("日期")) date = "";
        if (formulas.includes("日期") || formulas.includes("直播间")) room = null;
        continue;
      }
      if (text("日期")) {
        const value = raw("日期");
        const serial = /^\d+(?:\.\d+)?$/.test(text("日期")) ? Number(value) : null;
        const parsed = serial === null ? parseDate(value) : parseDate(serial + (sheet.date1904 ? 1462 : 0));
        const next = /^\d{4}-\d{2}-\d{2}$/.test(parsed) && parsed >= "1900-03-01" ? parsed : "";
        if (date !== next) room = null;
        date = next;
        if (!date) issue(errors, "日期", "请填写有效日期，例如 2026-11-19");
      }
      const roomText = text("直播间");
      if (roomText) {
        const key = roomNameKey(roomText);
        room = null;
        if (roomText.length > 120 || !key) issue(errors, "直播间", "直播间名称须为 1–120 个字符");
        else if (!date) issue(errors, "日期", "直播间所属日期缺失");
        else {
          if (!rooms.has(key)) rooms.set(key, {
            key, name: roomText, sheetName: sheet.name, sourceRow: row,
            dates: new Map(), hostShifts: [], directorShifts: [],
          });
          room = rooms.get(key);
        }
      }
      if (room && date && !room.dates.has(date)) room.dates.set(date, { sheet: sheet.name, row, count: 0 });
      for (const entry of roles) {
        const { role } = entry;
        const timeField = `${role}时间`;
        const time = text(timeField);
        const person = text(role);
        if (!time && !person) continue;
        if (!date || !room) {
          issue(errors, !date ? "日期" : "直播间", "该排班行缺少所属日期或直播间");
          break;
        }
        const range = time ? scheduleRange(time, date) : null;
        if (!range) issue(errors, timeField, "请填写有效的起止时间，例如 08:00-12:00");
        else if (!person) issue(warnings, role, "有时段但缺少姓名，已跳过此班次");
        else if (person.length > 80) issue(errors, role, "姓名不能超过 80 个字符");
        else {
          room[entry.records].push({
            id: randomBytes(16).toString("hex"), date, sourceSheet: sheet.name, sourceRow: row,
            ...range, [entry.name]: person,
          });
          room.dates.get(date).count += 1;
        }
      }
    }
  }

  const active = [];
  for (const room of rooms.values()) {
    for (const [date, group] of room.dates) {
      if (!group.count) {
        report(warnings, group.sheet, group.row, "", "排班", "当天没有有效班次，将跳过此日期", date, room.name);
        room.dates.delete(date);
      }
    }
    if (!room.dates.size) continue;
    for (const { role, records } of roles) {
      room[records].sort((a, b) => a.startAt - b.startAt);
      let previous = null;
      for (const shift of room[records]) {
        if (previous && shift.startAt < previous.endAt) {
          report(errors, shift.sourceSheet, shift.sourceRow, "", `${role}时间`,
            `与 ${previous.sourceSheet} 第 ${previous.sourceRow} 行的同角色排班重叠`, shift.date, room.name);
        }
        if (!previous || shift.endAt > previous.endAt) previous = shift;
      }
    }
    active.push(room);
  }
  if (!active.length && !errors.length) report(errors, "", "", "", "排班", "文件中没有可导入的排班");
  if (rooms.size > 27) report(errors, "", "", "", "直播间", "一次最多导入 27 个直播间");
  return { rooms: active, errors, warnings };
}
