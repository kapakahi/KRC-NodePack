"""krc.db schema, as numbered migrations tracked by ``PRAGMA user_version``.

Each gameplan stage appends one migration. A shipped migration is never edited: a later
change is a new migration. ``migrate`` runs every pending one, each in its own transaction.
"""

MIGRATIONS = [
    # 1 — stage 1: foundation + Prompt Vault.
    """
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    );

    -- One row per write, in the same transaction as the write. A store's revision is its
    -- newest rev; readers (the Prompt Vault cache, later sync) compare revisions.
    CREATE TABLE changes (
        rev     INTEGER PRIMARY KEY AUTOINCREMENT,
        store   TEXT NOT NULL,
        item_id TEXT,
        op      TEXT,
        source  TEXT,
        at_ms   INTEGER NOT NULL
    );
    CREATE INDEX changes_store_rev ON changes (store, rev);

    -- A category exists on its own (an empty one too). meta = the record's "__meta__"
    -- object as JSON (nsfw, pinned, cardColor), NULL when it has none.
    CREATE TABLE prompt_categories (
        name TEXT PRIMARY KEY,
        meta TEXT
    );

    -- record = the prompt record exactly as the JSON store held it (every field, in its
    -- order). id is NOT unique: a copied prompt can carry its source's id.
    CREATE TABLE prompts (
        category TEXT NOT NULL REFERENCES prompt_categories (name) ON UPDATE CASCADE ON DELETE CASCADE,
        name     TEXT NOT NULL,
        id       TEXT NOT NULL,
        record   TEXT NOT NULL,
        PRIMARY KEY (category, name)
    );
    CREATE INDEX prompts_id ON prompts (id);

    -- Silent usage bookkeeping (never touches a record's dates). domain: prompts (by
    -- record id) now; loras / models join in stage 3.
    CREATE TABLE usage (
        domain       TEXT NOT NULL,
        item_id      TEXT NOT NULL,
        count        INTEGER NOT NULL DEFAULT 0,
        last_used_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (domain, item_id)
    );
    """,
    # 2 — stage 2: presets.
    """
    -- Every preset store in one table. kind: ll | cs | wb | kit:<kit id>. record = the
    -- preset exactly as its JSON file held it; each store still normalizes it on load.
    CREATE TABLE presets (
        kind   TEXT NOT NULL,
        id     TEXT NOT NULL,
        record TEXT NOT NULL,
        PRIMARY KEY (kind, id)
    );

    -- Folder colours and pins for a library's folder rail. lineage: loras now (LoRA
    -- Loadout); models joins in stage 3. pin_order is NULL for an unpinned folder.
    CREATE TABLE folder_colors (
        lineage   TEXT NOT NULL,
        folder    TEXT NOT NULL,
        color     TEXT,
        pin_order INTEGER,
        PRIMARY KEY (lineage, folder)
    );
    """,
    # 3 — stage 3: the library.
    """
    -- Per-item metadata records (what metadata/<id>.json held), verbatim. lineage: loras
    -- (type_dir '') or models (type_dir = the per-type folder name). id = the file stem
    -- (safe_id of the library id).
    CREATE TABLE item_metadata (
        lineage  TEXT NOT NULL,
        type_dir TEXT NOT NULL,
        id       TEXT NOT NULL,
        record   TEXT NOT NULL,
        PRIMARY KEY (lineage, type_dir, id)
    );
    CREATE INDEX item_metadata_id ON item_metadata (lineage, id);

    -- The identity stores (stabilized ids + where each file was last seen), per lineage.
    CREATE TABLE identity_aliases (
        lineage      TEXT NOT NULL,
        legacy_id    TEXT NOT NULL,
        canonical_id TEXT NOT NULL,
        PRIMARY KEY (lineage, legacy_id)
    );
    CREATE TABLE identity_files (
        lineage       TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        entry         TEXT NOT NULL,
        PRIMARY KEY (lineage, relative_path)
    );

    -- Collections (models + LoRAs), one record per collection, verbatim.
    CREATE TABLE collections (
        id     TEXT PRIMARY KEY,
        record TEXT NOT NULL
    );

    -- Last export / import per transfer kind (the Import and Export page).
    CREATE TABLE transfer_history (
        key   TEXT PRIMARY KEY,
        entry TEXT NOT NULL
    );

    -- The Civitai by-hash response cache (a hit, or a not_found sentinel), verbatim.
    CREATE TABLE civitai_cache (
        sha256     TEXT PRIMARY KEY,
        status     TEXT NOT NULL,
        fetched_ms INTEGER NOT NULL DEFAULT 0,
        envelope   TEXT NOT NULL
    );
    CREATE INDEX civitai_cache_status ON civitai_cache (status);
    """,
    # 4 — Word Bank banks (decision D6 reversed, 2026-10-13): one row per bank, its words
    # as the text a .txt export holds (one entry per line).
    """
    CREATE TABLE word_banks (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT ''
    );
    """,
    # 5 — KRC Media's catalog (MEDIA_INTO_NODEPACK_GAMEPLAN.md stage 2; was index.json). The
    # record is the item / folder exactly as Media's store holds it, as JSON; `folder` is
    # kept as a column for the per-folder reads. Media presets are kind "media" in presets.
    """
    CREATE TABLE media_items (
        id     TEXT PRIMARY KEY,
        folder TEXT NOT NULL DEFAULT '',
        record TEXT NOT NULL
    );
    CREATE INDEX media_items_folder ON media_items (folder);
    CREATE TABLE media_folders (
        id     TEXT PRIMARY KEY,
        record TEXT NOT NULL
    );
    """,
    # 6 — Prompt Vault profiles. Preserve record bytes/ids; scope category keys.
    """
    CREATE TABLE prompt_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 64),
        created_ms INTEGER NOT NULL
    );
    INSERT INTO prompt_profiles VALUES ('default', 'Default', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    CREATE TABLE profile_categories (
        name TEXT NOT NULL,
        meta TEXT,
        profile_id TEXT NOT NULL DEFAULT 'default' REFERENCES prompt_profiles (id),
        PRIMARY KEY (profile_id, name)
    );
    CREATE TABLE profile_prompts (
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        id TEXT NOT NULL,
        record TEXT NOT NULL,
        profile_id TEXT NOT NULL DEFAULT 'default' REFERENCES prompt_profiles (id),
        PRIMARY KEY (profile_id, category, name),
        FOREIGN KEY (profile_id, category) REFERENCES profile_categories (profile_id, name)
            ON UPDATE CASCADE ON DELETE CASCADE
    );
    INSERT INTO profile_categories (name, meta) SELECT name, meta FROM prompt_categories ORDER BY rowid;
    INSERT INTO profile_prompts (category, name, id, record) SELECT category, name, id, record FROM prompts ORDER BY rowid;
    DROP TABLE prompts;
    DROP TABLE prompt_categories;
    ALTER TABLE profile_categories RENAME TO prompt_categories;
    ALTER TABLE profile_prompts RENAME TO prompts;
    CREATE INDEX prompts_id ON prompts (id, profile_id);
    """,
]

SCHEMA_VERSION = len(MIGRATIONS)


def current_version(conn):
    return conn.execute("PRAGMA user_version").fetchone()[0]


def migrate(conn):
    """Bring the schema up to SCHEMA_VERSION. -> the list of versions applied."""
    applied = []
    version = current_version(conn)
    if version > SCHEMA_VERSION:
        from .check import KrcDatabaseError

        raise KrcDatabaseError(
            f"krc.db has schema version {version}, newer than this KRC NodePack understands "
            f"({SCHEMA_VERSION}). Update KRC NodePack, or restore an older snapshot.")
    while version < SCHEMA_VERSION:
        script = MIGRATIONS[version]
        target = version + 1
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in _statements(script):
                conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {target}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        applied.append(target)
        version = target
    return applied


def _statements(script):
    """Split a migration script into statements (no semicolons inside our literals)."""
    lines = [line for line in script.splitlines() if not line.strip().startswith("--")]
    return [part.strip() for part in "\n".join(lines).split(";") if part.strip()]
