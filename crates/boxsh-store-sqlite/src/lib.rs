//! SQLite persistence for the boxsh filesystem — the native sibling of the
//! browser backends, built on the same replication contract
//! (boxsh-fs/DESIGN.md): a [`MemoryBackend`] working copy serves every
//! operation; `flush()` drains the dirty-path journal into SQLite in a
//! single transaction, so the stored tree is always a consistent snapshot.
//! Semantics therefore live once, in `boxsh-fs`, and rows stay queryable:
//!
//! ```sql
//! SELECT data FROM entries WHERE path = 'src/main.rs';
//! ```
//!
//! Portability: the schema below and the drain contract (upsert present
//! paths, delete absent ones, one transaction per drain) are plain SQL —
//! a Postgres implementation is the same shape over a Postgres client.

use std::path::Path;

use boxsh_fs::{Backend, Entry, Error, Kind, MemoryBackend, Result};
use rusqlite::{Connection, OptionalExtension, params};

const FORMAT_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS entries (
  path  TEXT PRIMARY KEY,
  kind  INTEGER NOT NULL,          -- 1 file, 2 dir
  mtime INTEGER NOT NULL,          -- milliseconds since epoch
  data  BLOB                       -- NULL for directories
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
";

fn db_err(e: rusqlite::Error) -> Error {
    Error::Io(format!("sqlite: {e}"))
}

/// A [`Backend`] persisted in a SQLite database file (or `:memory:`).
///
/// Writes are visible immediately; durability happens at [`flush`] (and on
/// drop, best-effort). Hosts that want write-behind call `flush` on their
/// own cadence — the drain is incremental, driven by the journal.
///
/// [`flush`]: Backend::flush
#[derive(Debug)]
pub struct SqliteBackend {
    conn: Connection,
    inner: MemoryBackend,
}

impl SqliteBackend {
    /// Open (creating if missing) a filesystem stored at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_connection(Connection::open(path).map_err(db_err)?)
    }

    /// An in-memory database — useful for tests and staging.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory().map_err(db_err)?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA).map_err(db_err)?;
        let version: Option<i64> = conn
            .query_row("SELECT value FROM meta WHERE key = 'format'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db_err)?;
        match version {
            None => {
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('format', ?1)",
                    params![FORMAT_VERSION],
                )
                .map_err(db_err)?;
            }
            Some(v) if v > FORMAT_VERSION => {
                return Err(Error::Io(format!(
                    "filesystem was created by a newer boxsh (format {v}); update to open it"
                )));
            }
            Some(_) => {}
        }

        // Hydrate in path order: parents sort before children.
        let mut inner = MemoryBackend::new();
        {
            let mut stmt = conn
                .prepare("SELECT path, kind, mtime, data FROM entries ORDER BY path")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<Vec<u8>>>(3)?,
                    ))
                })
                .map_err(db_err)?;
            for row in rows {
                let (path, kind, mtime, data) = row.map_err(db_err)?;
                let bytes = if kind == 2 {
                    None
                } else {
                    Some(data.unwrap_or_default())
                };
                inner.restore(&path, mtime as u64, bytes.as_deref())?;
            }
        }
        Ok(SqliteBackend { conn, inner })
    }

    /// Milliseconds-since-epoch clock for mtimes; see `MemoryBackend::set_time`.
    pub fn set_time(&mut self, now_ms: u64) {
        self.inner.set_time(now_ms);
    }

    fn drain(&mut self) -> Result<()> {
        let dirty = self.inner.take_dirty();
        if dirty.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction().map_err(db_err)?;
        for path in &dirty {
            match self.inner.entry(path)? {
                None => {
                    tx.execute("DELETE FROM entries WHERE path = ?1", params![path])
                        .map_err(db_err)?;
                }
                Some(Entry {
                    kind: Kind::Dir,
                    mtime,
                    ..
                }) => {
                    tx.execute(
                        "INSERT OR REPLACE INTO entries (path, kind, mtime, data)
                         VALUES (?1, 2, ?2, NULL)",
                        params![path, mtime as i64],
                    )
                    .map_err(db_err)?;
                }
                Some(Entry { mtime, .. }) => {
                    let data = self.inner.read(path)?;
                    tx.execute(
                        "INSERT OR REPLACE INTO entries (path, kind, mtime, data)
                         VALUES (?1, 1, ?2, ?3)",
                        params![path, mtime as i64, data],
                    )
                    .map_err(db_err)?;
                }
            }
        }
        tx.commit().map_err(db_err)
    }
}

impl Backend for SqliteBackend {
    fn kind_name(&self) -> &'static str {
        "sqlite"
    }

    fn read(&mut self, path: &str) -> Result<Vec<u8>> {
        self.inner.read(path)
    }

    fn write(&mut self, path: &str, data: &[u8]) -> Result<()> {
        self.inner.write(path, data)
    }

    fn entry(&mut self, path: &str) -> Result<Option<Entry>> {
        self.inner.entry(path)
    }

    fn list(&mut self, path: &str) -> Result<Vec<String>> {
        self.inner.list(path)
    }

    fn mkdir(&mut self, path: &str) -> Result<()> {
        self.inner.mkdir(path)
    }

    fn remove(&mut self, path: &str) -> Result<()> {
        self.inner.remove(path)
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        self.inner.rename(from, to)
    }

    fn flush(&mut self) -> Result<()> {
        self.drain()
    }
}

impl Drop for SqliteBackend {
    fn drop(&mut self) {
        let _ = self.drain(); // best-effort; flush() is the real checkpoint
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "boxsh-store-sqlite-{}-{name}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn persists_across_reopen() {
        let db = temp_db("reopen");
        {
            let mut b = SqliteBackend::open(&db).unwrap();
            b.set_time(4200);
            b.mkdir("src").unwrap();
            b.write("src/main.rs", b"fn main() {}").unwrap();
            b.write("src/blob.bin", &[0u8, 1, 255, 128]).unwrap();
            b.flush().unwrap();
        }
        let mut b = SqliteBackend::open(&db).unwrap();
        assert_eq!(b.read("src/main.rs").unwrap(), b"fn main() {}");
        assert_eq!(b.read("src/blob.bin").unwrap(), &[0u8, 1, 255, 128]);
        let e = b.entry("src/main.rs").unwrap().unwrap();
        assert_eq!((e.kind, e.mtime), (Kind::File, 4200));
        std::fs::remove_file(db).unwrap();
    }

    #[test]
    fn drop_flushes_and_mutations_replicate() {
        let db = temp_db("drop");
        {
            let mut b = SqliteBackend::open(&db).unwrap();
            b.mkdir("a").unwrap();
            b.write("a/f", b"1").unwrap();
            b.flush().unwrap();
            b.rename("a", "b").unwrap();
            b.remove("b/f").unwrap();
            b.mkdir("b/f").unwrap(); // kind change
            // no explicit flush: Drop drains
        }
        let mut b = SqliteBackend::open(&db).unwrap();
        assert!(b.entry("a").unwrap().is_none());
        assert_eq!(b.entry("b/f").unwrap().unwrap().kind, Kind::Dir);
        std::fs::remove_file(db).unwrap();
    }

    #[test]
    fn rows_stay_queryable_as_plain_sql() {
        let db = temp_db("query");
        {
            let mut b = SqliteBackend::open(&db).unwrap();
            b.write("hello.txt", b"query me").unwrap();
            b.flush().unwrap();
        }
        let conn = Connection::open(&db).unwrap();
        let data: Vec<u8> = conn
            .query_row(
                "SELECT data FROM entries WHERE path = 'hello.txt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(data, b"query me");
        std::fs::remove_file(db).unwrap();
    }

    #[test]
    fn newer_format_is_refused() {
        let db = temp_db("format");
        {
            let b = SqliteBackend::open(&db).unwrap();
            drop(b);
        }
        Connection::open(&db)
            .unwrap()
            .execute("UPDATE meta SET value = 99 WHERE key = 'format'", [])
            .unwrap();
        let err = SqliteBackend::open(&db).unwrap_err();
        assert!(err.to_string().contains("newer boxsh"), "{err}");
        std::fs::remove_file(db).unwrap();
    }

    #[test]
    fn semantics_match_the_shared_contract() {
        let mut b = SqliteBackend::open_in_memory().unwrap();
        assert_eq!(b.read("missing").unwrap_err(), Error::NotFound);
        b.mkdir("d").unwrap();
        assert_eq!(b.mkdir("d").unwrap_err(), Error::Exists);
        b.write("d/f", b"x").unwrap();
        assert_eq!(b.remove("d").unwrap_err(), Error::NotEmpty);
        assert_eq!(b.rename("d", "d/sub").unwrap_err(), Error::Invalid);
        assert_eq!(b.list("d").unwrap(), vec!["f"]);
    }
}
