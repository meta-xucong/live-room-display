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
      "<row>" + row.map((value, column) => value ? `<c r="${String.fromCharCode(65 + column)}${r + 1}" t="inlineStr"><is><t>` +
        value + "</t></is></c>" : "").join("") + "</row>").join("") + "</sheetData></worksheet>";
  }
  return zip(entries);
}

async function withServer(run) {
  const root = resolve(tmpdir());
  const data = await mkdtemp(join(root, "lrd-test-staff-"));
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
  room.run("27", "Outside", "Old", 2);
  const start = Date.parse("2026-11-19T08:00:00+08:00");
  const end = Date.parse("2026-11-19T12:00:00+08:00");
  const addHost = db.prepare("INSERT INTO slots(id,room_code,date,start_time,end_time,starts_at,ends_at,host,assistant,products_json,sales_target_cents,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  addHost.run("keep", "01", "2026-11-19", "08:00", "12:00", start, end, "Host A", "Assistant", '["Product"]', 50000, "Note");
  addHost.run("outside", "27", "2026-11-19", "08:00", "12:00", start, end, "Outside", "", "[]", null, "");
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
  assert.equal(matched.body.status, "needs_mapping");
  assert(!matched.body.previewId);
  assert.equal(matched.body.sourceRooms[0].code, "01");
  assert.equal(matched.body.roomOptions.length, 27);
  assert.equal((await preview(data, { "beta name": "01", gamma: "03" })).status, 422);
  assert.equal((await preview(data, { "beta name": "99", gamma: "03" })).status, 422);
  const mapping = { "beta name": "02", gamma: "03" };
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
  assert.equal(db.prepare("SELECT name FROM rooms WHERE code='03'").get().name, "Gamma");
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

test("staff sheets merge by room number, skip blanks and deduplicate identical shifts", () => withServer(async ({ db, viewer, request, preview, commit }) => {
  db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES ('06','后台房间名','Existing',0)").run();
  const headers = ["日期", "星期", "直播间名称", "直播间号码", "主播时间", "主播", "导演时间", "导演", "助播时间", "助播", "休"];
  const sheet = (name, rows) => ({ name, headers, rows });
  const first = sheet("甲", [
    ["46351", "", "店铺甲", "６号直播间", "07:00-11:00", "主播甲", "07:00-15:00", "导演甲", "7:00-11:00", "助播甲"],
    [],
    ["", "", "", "", "11:00-15:00", "主播乙", "07:00-15:00", "导演甲"],
    ["46352", "", "未排班直播间", "27号直播间"],
  ]);
  const second = sheet("乙", [
    ["46351", "", "店铺乙", "06", "16:00-20:00", "主播丙"],
    ["46352", "", "", "6", "", "", "8:00-12:00", "导演乙"],
    ["46352", "", "店铺丙", "12号", "09:00-13:00", "主播丁"],
  ]);
  const invalidName = await preview(scheduleWorkbook([first, sheet("编号冲突", [
    ["46351", "", "店铺甲", "07", "16:00-20:00", "主播丙"],
  ])]));
  assert.equal(invalidName.status, 422);
  assert.match(invalidName.body.errors[0].message, /已在 甲 第 2 行/);
  const invalidCode = await preview(scheduleWorkbook([sheet("范围", [["46351", "", "店铺", "28", "16:00-20:00", "主播丙"]])]));
  assert.equal(invalidCode.status, 422);
  assert.equal(invalidCode.body.errors[0].column, "D");
  const conflictingCatalog = await preview(scheduleWorkbook([sheet("系统编号", [
    ["46351", "", "后台房间名", "07", "16:00-20:00", "主播丙"],
  ])]));
  assert.equal(conflictingCatalog.body.status, "ready");
  assert.equal(conflictingCatalog.body.rooms[0].code, "07");
  assert.deepEqual(conflictingCatalog.body.rooms[0].numberConflicts, [
    { name: "后台房间名", codes: ["06"], sheet: "系统编号", row: 2, column: "D" },
  ]);
  const overlapping = await preview(scheduleWorkbook([first, sheet("并班", [
    ["46351", "", "不同表内名", "6", "14:00-20:00", "主播丙"],
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
  assert.deepEqual(ready.body.rooms.map(({ code }) => code), ["06", "12"]);
  assert.deepEqual(ready.body.rooms[0].sourceNames, ["店铺甲", "店铺乙"]);
  assert.deepEqual(ready.body.summary, {
    roomCount: 2, dateCount: 3, firstDate: "2026-11-25", lastDate: "2026-11-26",
    scheduleCount: 4, directorShiftCount: 2, skippedCount: 2,
  });
  assert.equal(ready.body.rooms[0].dates[0].hostShifts[0].assistant, "助播甲");
  assert.deepEqual(ready.body.rooms[0].dates[0].hostShifts.map(({ sourceSheet }) => sourceSheet), ["甲", "甲", "乙"]);
  assert.equal(ready.body.rooms[0].dates[0].directorShifts.length, 1);
  assert.equal(ready.body.rooms[0].dates[1].directorShifts.length, 1);
  assert.equal((await commit(ready.body.previewId)).status, 200);
  assert.deepEqual(db.prepare("SELECT name_key,room_code FROM room_aliases WHERE room_code='06' ORDER BY name_key").all()
    .map(({ name_key }) => name_key), ["店铺乙", "店铺甲"]);
  const displayed = await request("/api/v1/rooms/06/schedule?date=2026-11-25", { headers: viewer });
  assert.equal(displayed.body.schedule[0].assistant, "助播甲");
  assert.equal(displayed.body.schedule.length, 3);

  const old = await preview(workbook([
    ["46353", "", "店铺甲", "07:00-11:00", "主播甲"],
    ["46353", "", "店铺乙", "11:00-15:00", "主播乙"],
  ]));
  assert.equal(old.body.status, "ready");
  assert.equal(old.body.summary.roomCount, 1);
}));

test("actual multi-staff template imports seven numbered rooms", { skip: !process.env.MULTI_STAFF_IMPORT_XLSX }, () => withServer(async ({ db, preview, commit }) => {
  const addRoom = db.prepare("INSERT INTO rooms(code,name,sheet_name,sort_order) VALUES (?,?,?,?)");
  addRoom.run("02", "Champion儿童官旗", "old", 0);
  addRoom.run("03", "MLB童装旗舰店", "old", 1);
  addRoom.run("04", "三枪官方旗舰店", "old", 2);
  db.prepare("INSERT INTO room_aliases(name_key,room_code) VALUES ('champion儿童官方旗舰店','02')").run();
  db.prepare(`INSERT INTO slots(id,room_code,date,start_time,end_time,starts_at,ends_at,host)
    VALUES ('old','03','2026-11-25','07:00','08:00',?,?, '原主播')`)
    .run(Date.parse("2026-11-25T07:00:00+08:00"), Date.parse("2026-11-25T08:00:00+08:00"));
  const ready = await preview(await readFile(process.env.MULTI_STAFF_IMPORT_XLSX));
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body.status, "ready");
  assert.deepEqual(ready.body.summary, {
    roomCount: 7, dateCount: 13, firstDate: "2026-11-25", lastDate: "2026-11-27",
    scheduleCount: 38, directorShiftCount: 31, skippedCount: 1,
  });
  assert.deepEqual(ready.body.rooms.map(({ code }) => code).sort(), ["06", "08", "09", "11", "12", "15", "21"]);
  const shared = ready.body.rooms.find(({ code }) => code === "06");
  assert.equal(shared.sourceNames.length, 2);
  assert.equal(shared.dates[0].hostShifts.length, 4);
  for (const [code, oldCode] of [["08", "02"], ["09", "03"], ["11", "04"]]) {
    assert.deepEqual(ready.body.rooms.find((room) => room.code === code).numberConflicts[0].codes, [oldCode]);
  }
  assert.equal((await commit(ready.body.previewId)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slots WHERE room_code NOT IN ('02','03','04')").get().count, 38);
  assert.equal(db.prepare("SELECT room_code FROM slots WHERE id='old'").get().room_code, "03");
  assert.equal(db.prepare("SELECT room_code FROM room_aliases WHERE name_key='champion儿童官方旗舰店'").get().room_code, "02");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM director_shifts").get().count, 31);
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
  assert.deepEqual(list.body.rooms[0], {
    code: "01", name: "店铺甲", sortOrder: 0, scheduleCount: 1, directorShiftCount: 1, avatarUrl: null,
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
  assert.deepEqual(removed.body.rooms.map(({ code }) => code), ["02"]);
  assert.equal((await commit(stalePreview.body.previewId)).status, 409);
  assert.equal((await request("/api/v1/rooms/01/display", { headers: viewer })).status, 404);
  assert.equal((await request(withAvatar.body.rooms[0].avatarUrl, { headers: viewer })).status, 404);
  for (const table of ["slots", "director_shifts", "room_aliases", "room_avatars"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE room_code='01'`).get().count, 0);
  }
  assert.equal(db.prepare("SELECT host FROM slots WHERE room_code='02'").get().host, "主播乙");
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
  const first = await preview(bytes);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, "needs_mapping");
  const bindings = Object.fromEntries(first.body.sourceRooms.map(({ sourceRoomKey }, index) => [sourceRoomKey, "0" + (index + 1)]));
  const ready = await preview(bytes, bindings);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.deepEqual(ready.body.summary, {
    roomCount: 3, dateCount: 12, firstDate: "2026-11-19", lastDate: "2026-11-22",
    scheduleCount: 33, directorShiftCount: 26, skippedCount: productColumn ? 4 : 2,
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
