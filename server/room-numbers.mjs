import { randomBytes } from "node:crypto";

const roomCodeCollator = new Intl.Collator("zh-CN", { numeric: true });

export function compareRoomCodes(left, right) {
  const leftIsNumber = /^\d+$/.test(left);
  const rightIsNumber = /^\d+$/.test(right);
  return Number(rightIsNumber) - Number(leftIsNumber)
    || roomCodeCollator.compare(left, right) || left.localeCompare(right);
}

export function availableRoomCodes(occupied) {
  let next = 1;
  return () => {
    while (occupied.has(String(next).padStart(2, "0"))) next += 1;
    return String(next++).padStart(2, "0");
  };
}

// The caller must hold a write transaction. Room identities and dependent data move together.
export function compactRoomCodes(db) {
  const codes = db.prepare("SELECT code FROM rooms").all().map(({ code }) => code).sort(compareRoomCodes);
  const nextCode = availableRoomCodes(new Set());
  const changes = codes.map((code) => ({ code, next: nextCode() })).filter(({ code, next }) => code !== next);
  if (!changes.length) return false;

  db.exec("PRAGMA defer_foreign_keys=ON");
  const moveRoom = db.prepare("UPDATE rooms SET code=? WHERE code=?");
  const moveData = ["slots", "director_shifts", "room_avatars", "room_aliases", "room_identities"]
    .map((table) => db.prepare(`UPDATE ${table} SET room_code=? WHERE room_code=?`));
  const move = (from, to) => {
    moveRoom.run(to, from);
    for (const statement of moveData) statement.run(to, from);
  };
  const staging = "room-number-change-" + randomBytes(16).toString("hex");
  changes.forEach(({ code }, index) => move(code, staging + "-" + index));
  changes.forEach(({ next }, index) => move(staging + "-" + index, next));
  return true;
}
