//! The canonical in-memory backend: a port of the TypeScript memory backend,
//! plus a dirty-path journal so hosts can replicate the tree into storage the
//! sandbox cannot reach itself (IndexedDB, OPFS). See DESIGN.md for the
//! replication contract and deliberate semantic differences from memory.ts.

use std::collections::{BTreeMap, BTreeSet};

use crate::{Backend, Entry, Error, Kind, Result, split_parent};

#[derive(Debug, Clone)]
struct Node {
    /// `None` marks a directory.
    data: Option<Vec<u8>>,
    mtime: u64,
}

fn entry_of(n: &Node) -> Entry {
    match &n.data {
        Some(d) => Entry {
            kind: Kind::File,
            size: d.len() as u64,
            mtime: n.mtime,
        },
        None => Entry {
            kind: Kind::Dir,
            size: 0,
            mtime: n.mtime,
        },
    }
}

#[derive(Debug, Clone)]
pub struct MemoryBackend {
    nodes: BTreeMap<String, Node>,
    dirty: BTreeSet<String>,
    now_ms: u64,
}

impl Default for MemoryBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryBackend {
    pub fn new() -> Self {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            String::new(),
            Node {
                data: None,
                mtime: 0,
            },
        );
        Self {
            nodes,
            dirty: BTreeSet::new(),
            now_ms: 0,
        }
    }

    /// Set the clock used to stamp mtimes. The host owns time; the filesystem
    /// never reads a clock itself (wasm builds have none to read).
    pub fn set_time(&mut self, now_ms: u64) {
        self.now_ms = now_ms;
    }

    /// Paths touched since the last take, sorted (parents sort before their
    /// children). Each path resolves against the *current* tree: present →
    /// upsert its entry, absent → delete. Apply upserts in order and deletes
    /// in reverse order when the target store enforces tree invariants.
    pub fn take_dirty(&mut self) -> Vec<String> {
        std::mem::take(&mut self.dirty).into_iter().collect()
    }

    /// Number of paths currently pending in the journal.
    pub fn dirty_len(&self) -> usize {
        self.dirty.len()
    }

    /// Recreate a node during hydration: no journal marks, mtime preserved.
    /// Parents must already exist — hydrate in sorted path order and they
    /// will. `data: None` restores a directory; restoring `""` sets the root
    /// mtime. Overwrites any existing node (hydration is idempotent).
    pub fn restore(&mut self, path: &str, mtime: u64, data: Option<&[u8]>) -> Result<()> {
        if path.is_empty() {
            if data.is_some() {
                return Err(Error::Invalid);
            }
            self.nodes.get_mut("").expect("root always exists").mtime = mtime;
            return Ok(());
        }
        let (_, base) = split_parent(path);
        if base.is_empty() {
            return Err(Error::Invalid);
        }
        self.require_parent(path)?;
        self.nodes.insert(
            path.to_string(),
            Node {
                data: data.map(<[u8]>::to_vec),
                mtime,
            },
        );
        Ok(())
    }

    /// Every node in sorted path order: (path, entry, file bytes).
    pub fn entries(&self) -> impl Iterator<Item = (&str, Entry, Option<&[u8]>)> {
        self.nodes
            .iter()
            .map(|(p, n)| (p.as_str(), entry_of(n), n.data.as_deref()))
    }

    fn mark(&mut self, path: &str) {
        self.dirty.insert(path.to_string());
    }

    fn require_parent(&self, path: &str) -> Result<()> {
        let (parent, _) = split_parent(path);
        match self.nodes.get(parent) {
            None => Err(Error::NotFound),
            Some(n) if n.data.is_some() => Err(Error::NotDir),
            Some(_) => Ok(()),
        }
    }

    fn child_names(&self, dir: &str) -> Vec<String> {
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };
        let mut out = Vec::new();
        for (k, _) in self.nodes.range(prefix.clone()..) {
            let Some(rest) = k.strip_prefix(prefix.as_str()) else {
                break;
            };
            if rest.is_empty() || rest.contains('/') {
                continue;
            }
            out.push(rest.to_string());
        }
        out
    }

    fn has_children(&self, dir: &str) -> bool {
        if dir.is_empty() {
            return self.nodes.len() > 1;
        }
        let prefix = format!("{dir}/");
        self.nodes
            .range(prefix.clone()..)
            .next()
            .is_some_and(|(k, _)| k.starts_with(&prefix))
    }

    /// `root` plus every key beneath it, in sorted order.
    fn subtree_keys(&self, root: &str) -> Vec<String> {
        let mut keys = vec![root.to_string()];
        let prefix = format!("{root}/");
        for (k, _) in self.nodes.range(prefix.clone()..) {
            if !k.starts_with(&prefix) {
                break;
            }
            keys.push(k.clone());
        }
        keys
    }
}

impl Backend for MemoryBackend {
    fn kind_name(&self) -> &'static str {
        "memory"
    }

    fn read(&mut self, path: &str) -> Result<Vec<u8>> {
        match self.nodes.get(path) {
            None => Err(Error::NotFound),
            Some(Node { data: None, .. }) => Err(Error::IsDir),
            Some(Node { data: Some(d), .. }) => Ok(d.clone()),
        }
    }

    fn write(&mut self, path: &str, data: &[u8]) -> Result<()> {
        match self.nodes.get(path) {
            Some(Node { data: None, .. }) => return Err(Error::IsDir),
            Some(_) => {}
            None => {
                let (_, base) = split_parent(path);
                if base.is_empty() {
                    return Err(Error::Invalid);
                }
                self.require_parent(path)?;
            }
        }
        let node = Node {
            data: Some(data.to_vec()),
            mtime: self.now_ms,
        };
        self.nodes.insert(path.to_string(), node);
        self.mark(path);
        Ok(())
    }

    fn entry(&mut self, path: &str) -> Result<Option<Entry>> {
        Ok(self.nodes.get(path).map(entry_of))
    }

    fn list(&mut self, path: &str) -> Result<Vec<String>> {
        match self.nodes.get(path) {
            None => Err(Error::NotFound),
            Some(Node { data: Some(_), .. }) => Err(Error::NotDir),
            Some(_) => Ok(self.child_names(path)),
        }
    }

    fn mkdir(&mut self, path: &str) -> Result<()> {
        if self.nodes.contains_key(path) {
            return Err(Error::Exists);
        }
        let (_, base) = split_parent(path);
        if base.is_empty() {
            return Err(Error::Invalid);
        }
        self.require_parent(path)?;
        let node = Node {
            data: None,
            mtime: self.now_ms,
        };
        self.nodes.insert(path.to_string(), node);
        self.mark(path);
        Ok(())
    }

    fn remove(&mut self, path: &str) -> Result<()> {
        if path.is_empty() {
            return Err(Error::Invalid);
        }
        let Some(node) = self.nodes.get(path) else {
            return Err(Error::NotFound);
        };
        if node.data.is_none() && self.has_children(path) {
            return Err(Error::NotEmpty);
        }
        self.nodes.remove(path);
        self.mark(path);
        Ok(())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        if from.is_empty() || to.is_empty() {
            return Err(Error::Invalid);
        }
        if from == to {
            return Ok(());
        }
        // Refuse moving a directory into its own subtree.
        if to.len() > from.len() && to.as_bytes()[from.len()] == b'/' && to.starts_with(from) {
            return Err(Error::Invalid);
        }
        if !self.nodes.contains_key(from) {
            return Err(Error::NotFound);
        }
        let (_, tbase) = split_parent(to);
        if tbase.is_empty() {
            return Err(Error::Invalid);
        }
        self.require_parent(to)?;
        if let Some(t) = self.nodes.get(to)
            && t.data.is_none()
            && self.has_children(to)
        {
            return Err(Error::NotEmpty);
        }
        for key in self.subtree_keys(from) {
            let node = self.nodes.remove(&key).expect("subtree key exists");
            let new_key = format!("{to}{}", &key[from.len()..]);
            self.mark(&key);
            self.mark(&new_key);
            self.nodes.insert(new_key, node);
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        Ok(())
    }
}
