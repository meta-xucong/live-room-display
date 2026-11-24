import { roomNameKey } from "./staff-schedule.mjs";

// Call inside the transaction that also updates the schedule data version.
export function mergeRoom(db, room, targetCode) {
  const target = db.prepare("SELECT code,name FROM rooms WHERE code=?").get(targetCode);
  if (!target || target.code === room.code || roomNameKey(target.name) !== roomNameKey(room.name)) {
    throw Object.assign(new Error("请选择一个仍存在的同名直播间"), { status: 409, code: "ROOM_MERGE_TARGET_INVALID" });
  }
  const roles = [["slots", "主播"], ["director_shifts", "导演"]];
  for (const [table, role] of roles) {
    const overlapping = db.prepare(`SELECT a.date,a.start_time,a.end_time,b.date AS other_date,b.start_time AS other_start,b.end_time AS other_end
      FROM ${table} a JOIN ${table} b ON a.starts_at<b.ends_at AND a.ends_at>b.starts_at
      WHERE a.room_code=? AND b.room_code=? ORDER BY a.starts_at,b.starts_at LIMIT 1`).get(room.code, target.code);
    if (overlapping) {
      const message = `${room.code} 号 ${overlapping.date} ${overlapping.start_time}–${overlapping.end_time} 与 ` +
        `${target.code} 号 ${overlapping.other_date} ${overlapping.other_start}–${overlapping.other_end} 的${role}排班重叠，请先调整排班`;
      throw Object.assign(new Error(message), { status: 409, code: "ROOM_MERGE_OVERLAP" });
    }
  }
  const differentAvatars = db.prepare(`SELECT 1 FROM room_avatars a JOIN room_avatars b
    ON a.photo_type<>b.photo_type OR a.photo_blob<>b.photo_blob WHERE a.room_code=? AND b.room_code=?`).get(room.code, target.code);
  if (differentAvatars) {
    throw Object.assign(new Error("两个直播间的头像不同，请先保留要使用的头像再合并"), { status: 409, code: "ROOM_MERGE_AVATAR_CONFLICT" });
  }

  for (const [table] of roles) db.prepare(`UPDATE ${table} SET room_code=? WHERE room_code=?`).run(target.code, room.code);
  db.prepare("UPDATE room_aliases SET room_code=? WHERE room_code=?").run(target.code, room.code);
  db.prepare(`UPDATE room_avatars SET room_code=? WHERE room_code=?
    AND NOT EXISTS (SELECT 1 FROM room_avatars WHERE room_code=?)`).run(target.code, room.code, target.code);
  db.prepare("DELETE FROM rooms WHERE code=?").run(room.code);
}
