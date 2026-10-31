"""KRC's SQLite database, krc.db (KRC_SQLITE_GAMEPLAN.md).

``check`` must stay importable without sqlite3 (it reports a missing module), so this
package doesn't import the connection modules eagerly: use ``from .db import connection``.
"""
