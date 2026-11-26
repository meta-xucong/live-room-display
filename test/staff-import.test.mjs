import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { crc32 } from "node:zlib";
import { cellValue, parseXlsx } from "../server/xlsx.mjs";

function zip(entries) {
  const content = [], directory = [];
  let offset = 0;
  for (const [path, xml] of Object.entries(entries)) {
    const name = Buffer.from(path), bytes = Buffer.from(xml);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    local.copy(central, 8, 6, 30);
    central.writeUInt32LE(offset, 42);
    content.push(local, name, bytes);
    directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(directory.reduce((length, bytes) => length + bytes.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...content, ...directory, end]);
}

function workbook(rows, date1904 = false, withMerchandise = false) {
  const headers = ["日期", "星期", "直播间", "主播时间", "主播", "导演时间", "导演", "休"];
  if (withMerchandise) headers.push("主推商品", "目标销售额");
  return scheduleWorkbook([{ name: "Sheet1", headers, rows }], date1904);
}

function scheduleWorkbook(sheets, date1904 = false) {
  const entries = {
    "xl/workbook.xml": '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr date1904="' + Number(date1904) + '"/><sheets>' +
      sheets.map(({ name }, index) => `<sheet name="${name}" r:id="r${index + 1}"/>`).join("") + "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels": "<Relationships>" + sheets.map((_, index) =>
      `<Relationship Id="r${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join("") + "</Relationships>",
  };
  for (const [index, { headers, rows }] of sheets.entries()) {
    entries[`xl/worksheets/sheet${index + 1}.xml`] = "<worksheet><sheetData>" + [headers, ...rows].map((row, r) =>
      "<row>" + row.map((value, column) => {
        if (!value) return "";
        const address = `${String.fromCharCode(65 + column)}${r + 1}`;
        if (value.formula) return `<c r="${address}"><f>${value.formula}</f><v>0</v></c>`;
        return `<c r="${address}" t="inlineStr"><is><t>${value}</t></is></c>`;
      }).join("") + "</row>").join("") + "</sheetData></worksheet>";
  }
  return zip(entries);
}

async function withServer(run, prepareDatabase) {
  const root = resolve(tmpdir());
  const data = await mkdtemp(join(root, "lrd-test-staff-"));
  if (prepareDatabase) {
    const fixture = new DatabaseSync(join(data, "live-room.sqlite"));
    try { prepareDatabase(fixture); } finally { fixture.close(); }
  }
  const child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, DATA_DIR: data, NODE_ENV: "development", HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let db, logs = "";
  const stopped = once(child, "exit");
  child.stderr.on("data", (text) => { logs += text; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timed out " + logs)), 10000);
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(logs)); });
      child.stdout.on("data", (chunk) => {
        const address = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address) { clearTimeout(timeout); resolve(address); }
      });
    });
    db = new DatabaseSync(join(data, "live-room.sqlite"));
    const addUser = (id, role) => {
      db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES (?,?,?,?)").run(id, id, "", role);
      const raw = randomBytes(32).toString("base64url");
      db.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)")
        .run(createHash("sha256").update(raw).digest("hex"), id, "csrf-" + id, Date.now() + 60_000);
      return { cookie: "lrd_session=" + raw, "x-csrf-token": "csrf-" + id };
    };
    const admin = addUser("admin", "admin");
    const other = addUser("other", "admin");
    const viewer = addUser("viewer", "viewer");
    const request = async (path, options) => {
      const response = await fetch(url + path, { ...options, signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() };
    };
    const preview = (file, bindings = {}, headers = admin, mode = "room-name") => {
      const body = new FormData();
      body.append("file", new Blob([file]), "schedule.xlsx");
      body.append("roomBindings", JSON.stringify(bindings));
      return request("/api/v1/admin/schedule-upload?action=preview&mode=" + mode, { method: "POST", headers, body });
    };
    const commit = (previewId, headers = admin) => request("/api/v1/admin/schedule-upload?action=commit&mode=room-name", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ previewId }),
    });
    await run({ db, admin, other, viewer, preview, commit, request, url });
  } finally {
    db?.close();
    child.kill();
    await stopped;
    if (dirname(data) === root) await rm(data, { recursive: true, force: true });
  }
}

test("room mapping, date scope, independent roles and idempotent commit", () => withServer(async ({ db, admin, other, viewer, preview, commit, request }) => {
  const room = db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)");
  room.run("01", "Alpha", "Old", 0);
  room.run("02", "Beta", "Old", 1);
  room.run("03", "Outside", "Old", 2);
  const start = Date.parse("2026-11-19T08:00:00+08:00");
  const end = Date.parse("2026-11-19T12:00:00+08:00");
  const addHost = db.prepare("INSERT INTO slots(id,room_code,date,start_time,end_time,starts_at,ends_at,host,assistant,products_json,sales_target_cents,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  addHost.run("keep", "01", "2026-11-19", "08:00", "12:00", start, end, "Host A", "Assistant", '["Product"]', 50000, "Note");
  addHost.run("outside", "03", "2026-11-19", "08:00", "12:00", start, end, "Outside", "", "[]", null, "");
  addHost.run("blank-day", "01", "2026-11-21", "08:00", "12:00", start + 2 * 86400000, end + 2 * 86400000, "Retained", "", "[]", null, "");
  db.prepare("INSERT INTO director_shifts VALUES (?,?,?,?,?,?,?,?)")
    .run("old-director", "01", "2026-11-20", "08:00", "12:00", start + 86400000, end + 86400000, "Old");
  const data = workbook([
    ["46345", "", "Ａlpha", "8:00-12:00", "Host A", "21:00-00:30", "Director A"],
    ["", "", "", "", "", "8:00-12:00", ""],
    ["", "", "Beta Name", "", "", "10:00-12:00", "Director B"],
    ["46346", "", "Alpha", "09:00-11:00", "Host B"],
    ["", "", "Gamma", "10:00-12:00", "Host C"],
    ["46347", "", "Alpha"],
  ]);
  assert.equal((await preview(data, {}, viewer)).status, 403);
  assert.equal((await preview(data, {}, { cookie: admin.cookie })).status, 403);
  assert.equal((await preview(data, {}, admin, "single")).status, 400);
  assert.equal((await preview(data, {}, admin, "master")).status, 400);
  assert.equal((await request("/api/v1/admin/schedule-upload/rooms")).status, 401);
  const matched = await preview(data);
  assert.equal(matched.status, 200);
  assert.equal(matched.body.status, "ready");
  assert.ok(matched.body.previewId);
  assert.equal(matched.body.sourceRooms[0].code, "01");
  assert.equal(matched.body.sourceRooms.find(({ name }) => name === "Beta Name").code, "04");
  assert.equal(matched.body.roomOptions.length, 27);
  assert.equal((await preview(data, { "beta name": "01", gamma: "03" })).status, 422);
  assert.equal((await preview(data, { "beta name": "99", gamma: "03" })).status, 422);
  const mapping = { "beta name": "02", gamma: "04" };
  const ready = await preview(data, mapping);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body.status, "ready");
  assert.equal(ready.body.summary.dateCount, 4);
  assert.equal(ready.body.summary.skippedCount, 2);
  assert.equal(ready.body.rooms[0].dates[0].directorShifts[0].overnight, true);
  assert.equal(ready.body.rooms[0].dates[1].previousDirectorCount, 1);
  assert.equal(ready.body.rooms[0].dates[1].directorShifts.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM room_aliases").get().count, 0);
  const concurrent = await preview(data, mapping);
  assert.equal((await commit(ready.body.previewId, other)).status, 409);
  const written = await commit(ready.body.previewId);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(await commit(ready.body.previewId), written);
  assert.equal((await commit(concurrent.body.previewId)).status, 409);
  assert.equal(db.prepare("SELECT director FROM director_shifts WHERE id='old-director'").get(), undefined);
  assert.equal(db.prepare("SELECT host FROM slots WHERE id='outside'").get().host, "Outside");
  assert.equal(db.prepare("SELECT host FROM slots WHERE id='blank-day'").get().host, "Retained");
  const same = db.prepare("SELECT * FROM slots WHERE id='keep'").get();
  assert.equal(same.assistant, "Assistant");
  assert.deepEqual(JSON.parse(same.products_json), ["Product"]);
  assert.equal(same.sales_target_cents, 50000);
  assert.equal(same.notes, "Note");
  assert.equal(db.prepare("SELECT name FROM rooms WHERE code='02'").get().name, "Beta");
  assert.equal(db.prepare("SELECT name FROM rooms WHERE code='04'").get().name, "Gamma");
  assert.equal((await preview(data)).body.status, "ready");

  const overlaps = workbook([
    ["44883", "", "Alpha", "23:00-02:00", "Host D"],
    ["44884", "", "Alpha", "01:00-03:00", "Host E"],
  ], true);
  assert.equal((await preview(overlaps)).status, 422);
  const collisionWithUnchanged = workbook([["46346", "", "Alpha", "", "", "00:00-01:00", "Director C"]]);
  const overlap = await preview(collisionWithUnchanged);
  assert.equal(overlap.status, 422);
  assert.match(overlap.body.errors[0].message, /未更新日期/);
  const malformed = workbook([["46345", "", "Alpha", "", "No Time"]]);
  assert.equal((await preview(malformed)).status, 422);
  const inheritedRoom = workbook([["46345", "", "Alpha", "08:00-11:00", "Host"], ["46346", "", "", "08:00-11:00", "Host"]]);
  assert.equal((await preview(inheritedRoom)).status, 422);
  const macDates = workbook([["44883", "", "Alpha", "08:00-11:00", "Host A"]], true);
  assert.equal((await preview(macDates)).body.summary.firstDate, "2026-11-19");

  const token = "lrd_live_" + randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO api_tokens(id,name,token_hash,created_at) VALUES (?,?,?,?)")
    .run("test-token", "test-token", createHash("sha256").update(token).digest("hex"), Date.now());
  const mcp = (method, params) => request("/mcp", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const listed = await mcp("tools/list", {});
  assert.equal(listed.status, 200);
  assert(listed.body.result.tools.some((item) => item.name === "preview_room_schedules_update"));
  const schedule = await mcp("tools/call", { name: "get_room_schedule", arguments: { roomCode: "01", date: "2026-11-19" } });
  assert.equal(schedule.status, 200);
  const slots = JSON.parse(schedule.body.result.content[0].text);
  assert.equal(slots.hostShifts.length, 1);
  assert.equal(slots.directorShifts.length, 1);

  const target = "  0010 或 20万\n按现场决定  ";
  const sameShift = ["46345", "", "Alpha", "08:00-12:00", "Host A", "21:00-00:30", "Director A"];
  const merch = await preview(workbook([
    [...sameShift, "", "商品甲, 商品乙，商品丙；加绒", target],
    ["", "", "", "", "", "14:00-16:00", "Director B", "", "忽略这一项", "待定"],
  ], false, true));
  assert.equal(merch.status, 200, JSON.stringify(merch.body));
  assert.equal(merch.body.summary.skippedCount, 1);
  assert.equal(merch.body.rooms[0].dates[0].hostShifts[0].salesTarget, target);
  const products = ["商品甲", "商品乙", "商品丙；加绒"];
  assert.deepEqual(merch.body.rooms[0].dates[0].hostShifts[0].featuredProducts, products);
  const merchReceipt = await commit(merch.body.previewId);
  assert.equal(merchReceipt.status, 200);
  const productSchedule = await request("/api/v1/rooms/01/schedule?date=2026-11-19", { headers: admin });
  assert.equal(productSchedule.body.schedule[0].salesTarget, target);
  assert.deepEqual(productSchedule.body.schedule[0].featuredProducts, products);
  assert.equal(db.prepare("SELECT sales_target_cents FROM slots WHERE id='keep'").get().sales_target_cents, null);
  const edit = await request("/api/v1/admin/schedules", {
    method: "PUT", headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({
      roomCode: "01", date: "2026-11-19", dataUpdatedAt: merchReceipt.body.dataUpdatedAt,
      directorShifts: [{ start: "21:00", end: "00:30", director: "Director A" }],
      hostShifts: [{ id: "keep", start: "08:00", end: "12:00", host: "Host A", featuredProducts: products, salesTarget: target }],
    }),
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const legacyFile = await preview(workbook([sameShift]));
  assert.equal((await commit(legacyFile.body.previewId)).status, 200);
  assert.equal(db.prepare("SELECT sales_target_text FROM slots WHERE id='keep'").get().sales_target_text, target);
  const blank = await preview(workbook([sameShift], false, true));
  assert.equal((await commit(blank.body.previewId)).status, 200);
  const stored = db.prepare("SELECT sales_target_text,products_json FROM slots WHERE id='keep'").get();
  assert.equal(stored.sales_target_text, "");
  assert.deepEqual(JSON.parse(stored.products_json), []);
}));

test("staff sheets resolve names and aliases, skip blanks and deduplicate identical shifts", () => withServer(async ({ db, viewer, request, preview, commit }) => {
  db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES ('01','后台房间名','Existing',0),('02','店铺甲','Existing',1)").run();
  db.prepare("INSERT INTO room_aliases(name_key,room_code) VALUES ('店铺甲','02'),('店铺乙','02')").run();
  const headers = ["日期", "星期", "直播间名称", "直播间号码", "主播时间", "主播", "导演时间", "导演", "助播时间", "助播", "休"];
  const sheet = (name, rows) => ({ name, headers, rows });
  const first = sheet("甲", [
    ["46351", "", "店铺甲", "６号直播间", "07:00-11:00", "主播甲", "07:00-15:00", "导演甲", "9:00-13:00", "助播甲"],
    ["", "", "", "", "", "", "", "", "20:00-23:00", "助播乙"],
    ["", "", "", "", "11:00-15:00", "主播乙", "07:00-15:00", "导演甲"],
    ["46352", "", "未排班直播间", "27号直播间"],
  ]);
  const second = sheet("乙", [
    ["46351", "", "店铺乙", "06", "16:00-20:00", "主播丙"],
    ["46352", "", "店铺乙", "6", "", "", "8:00-12:00", "导演乙"],
    ["46352", "", "店铺丙", "12号", "09:00-13:00", "主播丁"],
  ]);
  const multipleNumbers = scheduleWorkbook([first, sheet("编号冲突", [
    ["46351", "", "店铺甲", "07", "16:00-20:00", "主播丙"],
  ])]);
  const matched = await preview(multipleNumbers);
  assert.equal(matched.body.status, "ready");
  assert.deepEqual(matched.body.rooms.map(({ code }) => code), ["02"]);
  assert.equal(matched.body.rooms[0].dates[0].hostShifts.length, 3);
  const sameSourceNumber = await preview(scheduleWorkbook([first, sheet("同号新店", [
    ["46351", "", "新店", "06", "07:00-11:00", "主播丙"],
  ])]));
  assert.equal(sameSourceNumber.body.status, "ready");
  assert.deepEqual(sameSourceNumber.body.rooms.map(({ code, name }) => [code, name]), [["02", "店铺甲"], ["03", "新店"]]);
  const ignoredNumbers = await preview(scheduleWorkbook([{
    name: "房号列不参与校验", headers: [...headers, "直播间编号", "直播间号码"],
    rows: [
      ["46351", "", "后台房间名", "99", "08:00-12:00", "主播甲", "", "", "", "", "", { formula: "1/0" }, "任意备注"],
      ["", "", "", "02", "12:00-16:00", "主播乙"],
      ["", "", "", "随便填写"],
    ],
  }]));
  assert.equal(ignoredNumbers.body.status, "ready");
  assert.deepEqual(ignoredNumbers.body.rooms.map(({ code }) => code), ["01"]);
  assert.equal(ignoredNumbers.body.summary.scheduleCount, 2);
  assert.equal(ignoredNumbers.body.summary.skippedCount, 0);
  const missingName = await preview(scheduleWorkbook([sheet("仅填房号", [
    ["46351", "", "", "01", "08:00-12:00", "主播甲"],
  ])]));
  assert.equal(missingName.status, 422);
  assert.equal(missingName.body.errors[0].field, "直播间");
  const overlapping = await preview(scheduleWorkbook([first, sheet("并班", [
    ["46351", "", "店铺乙", "6", "14:00-20:00", "主播丙"],
  ])]));
  assert.equal(overlapping.status, 422);
  assert.equal(overlapping.body.errors[0].sheet, "并班");
  assert.match(overlapping.body.errors[0].message, /甲 第 4 行/);
  const noInheritedContext = await preview(scheduleWorkbook([first, sheet("缺少日期", [
    ["", "", "店铺乙", "06", "16:00-20:00", "主播丙"],
  ])]));
  assert.equal(noInheritedContext.status, 422);
  assert.equal(noInheritedContext.body.errors[0].field, "日期");

  const file = scheduleWorkbook([sheet("空白模板", []), first, second, { name: "空白", headers: [], rows: [] }]);
  const ready = await preview(file);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body.status, "ready");
  assert.deepEqual(ready.body.rooms.map(({ code }) => code), ["02", "03"]);
  assert.deepEqual(ready.body.rooms[0].sourceNames, ["店铺甲", "店铺乙"]);
  assert.deepEqual(ready.body.summary, {
    roomCount: 2, dateCount: 3, firstDate: "2026-11-25", lastDate: "2026-11-26",
    scheduleCount: 4, directorShiftCount: 2, assistantShiftCount: 2, skippedCount: 2,
  });
  assert.deepEqual(ready.body.rooms[0].dates[0].assistantShifts.map(({ start, end, person }) => [start, end, person]), [
    ["09:00", "13:00", "助播甲"], ["20:00", "23:00", "助播乙"],
  ]);
  assert.deepEqual(ready.body.rooms[0].dates[0].hostShifts.map(({ sourceSheet }) => sourceSheet), ["甲", "甲", "乙"]);
  assert.equal(ready.body.rooms[0].dates[0].directorShifts.length, 1);
  assert.equal(ready.body.rooms[0].dates[1].directorShifts.length, 1);
  assert.equal((await commit(ready.body.previewId)).status, 200);
  assert.deepEqual(db.prepare("SELECT name_key,room_code FROM room_aliases WHERE room_code='02' ORDER BY name_key").all()
    .map(({ name_key }) => name_key), ["店铺乙", "店铺甲"]);
  const displayed = await request("/api/v1/rooms/02/schedule?date=2026-11-25", { headers: viewer });
  assert.equal(displayed.body.schedule[0].assistant, "");
  assert.deepEqual(displayed.body.assistantShifts.map(({ start, end, assistant }) => [start, end, assistant]), [
    ["09:00", "13:00", "助播甲"], ["20:00", "23:00", "助播乙"],
  ]);
  assert.equal(displayed.body.schedule.length, 3);

  const old = await preview(workbook([
    ["46353", "", "店铺甲", "07:00-11:00", "主播甲"],
    ["46353", "", "店铺乙", "11:00-15:00", "主播乙"],
  ]));
  assert.equal(old.body.status, "ready");
  assert.equal(old.body.summary.roomCount, 1);
}));

test("actual multi-staff template reuses registered rooms with the same name", { skip: !process.env.MULTI_STAFF_IMPORT_XLSX }, () => withServer(async ({ db, preview, commit }) => {
  const addRoom = db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)");
  addRoom.run("01", "其他直播间", "old", 3);
  addRoom.run("02", "Champion儿童官旗", "old", 0);
  addRoom.run("03", "MLB童装旗舰店", "old", 1);
  addRoom.run("04", "三枪官方旗舰店", "old", 2);
  addRoom.run("05", "pidan木薯直播间", "old", 4);
  db.prepare("INSERT INTO room_aliases(name_key,room_code) VALUES ('champion儿童官方旗舰店','02'),('pidan天猫/拼多多','05')").run();
  db.prepare(`INSERT INTO slots(id,room_code,date,start_time,end_time,starts_at,ends_at,host)
    VALUES ('old','03','2026-11-19','07:00','08:00',?,?, '原主播')`)
    .run(Date.parse("2026-11-19T07:00:00+08:00"), Date.parse("2026-11-19T08:00:00+08:00"));
  const ready = await preview(await readFile(process.env.MULTI_STAFF_IMPORT_XLSX));
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body.status, "ready");
  assert.deepEqual(ready.body.summary, {
    roomCount: 7, dateCount: 13, firstDate: "2026-11-25", lastDate: "2026-11-27",
    scheduleCount: 38, directorShiftCount: 31, assistantShiftCount: 0, skippedCount: 1,
  });
  assert.deepEqual(ready.body.rooms.map(({ code }) => code), ["02", "03", "04", "05", "06", "07", "08"]);
  const shared = ready.body.rooms.find(({ code }) => code === "05");
  assert.equal(shared.sourceNames.length, 2);
  assert.equal(shared.dates[0].hostShifts.length, 4);
  assert.equal((await commit(ready.body.previewId)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slots WHERE date>='2026-11-25'").get().count, 38);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rooms WHERE code IN ('09','11')").get().count, 0);
  assert.equal(db.prepare("SELECT room_code FROM slots WHERE id='old'").get().room_code, "03");
  assert.equal(db.prepare("SELECT room_code FROM room_aliases WHERE name_key='champion儿童官方旗舰店'").get().room_code, "02");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM director_shifts").get().count, 31);
}));

test("actual revised workbook imports every populated shift without choosing rooms", { skip: !process.env.REVISED_STAFF_IMPORT_XLSX }, () => withServer(async ({ db, preview, commit }) => {
  const file = await readFile(process.env.REVISED_STAFF_IMPORT_XLSX);
  const sheets = parseXlsx(file);
  const codes = new Map([
    ["MLB服饰旗舰店", "01"], ["pidan木薯直播间", "02"], ["Champion儿童官方旗舰店", "03"],
    ["MLB童装旗舰店", "04"], ["三枪官方旗舰店", "05"], ["pidan豆腐直播间", "06"],
    ["pidan混合直播间", "07"], ["海堤官方旗舰店", "08"], ["MLB苏豪专卖店", "09"], ["MLB服饰账号", "10"],
    ["pidan天猫/拼多多", "02"],
  ]);
  const addRoom = db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)");
  [...codes.entries()].slice(0, 8).forEach(([name, code], index) => addRoom.run(code, name, "现有", index));
  db.prepare("INSERT INTO room_aliases(name_key,room_code) VALUES ('pidan天猫/拼多多','02')").run();
  const ready = await preview(file);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body.status, "ready");
  assert.deepEqual(ready.body.summary, {
    roomCount: 10, dateCount: 34, firstDate: "2026-11-25", lastDate: "2026-11-30",
    scheduleCount: 99, directorShiftCount: 81, assistantShiftCount: 9, skippedCount: 0,
  });
  assert.deepEqual(new Map(ready.body.sourceRooms.map(({ name, code }) => [name, code])), codes);
  assert.deepEqual(ready.body.rooms.filter(({ isNew }) => isNew).map(({ code, name }) => [code, name]), [["09", "MLB苏豪专卖店"], ["10", "MLB服饰账号"]]);
  const columns = Array.from("ABCDEFGHIJK");
  const altered = scheduleWorkbook(sheets.map((sheet) => ({
    name: sheet.name,
    headers: columns.map((column) => cellValue(sheet, 1, column)),
    rows: Array.from({ length: Math.max(...sheet.rows.keys()) - 1 }, (_, index) => columns.map((column) =>
      column === "D" ? ["999", "随便写", "", { formula: "1/0" }][index % 4] : cellValue(sheet, index + 2, column))),
  })));
  const alteredPreview = await preview(altered);
  assert.equal(alteredPreview.body.status, "ready");
  assert.deepEqual(alteredPreview.body.rooms, ready.body.rooms);
  assert.deepEqual(alteredPreview.body.summary, ready.body.summary);
  assert.equal((await commit(ready.body.previewId)).status, 200);

  const columnsByRole = [["E", "F", "slots", "host"], ["G", "H", "director_shifts", "director"], ["I", "J", "assistant_shifts", "assistant"]];
  for (const [timeColumn, nameColumn, table, personColumn] of columnsByRole) {
    const expected = [];
    for (const sheet of sheets) {
      let date;
      let room;
      for (const [row] of sheet.rows) {
        if (row <= 1) continue;
        const day = cellValue(sheet, row, "A");
        if (day) date = new Date(Date.UTC(1899, 11, 30) + Number(day) * 86_400_000).toISOString().slice(0, 10);
        const name = cellValue(sheet, row, "C");
        if (name) room = codes.get(name);
        const time = cellValue(sheet, row, timeColumn);
        const person = cellValue(sheet, row, nameColumn);
        if (!time && !person) continue;
        assert.ok(room && date && time && person, [sheet.name, row].join(" "));
        const [start, end] = time.split("-").map((part) => part.trim().padStart(5, "0").replace("24:00", "00:00"));
        expected.push([room, date, start, end, person].join("|"));
      }
    }
    const saved = db.prepare(`SELECT room_code,date,start_time,end_time,${personColumn} AS person FROM ${table}`).all()
      .map(({ room_code, date, start_time, end_time, person }) => [room_code, date, start_time, end_time, person].join("|"));
    assert.deepEqual(saved.sort(), expected.sort(), table);
  }
}));

test("assistant-only schedules can be edited and retain their own overnight boundaries", () => withServer(async ({ db, admin, viewer, request, preview, commit }) => {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const date = today.format(new Date());
  const nextDay = today.format(new Date(Date.now() + 86_400_000));
  db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES ('01','店铺','现有',0)").run();
  const headers = ["日期", "直播间", "主播时间", "主播", "导演时间", "导演", "助播时间", "助播"];
  const file = (rows) => scheduleWorkbook([{ name: "助播表", headers, rows }]);
  const missingTime = await preview(file([[date, "店铺", "08:00-12:00", "主播甲", "", "", "", "助播甲"]]));
  assert.equal(missingTime.status, 422);
  assert.equal(missingTime.body.errors[0].field, "助播时间");
  const overlapping = await preview(file([
    [date, "店铺", "", "", "", "", "21:00-00:30", "助播甲"],
    [nextDay, "店铺", "", "", "", "", "00:15-02:00", "助播乙"],
  ]));
  assert.equal(overlapping.status, 422);
  assert.match(overlapping.body.errors[0].message, /同角色排班重叠/);

  const ready = await preview(file([[date, "店铺", "", "", "", "", "21:00-00:30", "助播甲"]]));
  assert.equal(ready.body.status, "ready");
  assert.equal(ready.body.rooms[0].dates[0].assistantShifts[0].overnight, true);
  const saved = await commit(ready.body.previewId);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const nextDayConflict = await preview(file([[nextDay, "店铺", "", "", "", "", "00:15-02:00", "助播乙"]]));
  assert.equal(nextDayConflict.status, 422);
  assert.match(nextDayConflict.body.errors[0].message, /未更新日期/);

  const edit = (assistantShifts) => request("/api/v1/admin/schedules", {
    method: "PUT", headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ roomCode: "01", date, dataUpdatedAt: saved.body.dataUpdatedAt, hostShifts: [], directorShifts: [], assistantShifts }),
  });
  const changed = await edit([{ start: "19:00", end: "01:00", assistant: "助播乙" }]);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const adminSchedule = await request("/api/v1/admin/schedules", { headers: admin });
  assert.deepEqual(adminSchedule.body.groups[0].slots.map(({ kind, start, end, assistant }) => [kind, start, end, assistant]), [
    ["assistant", "19:00", "01:00", "助播乙"],
  ]);
  const display = await request("/api/v1/rooms/01/display", { headers: viewer });
  assert.equal(display.body.schedule.length, 0);
  assert.equal(display.body.assistantShifts[0].endsAt, Date.parse(nextDay + "T01:00:00+08:00"));
  assert.equal(display.body.nextTransitionAt, [
    Date.parse(date + "T19:00:00+08:00"), Date.parse(nextDay + "T01:00:00+08:00"),
  ].find((time) => time > Date.parse(display.body.serverNow)));

  const oldWorkbook = await preview(workbook([[date, "", "店铺", "08:00-12:00", "主播甲"]]));
  assert.equal(oldWorkbook.body.rooms[0].dates[0].replacesAssistants, false);
  assert.equal((await commit(oldWorkbook.body.previewId)).status, 200);
  const schedulePath = `/api/v1/rooms/01/schedule?date=${date}`;
  const preserved = await request(schedulePath, { headers: viewer });
  assert.equal(preserved.body.assistantShifts[0].assistant, "助播乙");
  assert.equal(preserved.body.schedule[0].end, "12:00");

  const blank = await preview(file([[date, "店铺", "08:00-12:00", "主播甲"]]));
  assert.equal(blank.body.rooms[0].dates[0].previousAssistantCount, 1);
  assert.equal(blank.body.rooms[0].dates[0].replacesAssistants, true);
  assert.equal((await commit(blank.body.previewId)).status, 200);
  assert.deepEqual((await request(schedulePath, { headers: viewer })).body.assistantShifts, []);
}));

test("MCP previews and commits independent assistants for one or multiple dates", () => withServer(async ({ db, request }) => {
  db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES ('01','验证直播间','测试',0)").run();
  const makeToken = (id) => {
    const token = "lrd_live_" + randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO api_tokens(id,name,token_hash,created_at) VALUES (?,?,?,?)")
      .run(id, id, createHash("sha256").update(token).digest("hex"), Date.now());
    return token;
  };
  const token = makeToken("mcp-test");
  const otherToken = makeToken("mcp-other");
  async function rpc(method, params, { key = token, modern = false } = {}) {
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    if (modern) {
      headers["mcp-protocol-version"] = "2026-07-28";
      headers["mcp-method"] = method;
      if (params.name) headers["mcp-name"] = params.name;
      params = { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    }
    const response = await request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.result, JSON.stringify(response.body));
    return response.body.result;
  }
  const invoke = async (name, args, options) => {
    const result = await rpc("tools/call", { name, arguments: args }, options);
    return { failed: Boolean(result.isError), ...JSON.parse(result.content[0].text) };
  };
  const { tools } = await rpc("tools/list", {}, { modern: true });
  const single = tools.find(({ name }) => name === "preview_schedule_update");
  const batch = tools.find(({ name }) => name === "preview_room_schedules_update");
  assert.ok(single.inputSchema.properties.assistantShifts);
  assert.ok(batch.inputSchema.properties.schedules.items.properties.assistantShifts);

  const roomCode = "01";
  const date = "2026-12-01";
  const nextDate = "2026-12-02";
  const newDate = "2026-12-03";
  const primary = { hostShifts: [{ start: "08:00", end: "12:00", host: "主播甲" }], directorShifts: [] };
  const assistant = { start: "09:00", end: "14:00", assistant: "助播甲" };
  const overnight = { start: "22:00", end: "01:00", assistant: "助播乙" };
  const mcpPreview = (args, options) => invoke(single.name, { roomCode, date, ...primary, ...args }, options);
  const mcpBatch = (schedules) => invoke(batch.name, { roomCode, schedules }, { modern: true });
  const readback = (day = date) => invoke("get_room_schedule", { roomCode, date: day });
  const commit = (previewId, options) => invoke("commit_schedule_update", { previewId }, options);

  const preview = await mcpPreview({ assistantShifts: [overnight, assistant] });
  assert.equal(preview.failed, false, JSON.stringify(preview));
  assert.equal(preview.preview.scheduleCount, 1);
  assert.equal(preview.preview.assistantShiftCount, 2);
  assert.deepEqual(preview.preview.assistantShifts, [assistant, overnight]);
  assert.equal(preview.preview.replacingAssistantShifts, 0);
  assert.equal((await readback()).assistantShifts.length, 0);
  assert.equal((await commit(preview.previewId, { key: otherToken })).failed, true);
  assert.equal((await commit(preview.previewId)).assistantShiftCount, 2);
  assert.equal((await commit(preview.previewId)).failed, true);
  const saved = await readback();
  assert.deepEqual(saved.assistantShifts, [assistant, overnight]);
  assert.equal(saved.hostShifts[0].end, "12:00");
  assert.equal(saved.hostShifts[0].assistant, "");

  const collision = { start: "00:30", end: "02:00", assistant: "助播丙" };
  const withPreservedDate = await mcpBatch([
    { date, ...primary }, { date: nextDate, ...primary, assistantShifts: [collision] },
  ]);
  assert.equal(withPreservedDate.failed, true);
  assert.match(withPreservedDate.details[0].message, /现有助播排班/);
  const acrossBatch = await mcpBatch([
    { date, ...primary, assistantShifts: [overnight] }, { date: nextDate, ...primary, assistantShifts: [collision] },
  ]);
  assert.equal(acrossBatch.failed, true);
  assert.match(acrossBatch.error, /多日期助播排班/);

  const overlapping = await mcpPreview({ assistantShifts: [assistant, { ...assistant, start: "11:00", assistant: "助播乙" }] });
  assert.match(overlapping.error, /助播排班时段重叠/);
  assert.match((await mcpPreview({ assistantShifts: [{ assistant: "助播丙" }] })).error, /有效时段和姓名/);
  assert.match((await mcpPreview({ hostShifts: [{ ...primary.hostShifts[0], assistant: "旧字段" }], assistantShifts: [assistant] })).error, /统一填写/);

  const replace = await mcpBatch([
    { date, ...primary, assistantShifts: [] },
    { date: nextDate, hostShifts: [], directorShifts: [], assistantShifts: [collision] },
  ]);
  assert.equal(replace.failed, false, JSON.stringify(replace));
  assert.equal(replace.preview.replacingAssistantShifts, 2);
  assert.deepEqual(replace.preview.dates.map(({ assistantShiftCount }) => assistantShiftCount), [0, 1]);
  const batchCommit = await commit(replace.previewId, { modern: true });
  assert.equal(batchCommit.ok, true, JSON.stringify(batchCommit));
  assert.equal(batchCommit.dates[1].assistantShiftCount, 1);
  assert.deepEqual((await readback()).assistantShifts, []);
  assert.deepEqual((await readback(nextDate)).assistantShifts, [collision]);

  const legacy = await mcpPreview({ date: newDate, hostShifts: [{ ...primary.hostShifts[0], assistant: "旧版助播" }] });
  assert.equal((await commit(legacy.previewId)).ok, true);
  const preserve = await mcpPreview({ date: newDate, hostShifts: [{ start: "13:00", end: "16:00", host: "主播乙" }] });
  assert.equal(preserve.preview.replacesAssistantShifts, false);
  assert.equal((await commit(preserve.previewId)).ok, true);
  assert.deepEqual((await readback(newDate)).assistantShifts, [{ start: "08:00", end: "12:00", assistant: "旧版助播" }]);
}));

test("startup and deletion compact room numbers while preserving identities and linked data", () => withServer(async ({ db, admin, viewer, request, preview }) => {
  const date = "2026-11-19";
  const start = Date.parse(date + "T08:00:00+08:00");
  const end = Date.parse(date + "T12:00:00+08:00");
  db.prepare(`INSERT INTO slots(id,room_code,date,start_time,end_time,starts_at,ends_at,host)
    VALUES ('host','04',?,'08:00','12:00',?,?,'主播')`).run(date, start, end);
  db.prepare(`INSERT INTO director_shifts(id,room_code,date,start_time,end_time,starts_at,ends_at,director)
    VALUES ('director','03',?,'08:00','12:00',?,?,'导演')`).run(date, start, end);
  db.prepare(`INSERT INTO assistant_shifts VALUES ('assistant','03',?,'08:00','12:00',?,?,'助播')`).run(date, start, end);
  db.prepare("INSERT INTO room_aliases(name_key,room_code) VALUES ('别名','03')").run();
  db.prepare("INSERT INTO room_avatars(room_code,photo_type,photo_blob,version) VALUES ('03','image/png',?,'third')")
    .run(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const roomList = (response) => response.body.rooms.map(({ code, sortOrder }) => [code, sortOrder]);
  const expected = [["01", 0], ["02", 1], ["03", 2], ["04", 3]];
  const adminRooms = await request("/api/v1/admin/rooms", { headers: admin });
  assert.deepEqual(roomList(adminRooms), expected);
  assert.deepEqual(adminRooms.body.rooms.map(({ legacyCode }) => legacyCode), ["01", "2", "06", "11"]);
  const third = adminRooms.body.rooms[2];
  const fourth = adminRooms.body.rooms[3];
  assert.deepEqual(roomList(await request("/api/v1/rooms", { headers: viewer })), expected);
  const schedule = await request("/api/v1/admin/schedules", { headers: admin });
  assert.deepEqual(roomList(schedule), expected);
  assert.deepEqual(schedule.body.groups.map(({ roomCode }) => roomCode), ["03", "04"]);

  const removed = await request("/api/v1/admin/rooms/02", {
    method: "DELETE", headers: { ...admin, "if-match": JSON.stringify(adminRooms.body.dataUpdatedAt) },
  });
  assert.equal(removed.status, 200);
  const remaining = [["01", 0], ["02", 1], ["03", 2]];
  assert.deepEqual(roomList(removed), remaining);
  assert.deepEqual(roomList(await request("/api/v1/rooms", { headers: viewer })), remaining);
  assert.deepEqual(removed.body.rooms.slice(1).map(({ roomId }) => roomId), [third.roomId, fourth.roomId]);
  assert.match(removed.body.rooms[1].avatarUrl, /rooms\/02\/avatar\?v=third$/);
  assert.equal((await request(third.avatarUrl, { headers: viewer })).status, 404);
  const display = await request("/api/v1/rooms/02/display", { headers: viewer });
  assert.equal(display.body.room.roomId, third.roomId);
  assert.equal(display.body.room.name, "直播间 06");
  assert.equal(db.prepare("SELECT room_code FROM director_shifts WHERE id='director'").get().room_code, "02");
  assert.equal(db.prepare("SELECT room_code FROM assistant_shifts WHERE id='assistant'").get().room_code, "02");
  assert.equal(db.prepare("SELECT room_code FROM slots WHERE id='host'").get().room_code, "03");
  const matchingAlias = await preview(workbook([["46353", "", "别名", "08:00-12:00", "主播"]]));
  assert.equal(matchingAlias.body.rooms[0].code, "02");
  const unknown = await preview(scheduleWorkbook([{
    name: "旧号码",
    headers: ["日期", "直播间名称", "直播间号码", "主播时间", "主播", "导演时间", "导演"],
    rows: [["46353", "未登记的新名称", "02", "08:00-12:00", "主播"]],
  }]));
  assert.equal(unknown.body.status, "ready");
  assert.equal(unknown.body.rooms[0].code, "04");
  assert.equal(unknown.body.rooms[0].isNew, true);

  const token = "lrd_live_" + randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO api_tokens(id,name,token_hash,created_at) VALUES ('order-test','test',?,?)")
    .run(createHash("sha256").update(token).digest("hex"), Date.now());
  const listed = await request("/mcp", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_rooms", arguments: {} } }),
  });
  assert.deepEqual(roomList({ body: JSON.parse(listed.body.result.content[0].text) }), remaining);
  const prepared = await request("/mcp", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "preview_schedule_update", arguments: { roomCode: "11", roomName: "追加房间", date,
        hostShifts: [], directorShifts: [{ start: "08:00", end: "12:00", director: "导演" }] },
    } }),
  });
  const result = JSON.parse(prepared.body.result.content[0].text);
  assert.equal(result.preview.roomCode, "04");
}, (db) => {
  db.exec("CREATE TABLE rooms (code TEXT PRIMARY KEY, name TEXT NOT NULL, sheet_name TEXT NOT NULL, sort_order INTEGER NOT NULL)");
  const addRoom = db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)");
  for (const [code, order] of [["11", 0], ["06", 3], ["2", 1], ["01", 8]]) {
    addRoom.run(code, "直播间 " + code, "test", order);
  }
}));

test("room management protects changes, retains name matching and removes only the confirmed room", () => withServer(async ({
  db, admin, viewer, request, preview, commit, url,
}) => {
  const file = workbook([
    ["46351", "", "店铺甲", "07:00-11:00", "主播甲", "07:00-15:00", "导演甲"],
    ["46351", "", "店铺乙", "08:00-12:00", "主播乙"],
  ]);
  const ready = await preview(file, { 店铺甲: "01", 店铺乙: "02" });
  assert.equal(ready.body.status, "ready");
  assert.equal((await commit(ready.body.previewId)).status, 200);
  db.prepare("DELETE FROM room_aliases WHERE room_code='01'").run();

  const listPath = "/api/v1/admin/rooms";
  const roomPath = listPath + "/01";
  const avatarPath = roomPath + "/avatar";
  const list = await request(listPath, { headers: admin });
  assert.equal((await request(listPath, { headers: viewer })).status, 403);
  const { roomId: firstRoomId, legacyCode, ...firstRoom } = list.body.rooms[0];
  assert.match(firstRoomId, /^[a-f0-9]{32}$/);
  assert.equal(legacyCode, null);
  assert.deepEqual(firstRoom, {
    code: "01", name: "店铺甲", sortOrder: 0, scheduleCount: 1, directorShiftCount: 1, assistantShiftCount: 0, avatarUrl: null,
  });
  const rename = (name, version, headers = admin) => request(roomPath, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json", "if-match": JSON.stringify(version) },
    body: JSON.stringify({ name }),
  });
  const initialVersion = list.body.dataUpdatedAt;
  assert.equal((await rename("新门店", initialVersion, viewer)).status, 403);
  assert.equal((await rename("新门店", initialVersion, { cookie: admin.cookie })).status, 403);
  assert.equal((await rename(" ", initialVersion)).body.error.code, "ROOM_NAME_INVALID");
  assert.equal((await rename("店铺乙", initialVersion)).body.error.code, "ROOM_NAME_CONFLICT");
  const renamed = await rename(" 新门店 ", initialVersion);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.rooms[0].name, "新门店");
  assert.equal(renamed.body.rooms[0].scheduleCount, 1);
  assert.equal((await preview(file)).body.status, "ready");
  assert.equal((await rename("过期改名", initialVersion)).body.error.code, "ROOMS_CHANGED");

  const saveAvatar = (body, version, auth = admin) => request(avatarPath, {
    method: "PUT", headers: { ...auth, "if-match": JSON.stringify(version) }, body,
  });
  const firstPhoto = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const secondPhoto = Buffer.from([255, 216, 255, 0]);
  assert.equal((await saveAvatar(firstPhoto, renamed.body.dataUpdatedAt, viewer)).status, 403);
  assert.equal((await saveAvatar(Buffer.from("invalid"), renamed.body.dataUpdatedAt)).status, 415);
  const uploaded = await saveAvatar(firstPhoto, renamed.body.dataUpdatedAt);
  assert.equal(uploaded.status, 200);
  const readerRooms = await request("/api/v1/rooms", { headers: viewer });
  const url1 = readerRooms.body.rooms[0].avatarUrl;
  assert.ok(url1);
  assert.equal(readerRooms.body.rooms[0].name, "新门店");
  assert.equal(readerRooms.body.rooms[1].avatarUrl, null);
  assert.equal((await request(url1)).status, 401);
  const media = await fetch(url + url1, { headers: viewer, signal: AbortSignal.timeout(5000) });
  assert.equal(media.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), firstPhoto);
  const updated = await saveAvatar(secondPhoto, uploaded.body.dataUpdatedAt);
  const url2 = updated.body.rooms[0].avatarUrl;
  assert.notEqual(url2, url1);
  const reset = await request(avatarPath, {
    method: "DELETE", headers: { ...admin, "if-match": JSON.stringify(updated.body.dataUpdatedAt) },
  });
  assert.equal(reset.body.rooms[0].avatarUrl, null);
  assert.equal((await request(url2, { headers: viewer })).status, 404);

  const withAvatar = await saveAvatar(firstPhoto, reset.body.dataUpdatedAt);
  const stalePreview = await preview(file);
  const remove = (version, auth = admin) => request(roomPath, {
    method: "DELETE", headers: { ...auth, "if-match": JSON.stringify(version) },
  });
  assert.equal((await remove(withAvatar.body.dataUpdatedAt, viewer)).status, 403);
  assert.equal((await remove(reset.body.dataUpdatedAt)).body.error.code, "ROOMS_CHANGED");
  const removed = await remove(withAvatar.body.dataUpdatedAt);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.rooms.map(({ code, name }) => [code, name]), [["01", "店铺乙"]]);
  assert.equal((await commit(stalePreview.body.previewId)).status, 409);
  assert.equal((await request("/api/v1/rooms/02/display", { headers: viewer })).status, 404);
  assert.equal((await request(withAvatar.body.rooms[0].avatarUrl, { headers: viewer })).status, 404);
  for (const table of ["slots", "director_shifts", "room_aliases", "room_avatars", "room_identities"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE room_code='02'`).get().count, 0);
  }
  assert.equal(db.prepare("SELECT host FROM slots WHERE room_code='01'").get().host, "主播乙");
  assert.equal(db.prepare("SELECT 1 FROM room_identities WHERE id=?").get(firstRoomId), undefined);
}));

test("merge keeps existing shifts and aliases and reuses the retained room for future imports", () => withServer(async ({
  db, admin, viewer, request, preview, commit,
}) => {
  const addRoom = db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)");
  addRoom.run("04", "三枪官方旗舰店", "old", 0);
  addRoom.run("11", "三枪官方旗舰店", "official", 1);
  addRoom.run("12", "其他直播间", "other", 2);
  db.prepare("INSERT INTO room_aliases(name_key,room_code) VALUES ('三枪官方旗舰店','04'),('三枪','04')").run();
  const insertHost = db.prepare(`INSERT INTO slots(id,room_code,date,start_time,end_time,starts_at,ends_at,host,notes)
    VALUES (?,?,?,'08:00','12:00',?,?,?,?)`);
  for (const [id, code, date] of [["older", "04", "2026-11-19"], ["newer", "11", "2026-11-25"], ["overlap", "04", "2026-11-25"]]) {
    insertHost.run(id, code, date, Date.parse(date + "T08:00:00+08:00"), Date.parse(date + "T12:00:00+08:00"), id, "保留原场次");
  }
  db.prepare(`INSERT INTO director_shifts(id,room_code,date,start_time,end_time,starts_at,ends_at,director)
    VALUES ('director','04','2026-11-19','09:00','11:00',?,?,'导演')`)
    .run(Date.parse("2026-11-19T09:00:00+08:00"), Date.parse("2026-11-19T11:00:00+08:00"));
  const addAvatar = db.prepare("INSERT INTO room_avatars(room_code,photo_type,photo_blob,version) VALUES (?,?,?,?)");
  addAvatar.run("04", "image/png", Buffer.from([1]), "old-avatar");
  addAvatar.run("11", "image/png", Buffer.from([2]), "new-avatar");

  const list = await request("/api/v1/admin/rooms", { headers: admin });
  assert.deepEqual(list.body.duplicateGroups, [["04", "11"]]);
  const merge = (targetCode, version = list.body.dataUpdatedAt, auth = admin) => request("/api/v1/admin/rooms/04/merge", {
    method: "POST", headers: { ...auth, "content-type": "application/json", "if-match": JSON.stringify(version) },
    body: JSON.stringify({ targetCode }),
  });
  assert.equal((await merge("11", "", viewer)).status, 403);
  assert.equal((await merge("11", "stale")).body.error.code, "ROOMS_CHANGED");
  assert.equal((await merge("12")).body.error.code, "ROOM_MERGE_TARGET_INVALID");
  assert.equal((await merge("11")).body.error.code, "ROOM_MERGE_OVERLAP");
  db.prepare("DELETE FROM slots WHERE id='overlap'").run();
  db.prepare("UPDATE slots SET assistant='原助播' WHERE id='older'").run();
  db.prepare(`INSERT INTO assistant_shifts VALUES ('assistant','11','2026-11-19','11:00','14:00',?,?,'新助播')`)
    .run(Date.parse("2026-11-19T11:00:00+08:00"), Date.parse("2026-11-19T14:00:00+08:00"));
  assert.match((await merge("11")).body.error.message, /助播排班重叠/);
  db.prepare("UPDATE assistant_shifts SET starts_at=?,start_time='12:00' WHERE id='assistant'")
    .run(Date.parse("2026-11-19T12:00:00+08:00"));
  assert.equal((await merge("11")).body.error.code, "ROOM_MERGE_AVATAR_CONFLICT");
  assert.equal(db.prepare("SELECT room_code FROM slots WHERE id='older'").get().room_code, "04");
  db.prepare("DELETE FROM room_avatars WHERE room_code='11'").run();

  const headers = ["日期", "星期", "直播间名称", "直播间号码", "主播时间", "主播", "导演时间", "导演"];
  const file = scheduleWorkbook([{ name: "排班", headers, rows: [
    ["46353", "", "三枪官方旗舰店", "04", "08:00-10:00", "主播甲"],
    ["", "", "三枪官方旗舰店", "11", "10:00-12:00", "主播乙"],
  ] }]);
  const stalePreview = await preview(file);
  assert.equal(stalePreview.body.rooms[0].code, "04");
  const merged = await merge("11");
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.body.duplicateGroups, []);
  assert.deepEqual(merged.body.rooms.map(({ code }) => code), ["01", "02"]);
  assert.equal(merged.body.rooms[0].scheduleCount, 2);
  assert.equal(merged.body.rooms[0].directorShiftCount, 1);
  assert.equal(merged.body.rooms[0].assistantShiftCount, 2);
  assert.match(merged.body.rooms[0].avatarUrl, /rooms\/01\/avatar/);
  assert.equal(db.prepare("SELECT notes FROM slots WHERE id='older' AND room_code='01'").get().notes, "保留原场次");
  assert.deepEqual(db.prepare("SELECT DISTINCT room_code FROM room_aliases").all().map(({ room_code }) => room_code), ["01"]);
  assert.equal((await commit(stalePreview.body.previewId)).status, 409);
  const ready = await preview(file);
  assert.equal(ready.body.status, "ready");
  assert.deepEqual(ready.body.rooms.map(({ code }) => code), ["01"]);
  assert.equal(ready.body.rooms[0].dates[0].hostShifts.length, 2);
  assert.equal((await commit(ready.body.previewId)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rooms WHERE code='04'").get().count, 0);

  const token = "lrd_live_" + randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO api_tokens(id,name,token_hash,created_at) VALUES ('merge-test','test',?,?)")
    .run(createHash("sha256").update(token).digest("hex"), Date.now());
  const textPreview = await request("/api/v1/integrations/schedule-text/preview", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ text: [
      "直播间编号：04", "直播间名称：三枪官方旗舰店", "排班日期：2026-11-27",
      "---", "排班类型：导演", "时段：08:00-12:00", "导演：导演甲",
    ].join("\n") }),
  });
  assert.equal(textPreview.status, 422);
  assert.match(textPreview.body.error.message, /已登记为 01 号/);
}));

test("avatar rename preserves the photo and updates only the matching host assignments", () => withServer(async ({ db, admin, viewer, request, preview, commit }) => {
  const originalId = "a".repeat(32);
  const otherId = "b".repeat(32);
  const now = Date.now();
  const photo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const insertAvatar = db.prepare("INSERT INTO host_avatars(id,name,name_key,photo_type,photo_blob,photo_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
  insertAvatar.run(originalId, "旧 名", "旧名", "image/png", photo, "original-hash", now, now);
  insertAvatar.run(otherId, "其他主播", "其他主播", null, null, null, now, now);
  const insertRoom = db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)");
  insertRoom.run("01", "Alpha", "One", 0);
  insertRoom.run("02", "Beta", "Two", 1);
  const insertShift = db.prepare(`INSERT INTO slots(id,room_code,date,start_time,end_time,starts_at,ends_at,host,assistant)
    VALUES (?,?,?,'08:00','12:00',?,?,?,?)`);
  const from = Date.parse("2026-11-19T08:00:00+08:00");
  const to = Date.parse("2026-11-19T12:00:00+08:00");
  insertShift.run("one", "01", "2026-11-19", from, to, "旧名", "旧 名");
  insertShift.run("two", "02", "2026-11-19", from, to, "旧 名", "");
  insertShift.run("other", "02", "2026-11-20", from + 86400000, to + 86400000, "仅排班主播", "");
  const path = "/api/v1/admin/host-avatars/" + originalId;
  const rename = (name, expectedName = "旧 名", auth = admin) => request(path, {
    method: "PATCH", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name, expectedName }),
  });

  assert.equal((await rename("新姓名", "旧 名", viewer)).status, 403);
  assert.equal((await rename("新姓名", "旧 名", { cookie: admin.cookie })).status, 403);
  assert.equal((await rename(" ")).status, 422);
  assert.equal((await rename("其他 主播")).body.error.code, "AVATAR_NAME_CONFLICT");
  assert.equal((await rename("仅排班主播")).body.error.code, "AVATAR_NAME_CONFLICT");
  assert.equal((await rename("新姓名", "过期姓名")).body.error.code, "AVATAR_NAME_CHANGED");
  assert.equal(db.prepare("SELECT host FROM slots WHERE id='one'").get().host, "旧名");

  const previousPreview = await preview(workbook([["46345", "", "Alpha", "08:00-12:00", "旧名"]]));
  assert.equal(previousPreview.body.status, "ready");
  const renamed = await rename(" 新姓名 ");
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.updatedScheduleCount, 2);
  const profile = renamed.body.profiles.find((item) => item.id === originalId);
  assert.equal(profile.name, "新姓名");
  assert.equal(profile.usedSlots, 2);
  assert.equal(renamed.body.profiles.length, 2);
  const saved = db.prepare("SELECT * FROM host_avatars WHERE id=?").get(originalId);
  assert.deepEqual(Buffer.from(saved.photo_blob), photo);
  assert.equal(saved.photo_hash, "original-hash");
  assert.equal(saved.created_at, now);
  assert.equal(db.prepare("SELECT host FROM slots WHERE id='other'").get().host, "仅排班主播");
  assert.equal(db.prepare("SELECT assistant FROM slots WHERE id='one'").get().assistant, "旧 名");
  for (const code of ["01", "02"]) {
    const schedule = await request("/api/v1/rooms/" + code + "/schedule?date=2026-11-19", { headers: viewer });
    assert.equal(schedule.body.schedule[0].host, "新姓名");
    assert.equal(schedule.body.schedule[0].photo, profile.photoUrl);
  }
  assert.equal((await commit(previousPreview.body.previewId)).status, 409);
}));

test("deleting a host profile preserves schedules and blocks automatic avatar restoration", () => withServer(async ({ db, admin, viewer, request, preview, commit }) => {
  const id = "a".repeat(32);
  const slotId = "b".repeat(32);
  const now = Date.now();
  const photo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES ('01','Alpha','One',0)").run();
  db.prepare("INSERT INTO host_avatars(id,name,name_key,photo_type,photo_blob,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, "旧 名", "旧名", "image/png", photo, now, now);
  db.prepare(`INSERT INTO slots(id,room_code,date,start_time,end_time,starts_at,ends_at,host,assistant,photo_type,photo_blob)
    VALUES (?,'01','2026-11-19','08:00','12:00',?,?,'旧名','助播','image/png',?)`)
    .run(slotId, Date.parse("2026-11-19T08:00:00+08:00"), Date.parse("2026-11-19T12:00:00+08:00"), photo);

  const libraryPath = "/api/v1/admin/host-avatars";
  const profilePath = libraryPath + "/" + id;
  const schedulePath = "/api/v1/rooms/01/schedule?date=2026-11-19";
  const deleteProfile = (expectedName, headers = admin, path = profilePath) => request(path + "/profile", {
    method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ expectedName }),
  });
  assert.equal((await deleteProfile("旧 名", viewer)).status, 403);
  assert.equal((await deleteProfile("旧 名", { cookie: admin.cookie })).status, 403);
  assert.equal((await deleteProfile("已修改")).body.error.code, "AVATAR_NAME_CHANGED");

  const removedPhoto = await request(profilePath, { method: "DELETE", headers: admin });
  assert.equal(removedPhoto.status, 200);
  assert.equal(removedPhoto.body.profiles[0].id, id);
  assert.equal(removedPhoto.body.profiles[0].hasPhoto, false);
  assert.equal(removedPhoto.body.profiles[0].usedSlots, 1);
  assert.equal((await request(schedulePath, { headers: viewer })).body.schedule[0].photo, null);

  const uploadPhoto = () => {
    const body = new FormData();
    body.append("photos", new Blob([photo], { type: "image/png" }), "host.png");
    body.append("names", JSON.stringify(["旧 名"]));
    return request(libraryPath, { method: "POST", headers: admin, body });
  };
  assert.equal((await uploadPhoto()).body.profiles[0].hasPhoto, true);
  const deleted = await deleteProfile("旧 名");
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.profiles, []);
  assert.equal(db.prepare("SELECT 1 FROM host_avatars WHERE id=?").get(id), undefined);
  assert.equal((await deleteProfile("旧 名")).status, 404);

  const schedule = await request(schedulePath, { headers: viewer });
  assert.equal(schedule.body.schedule[0].id, slotId);
  assert.equal(schedule.body.schedule[0].host, "旧名");
  assert.equal(schedule.body.schedule[0].assistant, "助播");
  assert.equal(schedule.body.schedule[0].photo, null);
  const adminSchedule = await request("/api/v1/admin/schedules", { headers: admin });
  assert.equal(adminSchedule.body.groups[0].slots[0].avatarSource, "未配置");
  assert.equal((await request("/api/v1/media/" + slotId, { headers: viewer })).status, 404);
  assert.equal((await request("/api/v1/host-avatars/" + id + "/media", { headers: viewer })).status, 404);

  const reimport = await preview(workbook([
    ["46345", "", "Alpha", "08:00-12:00", "旧名"],
    ["", "", "", "13:00-15:00", "新主播"],
  ]));
  assert.equal(reimport.body.status, "ready");
  const imported = await commit(reimport.body.previewId);
  assert.equal(imported.status, 200);
  const library = await request(libraryPath, { headers: admin });
  assert.deepEqual(library.body.profiles.map(({ name, hasPhoto }) => ({ name, hasPhoto })), [{ name: "新主播", hasPhoto: false }]);
  assert.equal((await deleteProfile("新主播", admin, libraryPath + "/" + library.body.profiles[0].id)).status, 200);

  const restored = await uploadPhoto();
  assert.equal(restored.status, 200);
  assert.equal(restored.body.profiles[0].name, "旧 名");
  assert.notEqual(restored.body.profiles[0].id, id);
  assert.equal((await request(schedulePath, { headers: viewer })).body.schedule[0].photo, restored.body.profiles[0].photoUrl);
}));

test("actual staff workbook imports all four dates", { skip: !process.env.STAFF_IMPORT_XLSX }, () => withServer(async ({ db, preview, commit }) => {
  const bytes = await readFile(process.env.STAFF_IMPORT_XLSX);
  const [sheet] = parseXlsx(bytes);
  const headers = [...sheet.rows.get(1)];
  const productColumn = headers.find(([, cell]) => cell.value === "主推商品")?.[0];
  const targetColumn = headers.find(([, cell]) => cell.value === "目标销售额")?.[0];
  const ready = await preview(bytes);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.deepEqual(ready.body.summary, {
    roomCount: 3, dateCount: 12, firstDate: "2026-11-19", lastDate: "2026-11-22",
    scheduleCount: 33, directorShiftCount: 26, assistantShiftCount: 0, skippedCount: productColumn ? 4 : 2,
  });
  if (productColumn && targetColumn) {
    const firstSlot = ready.body.rooms[0].dates[0].hostShifts[0];
    assert.equal(firstSlot.salesTarget, cellValue(sheet, 2, targetColumn));
    assert.deepEqual(firstSlot.featuredProducts, cellValue(sheet, 2, productColumn).split(/[,，]/).map(item => item.trim()).filter(Boolean));
  }
  assert.equal(ready.body.rooms[2].dates[2].hostShifts.length, 2);
  assert.equal(ready.body.rooms[2].dates[2].directorShifts.length, 0);
  assert.equal((await commit(ready.body.previewId)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slots").get().count, 33);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM director_shifts").get().count, 26);
  assert.equal((await preview(bytes)).body.status, "ready");
}));
