// Word Bank: the preset Modified badge's hover-card rows (shared/change_list.js). Pure.
//
// Rows compare by position, as the preset signature does (preset_controls.js sig():
// [bank id, word, locked] per row):
//   Row 2 · Colors     red  →  blue      (the word)
//   Row 2 · Bank       Colors  →  Moods
//   Row 3 · Lock       unlocked  →  locked
//   Row 4              Added / Removed
// `saved` / `current`: those triples; bankName(id) -> a bank's name.
export function wordBankChangeRows(saved = [], current = [], bankName = (id) => id) {
  const rows = [];
  const name = (id) => bankName(id) || "no bank";
  const lock = (locked) => (locked ? "locked" : "unlocked");
  for (let index = 0; index < Math.max(saved.length, current.length); index += 1) {
    const was = saved[index];
    const now = current[index];
    const row = `Row ${index + 1}`;
    if (!was) {
      rows.push({ label: row, note: "Added" });
      continue;
    }
    if (!now) {
      rows.push({ label: row, note: "Removed" });
      continue;
    }
    const [wasBank, wasWord, wasLocked] = was;
    const [nowBank, nowWord, nowLocked] = now;
    if (wasBank !== nowBank) rows.push({ label: `${row} · Bank`, before: name(wasBank), after: name(nowBank) });
    if (wasWord !== nowWord) rows.push({ label: `${row} · ${name(nowBank)}`, before: wasWord || "empty", after: nowWord || "empty" });
    if (Boolean(wasLocked) !== Boolean(nowLocked)) rows.push({ label: `${row} · Lock`, before: lock(wasLocked), after: lock(nowLocked) });
  }
  return rows;
}
