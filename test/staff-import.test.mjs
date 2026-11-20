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
  return zip({
    "xl/workbook.xml": '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr date1904="' + Number(date1904) + '"/><sheets><sheet name="Sheet1" r:id="r1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": "<worksheet><sheetData>" + [
      headers,
      ...rows,
    ].map((row, r) => "<row>" + row.map((value, c) => value ? "<c r=\"" + "ABCDEFGHIJ"[c] + (r + 1) +
      '" t="inlineStr"><is><t>' + value + "</t></is></c>" : "").join("") + "</row>").join("") + "</sheetData></worksheet>",
  });
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
    await run({ db, admin, other, viewer, preview, commit, request });
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

test("actual staff workbook imports all four dates", { skip: !process.env.STAFF_IMPORT_XLSX }, () => withServer(async ({ db, preview, commit }) => {
  const bytes = await readFile(process.env.STAFF_IMPORT_XLSX);
  const [sheet] = parseXlsx(bytes);
  const withMerchandise = cellValue(sheet, 1, "I") === "主推商品";
  const first = await preview(bytes);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, "needs_mapping");
  const bindings = Object.fromEntries(first.body.sourceRooms.map(({ sourceRoomKey }, index) => [sourceRoomKey, "0" + (index + 1)]));
  const ready = await preview(bytes, bindings);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.deepEqual(ready.body.summary, {
    roomCount: 3, dateCount: 12, firstDate: "2026-11-19", lastDate: "2026-11-22",
    scheduleCount: 33, directorShiftCount: 26, skippedCount: withMerchandise ? 4 : 2,
  });
  if (withMerchandise) {
    const firstSlot = ready.body.rooms[0].dates[0].hostShifts[0];
    assert.equal(firstSlot.salesTarget, cellValue(sheet, 2, "J"));
    assert.deepEqual(firstSlot.featuredProducts, cellValue(sheet, 2, "I").split(/[,，]/).map(item => item.trim()));
  }
  assert.equal(ready.body.rooms[2].dates[2].hostShifts.length, 2);
  assert.equal(ready.body.rooms[2].dates[2].directorShifts.length, 0);
  assert.equal((await commit(ready.body.previewId)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slots").get().count, 33);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM director_shifts").get().count, 26);
  assert.equal((await preview(bytes)).body.status, "ready");
}));
