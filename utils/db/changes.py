"""Reading the ``changes`` log: what changed after a revision (KRC_EXTERNAL_API_GAMEPLAN.md
stage 15).

Every write adds rows to ``changes`` in its own transaction. ``rev`` is AUTOINCREMENT, and
a rolled-back write rolls its sequence number back too, so the committed revs are every
number from 1 to the newest. Only ``_prune_changes`` removes rows. So the log can answer
"everything after ``since``" exactly when no number above ``since`` is missing, which is
one indexed COUNT, with no extra state to keep (or to lose in a restore).
"""

from . import connection as db


def changes_since(since, stores=(), store_prefixes=(), limit=1000):
    """What changed after revision ``since`` in the given stores (exact names, or any
    store starting with one of ``store_prefixes``), collapsed per item: each
    ``(store, item)`` once, with its newest rev, op and source. Oldest first, at most
    ``limit``. -> {"newest", "complete", "changes": [{rev, store, item, op, source}], "more"}

    ``newest`` is the newest rev in the whole log. ``complete`` is False when ``since`` is
    above it, or when the log was trimmed past ``since`` (then ``changes`` is empty and the
    caller should resync in full)."""
    since = int(since)
    stores, store_prefixes = list(stores), list(store_prefixes)
    with db.read() as conn:
        newest = int(conn.execute("SELECT MAX(rev) FROM changes").fetchone()[0] or 0)
        if since < 0 or since > newest:
            return {"newest": newest, "complete": False, "changes": [], "more": False}
        kept = conn.execute("SELECT COUNT(*) FROM changes WHERE rev > ?", (since,)).fetchone()[0]
        if kept != newest - since:
            return {"newest": newest, "complete": False, "changes": [], "more": False}
        if not (stores or store_prefixes):
            return {"newest": newest, "complete": True, "changes": [], "more": False}
        clauses = []
        params = [since]
        if stores:
            clauses.append(f"store IN ({', '.join('?' for _ in stores)})")
            params.extend(stores)
        for prefix in store_prefixes:
            clauses.append("substr(store, 1, ?) = ?")
            params.extend([len(prefix), prefix])
        rows = conn.execute(
            "SELECT c.rev, c.store, c.item_id, c.op, c.source FROM changes c JOIN ("
            f"  SELECT MAX(rev) AS rev FROM changes WHERE rev > ? AND ({' OR '.join(clauses)})"
            "  GROUP BY store, item_id"
            ") latest ON latest.rev = c.rev ORDER BY c.rev LIMIT ?",
            (*params, int(limit) + 1),
        ).fetchall()
    more = len(rows) > limit
    changes = [
        {"rev": rev, "store": store, "item": item or "", "op": op or "", "source": source or ""}
        for rev, store, item, op, source in rows[:limit]
    ]
    return {"newest": newest, "complete": True, "changes": changes, "more": more}
