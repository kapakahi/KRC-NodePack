export function dateMs(value) {
  if (value == null || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function formatDateYmd(value, options = {}) {
  const { empty = "" } = options;
  const ms = dateMs(value);
  if (!ms) return empty;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

export function formatDateTime(value, options = {}) {
  const { empty = "" } = options;
  const ms = dateMs(value);
  if (!ms) return empty;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${formatDateYmd(value)} - ${p(d.getHours())}:${p(d.getMinutes())}`;
}
