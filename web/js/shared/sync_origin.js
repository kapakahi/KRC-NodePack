// In-memory page identity: batch responses already update this page's consumers.
// Other pages receive the server notification; the sender skips its own echo.
export const PAGE_SYNC_ID = `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function withSyncOrigin(options) {
  const method = String(options?.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return options;
  const headers = new Headers(options?.headers);
  headers.set("X-KRC-Origin", PAGE_SYNC_ID);
  return { ...options, headers };
}
