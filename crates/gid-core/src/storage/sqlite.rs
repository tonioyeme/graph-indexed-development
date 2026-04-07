//! GOAL-1.9: SQLite backend implementing the `GraphStorage` trait.
//!
//! Uses WAL mode, foreign keys, and FTS5 for full-text search.
//! All operations go through a `RefCell<Connection>` for interior mutability.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::graph::{Edge, Node, NodeStatus, ProjectMeta};
use crate::task_graph_knowledge::KnowledgeNode;
use super::error::{StorageError, StorageOp};
use super::schema::SCHEMA_SQL;
use super::trait_def::{BatchOp, GraphStorage, NodeFilter};

// ── Error mapping ──────────────────────────────────────────

impl From<rusqlite::Error> for StorageError {
    fn from(err: rusqlite::Error) -> Self {
        match &err {
            rusqlite::Error::SqliteFailure(e, _)
                if e.code == rusqlite::ErrorCode::DatabaseBusy =>
            {
                StorageError::DatabaseLocked {
                    op: StorageOp::Write,
                    detail: "database is locked — another process is writing".into(),
                    source: Some(Box::new(err)),
                }
            }
            rusqlite::Error::SqliteFailure(e, _)
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                StorageError::ForeignKeyViolation {
                    op: StorageOp::Write,
                    detail: err.to_string(),
                    source: Some(Box::new(err)),
                }
            }
            _ => StorageError::Sqlite {
                op: StorageOp::Read,
                detail: err.to_string(),
                source: Some(Box::new(err)),
            },
        }
    }
}

// ── SqliteStorage struct ───────────────────────────────────

pub struct SqliteStorage {
    conn: RefCell<Connection>,
    path: PathBuf,
}

impl SqliteStorage {
    /// Open (or create) a SQLite database at the given path.
    ///
    /// Runs PRAGMAs for performance and correctness, then applies the schema DDL.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let path = path.into();
        let conn = Connection::open(&path).map_err(|e| StorageError::Sqlite {
            op: StorageOp::Open,
            detail: format!("failed to open database at {}: {}", path.display(), e),
            source: Some(Box::new(e)),
        })?;

        // PRAGMAs
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             PRAGMA cache_size=-2000;",
        )?;

        // Apply schema
        conn.execute_batch(SCHEMA_SQL)?;

        tracing::debug!("opened SQLite storage at {}", path.display());

        Ok(Self {
            conn: RefCell::new(conn),
            path,
        })
    }

    /// Return the path to the underlying database file.
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    // ── Private helpers ────────────────────────────────────

    /// Load tags, metadata, and knowledge into an already-constructed Node.
    fn load_node_extras(&self, node: &mut Node) -> Result<(), StorageError> {
        let conn = self.conn.borrow();

        // Tags
        let mut tag_stmt = conn.prepare_cached(
            "SELECT tag FROM node_tags WHERE node_id = ?",
        )?;
        let tags: Vec<String> = tag_stmt
            .query_map(params![node.id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        node.tags = tags;

        // Metadata
        let mut meta_stmt = conn.prepare_cached(
            "SELECT key, value FROM node_metadata WHERE node_id = ?",
        )?;
        let meta_rows: Vec<(String, String)> = meta_stmt
            .query_map(params![node.id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut metadata = HashMap::new();
        for (k, v) in meta_rows {
            let val: Value = serde_json::from_str(&v).unwrap_or(Value::String(v));
            metadata.insert(k, val);
        }
        node.metadata = metadata;

        // Knowledge
        let mut know_stmt = conn.prepare_cached(
            "SELECT findings, file_cache, tool_history FROM knowledge WHERE node_id = ?",
        )?;
        let knowledge = know_stmt.query_row(params![node.id], |row| {
            let findings_json: Option<String> = row.get(0)?;
            let file_cache_json: Option<String> = row.get(1)?;
            let tool_history_json: Option<String> = row.get(2)?;
            Ok((findings_json, file_cache_json, tool_history_json))
        });
        match knowledge {
            Ok((findings_json, file_cache_json, tool_history_json)) => {
                node.knowledge = KnowledgeNode {
                    findings: findings_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or_default(),
                    file_cache: file_cache_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or_default(),
                    tool_history: tool_history_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or_default(),
                };
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                node.knowledge = KnowledgeNode::default();
            }
            Err(e) => return Err(e.into()),
        }

        Ok(())
    }
}

// ── row_to_node helper ─────────────────────────────────────

fn row_to_node(row: &rusqlite::Row) -> rusqlite::Result<Node> {
    let status_str: Option<String> = row.get(2)?;
    let status = status_str
        .as_deref()
        .and_then(|s| s.parse::<NodeStatus>().ok())
        .unwrap_or(NodeStatus::Todo);

    let priority_raw: Option<i64> = row.get(17)?;
    let priority = priority_raw.map(|p| p.clamp(0, 255) as u8);

    let start_line_raw: Option<i64> = row.get(7)?;
    let start_line = start_line_raw.map(|v| v.max(0) as usize);

    let end_line_raw: Option<i64> = row.get(8)?;
    let end_line = end_line_raw.map(|v| v.max(0) as usize);

    let depth_raw: Option<i64> = row.get(20)?;
    let depth = depth_raw.map(|v| v.max(0) as u32);

    let is_public_raw: Option<i64> = row.get(22)?;
    let is_public = is_public_raw.map(|v| v != 0);

    let node_type_raw: Option<String> = row.get(4)?;

    Ok(Node {
        id: row.get(0)?,
        title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        status,
        description: row.get(3)?,
        node_type: node_type_raw,
        file_path: row.get(5)?,
        lang: row.get(6)?,
        start_line,
        end_line,
        signature: row.get(9)?,
        visibility: row.get(10)?,
        doc_comment: row.get(11)?,
        body_hash: row.get(12)?,
        node_kind: row.get(13)?,
        owner: row.get(14)?,
        source: row.get(15)?,
        repo: row.get(16)?,
        priority,
        assigned_to: row.get(18)?,
        parent_id: row.get(19)?,
        depth,
        complexity: row.get(21)?,
        is_public,
        body: row.get(23)?,
        created_at: row.get(24)?,
        updated_at: row.get(25)?,
        // Loaded separately via load_node_extras
        tags: Vec::new(),
        metadata: HashMap::new(),
        knowledge: KnowledgeNode::default(),
    })
}

// ── Helper: execute put_node on a connection or transaction ─

fn put_node_on<C: std::ops::Deref<Target = Connection>>(
    conn: &C,
    node: &Node,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT OR REPLACE INTO nodes (
            id, title, status, description, node_type,
            file_path, lang, start_line, end_line, signature,
            visibility, doc_comment, body_hash, node_kind,
            owner, source, repo, priority, assigned_to,
            parent_id, depth, complexity, is_public,
            body, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18, ?19,
            ?20, ?21, ?22, ?23,
            ?24, ?25, ?26
        )",
        params![
            node.id,
            node.title,
            node.status.to_string(),
            node.description,
            node.node_type.as_deref().unwrap_or("unknown"),
            node.file_path,
            node.lang,
            node.start_line.map(|v| v as i64),
            node.end_line.map(|v| v as i64),
            node.signature,
            node.visibility,
            node.doc_comment,
            node.body_hash,
            node.node_kind,
            node.owner,
            node.source,
            node.repo,
            node.priority.map(|p| p as i64),
            node.assigned_to,
            node.parent_id,
            node.depth.map(|v| v as i64),
            node.complexity,
            node.is_public.map(|b| if b { 1i64 } else { 0 }),
            node.body,
            node.created_at,
            node.updated_at,
        ],
    )?;

    // Sync tags
    conn.execute("DELETE FROM node_tags WHERE node_id = ?", params![node.id])?;
    for tag in &node.tags {
        conn.execute(
            "INSERT INTO node_tags (node_id, tag) VALUES (?, ?)",
            params![node.id, tag],
        )?;
    }

    // Sync metadata
    conn.execute(
        "DELETE FROM node_metadata WHERE node_id = ?",
        params![node.id],
    )?;
    for (key, value) in &node.metadata {
        let value_str = serde_json::to_string(value)
            .unwrap_or_else(|_| value.to_string());
        conn.execute(
            "INSERT INTO node_metadata (node_id, key, value) VALUES (?, ?, ?)",
            params![node.id, key, value_str],
        )?;
    }

    // Sync knowledge (only if non-empty)
    if !node.knowledge.is_empty() {
        let findings = serde_json::to_string(&node.knowledge.findings)?;
        let file_cache = serde_json::to_string(&node.knowledge.file_cache)?;
        let tool_history = serde_json::to_string(&node.knowledge.tool_history)?;
        conn.execute(
            "INSERT OR REPLACE INTO knowledge (node_id, findings, file_cache, tool_history) VALUES (?, ?, ?, ?)",
            params![node.id, findings, file_cache, tool_history],
        )?;
    } else {
        conn.execute(
            "DELETE FROM knowledge WHERE node_id = ?",
            params![node.id],
        )?;
    }

    Ok(())
}

fn set_tags_on<C: std::ops::Deref<Target = Connection>>(
    conn: &C,
    node_id: &str,
    tags: &[String],
) -> Result<(), StorageError> {
    conn.execute("DELETE FROM node_tags WHERE node_id = ?", params![node_id])?;
    for tag in tags {
        conn.execute(
            "INSERT INTO node_tags (node_id, tag) VALUES (?, ?)",
            params![node_id, tag],
        )?;
    }
    Ok(())
}

fn set_metadata_on<C: std::ops::Deref<Target = Connection>>(
    conn: &C,
    node_id: &str,
    metadata: &HashMap<String, Value>,
) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM node_metadata WHERE node_id = ?",
        params![node_id],
    )?;
    for (key, value) in metadata {
        let value_str =
            serde_json::to_string(value).unwrap_or_else(|_| value.to_string());
        conn.execute(
            "INSERT INTO node_metadata (node_id, key, value) VALUES (?, ?, ?)",
            params![node_id, key, value_str],
        )?;
    }
    Ok(())
}

fn set_knowledge_on<C: std::ops::Deref<Target = Connection>>(
    conn: &C,
    node_id: &str,
    knowledge: &KnowledgeNode,
) -> Result<(), StorageError> {
    let findings = serde_json::to_string(&knowledge.findings)?;
    let file_cache = serde_json::to_string(&knowledge.file_cache)?;
    let tool_history = serde_json::to_string(&knowledge.tool_history)?;
    conn.execute(
        "INSERT OR REPLACE INTO knowledge (node_id, findings, file_cache, tool_history) VALUES (?, ?, ?, ?)",
        params![node_id, findings, file_cache, tool_history],
    )?;
    Ok(())
}

fn add_edge_on<C: std::ops::Deref<Target = Connection>>(
    conn: &C,
    edge: &Edge,
) -> Result<(), StorageError> {
    let metadata_json = edge
        .metadata
        .as_ref()
        .map(|m| serde_json::to_string(m).unwrap_or_else(|_| "null".to_string()));
    conn.execute(
        "INSERT INTO edges (from_node, to_node, relation, weight, confidence, metadata) VALUES (?, ?, ?, ?, ?, ?)",
        params![
            edge.from,
            edge.to,
            edge.relation,
            edge.weight,
            edge.confidence,
            metadata_json,
        ],
    )?;
    Ok(())
}

fn remove_edge_on<C: std::ops::Deref<Target = Connection>>(
    conn: &C,
    from: &str,
    to: &str,
    relation: &str,
) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM edges WHERE from_node = ? AND to_node = ? AND relation = ?",
        params![from, to, relation],
    )?;
    Ok(())
}

// ── GraphStorage implementation ────────────────────────────

impl GraphStorage for SqliteStorage {
    fn put_node(&self, node: &Node) -> Result<(), StorageError> {
        let conn = self.conn.borrow();
        put_node_on(&conn, node)?;
        tracing::debug!(node_id = %node.id, "put_node");
        Ok(())
    }

    fn get_node(&self, id: &str) -> Result<Option<Node>, StorageError> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare_cached("SELECT * FROM nodes WHERE id = ?")?;
        let result = stmt.query_row(params![id], row_to_node);
        match result {
            Ok(mut node) => {
                drop(stmt);
                drop(conn);
                self.load_node_extras(&mut node)?;
                Ok(Some(node))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn delete_node(&self, id: &str) -> Result<(), StorageError> {
        let conn = self.conn.borrow();
        conn.execute("DELETE FROM nodes WHERE id = ?", params![id])?;
        tracing::debug!(node_id = %id, "delete_node");
        Ok(())
    }

    fn get_edges(&self, node_id: &str) -> Result<Vec<Edge>, StorageError> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare_cached(
            "SELECT from_node, to_node, relation, weight, confidence, metadata FROM edges WHERE from_node = ? OR to_node = ?",
        )?;
        let edges = stmt
            .query_map(params![node_id, node_id], |row| {
                let metadata_str: Option<String> = row.get(5)?;
                let metadata: Option<Value> = metadata_str
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());
                Ok(Edge {
                    from: row.get(0)?,
                    to: row.get(1)?,
                    relation: row.get(2)?,
                    weight: row.get(3)?,
                    confidence: row.get(4)?,
                    metadata,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(edges)
    }

    fn add_edge(&self, edge: &Edge) -> Result<(), StorageError> {
        let conn = self.conn.borrow();
        add_edge_on(&conn, edge)?;
        tracing::debug!(from = %edge.from, to = %edge.to, relation = %edge.relation, "add_edge");
        Ok(())
    }

    fn remove_edge(&self, from: &str, to: &str, relation: &str) -> Result<(), StorageError> {
        let conn = self.conn.borrow();
        remove_edge_on(&conn, from, to, relation)?;
        tracing::debug!(%from, %to, %relation, "remove_edge");
        Ok(())
    }

    fn query_nodes(&self, filter: &NodeFilter) -> Result<Vec<Node>, StorageError> {
        let conn = self.conn.borrow();

        let mut sql = String::from("SELECT DISTINCT n.* FROM nodes n");
        let mut conditions: Vec<String> = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        // Join with node_tags if tag filter is present
        if filter.tag.is_some() {
            sql.push_str(" JOIN node_tags t ON n.id = t.node_id");
        }

        sql.push_str(" WHERE 1=1");

        if let Some(ref nt) = filter.node_type {
            conditions.push("n.node_type = ?".to_string());
            param_values.push(Box::new(nt.clone()));
        }

        if let Some(ref status) = filter.status {
            conditions.push("n.status = ?".to_string());
            param_values.push(Box::new(status.clone()));
        }

        if let Some(ref fp) = filter.file_path {
            conditions.push("n.file_path LIKE ?".to_string());
            param_values.push(Box::new(format!("{}%", fp)));
        }

        if let Some(ref tag) = filter.tag {
            conditions.push("t.tag = ?".to_string());
            param_values.push(Box::new(tag.clone()));
        }

        if let Some(ref owner) = filter.owner {
            conditions.push("n.owner = ?".to_string());
            param_values.push(Box::new(owner.clone()));
        }

        for cond in &conditions {
            sql.push_str(" AND ");
            sql.push_str(cond);
        }

        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT {}", limit));
        }

        if let Some(offset) = filter.offset {
            // OFFSET requires LIMIT; default to large number if not specified
            if filter.limit.is_none() {
                sql.push_str(" LIMIT -1");
            }
            sql.push_str(&format!(" OFFSET {}", offset));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let node_ids: Vec<Node> = stmt
            .query_map(param_refs.as_slice(), row_to_node)?
            .collect::<Result<Vec<_>, _>>()?;

        drop(stmt);
        drop(conn);

        let mut nodes = node_ids;
        for node in &mut nodes {
            self.load_node_extras(node)?;
        }
        Ok(nodes)
    }

    fn search(&self, query: &str) -> Result<Vec<Node>, StorageError> {
        let conn = self.conn.borrow();
        // Sanitize query for FTS5: wrap in double quotes for literal matching
        let sanitized = format!("\"{}\"", query.replace('"', "\"\""));

        let mut stmt = conn.prepare_cached(
            "SELECT n.* FROM nodes n JOIN nodes_fts f ON n.rowid = f.rowid WHERE nodes_fts MATCH ? ORDER BY rank",
        )?;
        let nodes: Vec<Node> = stmt
            .query_map(params![sanitized], row_to_node)?
            .collect::<Result<Vec<_>, _>>()?;

        drop(stmt);
        drop(conn);

        let mut nodes = nodes;
        for node in &mut nodes {
            self.load_node_extras(node)?;
        }
        Ok(nodes)
    }

    fn get_tags(&self, node_id: &str) -> Result<Vec<String>, StorageError> {
        let conn = self.conn.borrow();
        let mut stmt =
            conn.prepare_cached("SELECT tag FROM node_tags WHERE node_id = ?")?;
        let tags = stmt
            .query_map(params![node_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(tags)
    }

    fn set_tags(&self, node_id: &str, tags: &[String]) -> Result<(), StorageError> {
        let conn = self.conn.borrow();
        set_tags_on(&conn, node_id, tags)?;
        tracing::debug!(node_id = %node_id, count = tags.len(), "set_tags");
        Ok(())
    }

    fn get_metadata(&self, node_id: &str) -> Result<HashMap<String, Value>, StorageError> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare_cached(
            "SELECT key, value FROM node_metadata WHERE node_id = ?",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![node_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut metadata = HashMap::new();
        for (k, v) in rows {
            let val: Value = serde_json::from_str(&v).unwrap_or(Value::String(v));
            metadata.insert(k, val);
        }
        Ok(metadata)
    }

    fn set_metadata(
        &self,
        node_id: &str,
        metadata: &HashMap<String, Value>,
    ) -> Result<(), StorageError> {
        let conn = self.conn.borrow();
        set_metadata_on(&conn, node_id, metadata)?;
        tracing::debug!(node_id = %node_id, count = metadata.len(), "set_metadata");
        Ok(())
    }

    fn get_project_meta(&self) -> Result<Option<ProjectMeta>, StorageError> {
        let conn = self.conn.borrow();
        let name: Result<String, _> = conn.query_row(
            "SELECT value FROM config WHERE key = 'project_name'",
            [],
            |row| row.get(0),
        );
        match name {
            Ok(name) => {
                let description: Option<String> = conn
                    .query_row(
                        "SELECT value FROM config WHERE key = 'project_description'",
                        [],
                        |row| row.get(0),
                    )
                    .ok();
                Ok(Some(ProjectMeta { name, description }))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set_project_meta(&self, meta: &ProjectMeta) -> Result<(), StorageError> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT OR REPLACE INTO config (key, value) VALUES ('project_name', ?)",
            params![meta.name],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO config (key, value) VALUES ('project_description', ?)",
            params![meta.description.as_deref().unwrap_or("")],
        )?;
        tracing::debug!(project = %meta.name, "set_project_meta");
        Ok(())
    }

    fn get_knowledge(&self, node_id: &str) -> Result<Option<KnowledgeNode>, StorageError> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare_cached(
            "SELECT findings, file_cache, tool_history FROM knowledge WHERE node_id = ?",
        )?;
        let result = stmt.query_row(params![node_id], |row| {
            let findings_json: Option<String> = row.get(0)?;
            let file_cache_json: Option<String> = row.get(1)?;
            let tool_history_json: Option<String> = row.get(2)?;
            Ok((findings_json, file_cache_json, tool_history_json))
        });
        match result {
            Ok((findings_json, file_cache_json, tool_history_json)) => {
                Ok(Some(KnowledgeNode {
                    findings: findings_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or_default(),
                    file_cache: file_cache_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or_default(),
                    tool_history: tool_history_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or_default(),
                }))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set_knowledge(
        &self,
        node_id: &str,
        knowledge: &KnowledgeNode,
    ) -> Result<(), StorageError> {
        let conn = self.conn.borrow();
        set_knowledge_on(&conn, node_id, knowledge)?;
        tracing::debug!(node_id = %node_id, "set_knowledge");
        Ok(())
    }

    fn get_node_count(&self) -> Result<usize, StorageError> {
        let conn = self.conn.borrow();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    fn get_edge_count(&self) -> Result<usize, StorageError> {
        let conn = self.conn.borrow();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM edges", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    fn get_all_node_ids(&self) -> Result<Vec<String>, StorageError> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare_cached("SELECT id FROM nodes")?;
        let ids = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(ids)
    }

    fn execute_batch(&self, ops: &[BatchOp]) -> Result<(), StorageError> {
        let mut conn = self.conn.borrow_mut();
        let tx = conn.transaction()?;

        for op in ops {
            match op {
                BatchOp::PutNode(node) => {
                    put_node_on(&tx, node)?;
                }
                BatchOp::DeleteNode(id) => {
                    tx.execute("DELETE FROM nodes WHERE id = ?", params![id])?;
                }
                BatchOp::AddEdge(edge) => {
                    add_edge_on(&tx, edge)?;
                }
                BatchOp::RemoveEdge {
                    from,
                    to,
                    relation,
                } => {
                    remove_edge_on(&tx, from, to, relation)?;
                }
                BatchOp::SetTags(node_id, tags) => {
                    set_tags_on(&tx, node_id, tags)?;
                }
                BatchOp::SetMetadata(node_id, metadata) => {
                    set_metadata_on(&tx, node_id, metadata)?;
                }
                BatchOp::SetKnowledge(node_id, knowledge) => {
                    set_knowledge_on(&tx, node_id, knowledge)?;
                }
            }
        }

        tx.commit()?;
        tracing::debug!(ops_count = ops.len(), "execute_batch committed");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn temp_storage() -> SqliteStorage {
        let tmp = NamedTempFile::new().unwrap();
        SqliteStorage::open(tmp.path()).unwrap()
    }

    #[test]
    fn test_open_and_schema() {
        let storage = temp_storage();
        assert_eq!(storage.get_node_count().unwrap(), 0);
        assert_eq!(storage.get_edge_count().unwrap(), 0);
    }

    #[test]
    fn test_put_get_node() {
        let storage = temp_storage();
        let node = Node::new("n1", "Test Node")
            .with_description("A test node")
            .with_status(NodeStatus::InProgress)
            .with_tags(vec!["tag1".into(), "tag2".into()])
            .with_priority(5);

        storage.put_node(&node).unwrap();
        let loaded = storage.get_node("n1").unwrap().expect("node not found");
        assert_eq!(loaded.id, "n1");
        assert_eq!(loaded.title, "Test Node");
        assert_eq!(loaded.status, NodeStatus::InProgress);
        assert_eq!(loaded.description.as_deref(), Some("A test node"));
        assert_eq!(loaded.priority, Some(5));
        assert_eq!(loaded.tags, vec!["tag1", "tag2"]);
    }

    #[test]
    fn test_delete_node() {
        let storage = temp_storage();
        storage.put_node(&Node::new("n1", "Node")).unwrap();
        assert_eq!(storage.get_node_count().unwrap(), 1);
        storage.delete_node("n1").unwrap();
        assert_eq!(storage.get_node_count().unwrap(), 0);
        assert!(storage.get_node("n1").unwrap().is_none());
    }

    #[test]
    fn test_edges() {
        let storage = temp_storage();
        storage.put_node(&Node::new("a", "A")).unwrap();
        storage.put_node(&Node::new("b", "B")).unwrap();

        let edge = Edge::new("a", "b", "depends_on");
        storage.add_edge(&edge).unwrap();

        let edges = storage.get_edges("a").unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].from, "a");
        assert_eq!(edges[0].to, "b");
        assert_eq!(edges[0].relation, "depends_on");

        storage.remove_edge("a", "b", "depends_on").unwrap();
        assert_eq!(storage.get_edges("a").unwrap().len(), 0);
    }

    #[test]
    fn test_query_nodes() {
        let storage = temp_storage();
        let mut n1 = Node::new("n1", "Task 1");
        n1.node_type = Some("task".into());
        n1.status = NodeStatus::Todo;
        storage.put_node(&n1).unwrap();

        let mut n2 = Node::new("n2", "Task 2");
        n2.node_type = Some("task".into());
        n2.status = NodeStatus::Done;
        storage.put_node(&n2).unwrap();

        let mut n3 = Node::new("n3", "File 1");
        n3.node_type = Some("file".into());
        storage.put_node(&n3).unwrap();

        // Filter by type
        let results = storage
            .query_nodes(&NodeFilter::new().with_node_type("task"))
            .unwrap();
        assert_eq!(results.len(), 2);

        // Filter by status
        let results = storage
            .query_nodes(&NodeFilter::new().with_status("done"))
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "n2");

        // Limit
        let results = storage
            .query_nodes(&NodeFilter::new().with_limit(1))
            .unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_search() {
        let storage = temp_storage();
        let mut n1 = Node::new("n1", "Implement authentication");
        n1.description = Some("Add OAuth2 login flow".into());
        storage.put_node(&n1).unwrap();

        let results = storage.search("authentication").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "n1");

        let results = storage.search("nonexistent").unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_tags() {
        let storage = temp_storage();
        storage.put_node(&Node::new("n1", "Node")).unwrap();
        storage
            .set_tags("n1", &["rust".into(), "backend".into()])
            .unwrap();
        let tags = storage.get_tags("n1").unwrap();
        assert_eq!(tags.len(), 2);
        assert!(tags.contains(&"rust".to_string()));
        assert!(tags.contains(&"backend".to_string()));
    }

    #[test]
    fn test_metadata() {
        let storage = temp_storage();
        storage.put_node(&Node::new("n1", "Node")).unwrap();
        let mut meta = HashMap::new();
        meta.insert("key1".into(), Value::String("value1".into()));
        meta.insert("key2".into(), serde_json::json!(42));
        storage.set_metadata("n1", &meta).unwrap();

        let loaded = storage.get_metadata("n1").unwrap();
        assert_eq!(loaded.get("key1"), Some(&Value::String("value1".into())));
        assert_eq!(loaded.get("key2"), Some(&serde_json::json!(42)));
    }

    #[test]
    fn test_project_meta() {
        let storage = temp_storage();
        assert!(storage.get_project_meta().unwrap().is_none());

        let meta = ProjectMeta {
            name: "test-project".into(),
            description: Some("A test project".into()),
        };
        storage.set_project_meta(&meta).unwrap();

        let loaded = storage.get_project_meta().unwrap().unwrap();
        assert_eq!(loaded.name, "test-project");
        assert_eq!(loaded.description.as_deref(), Some("A test project"));
    }

    #[test]
    fn test_knowledge() {
        let storage = temp_storage();
        storage.put_node(&Node::new("n1", "Node")).unwrap();

        assert!(storage.get_knowledge("n1").unwrap().is_none());

        let mut knowledge = KnowledgeNode::default();
        knowledge.findings.insert("key".into(), "value".into());
        storage.set_knowledge("n1", &knowledge).unwrap();

        let loaded = storage.get_knowledge("n1").unwrap().unwrap();
        assert_eq!(loaded.findings.get("key").unwrap(), "value");
    }

    #[test]
    fn test_batch_ops() {
        let storage = temp_storage();
        let ops = vec![
            BatchOp::PutNode(Node::new("b1", "Batch 1")),
            BatchOp::PutNode(Node::new("b2", "Batch 2")),
            BatchOp::AddEdge(Edge::new("b1", "b2", "depends_on")),
            BatchOp::SetTags("b1".into(), vec!["batched".into()]),
        ];
        storage.execute_batch(&ops).unwrap();

        assert_eq!(storage.get_node_count().unwrap(), 2);
        assert_eq!(storage.get_edge_count().unwrap(), 1);
        assert_eq!(storage.get_tags("b1").unwrap(), vec!["batched"]);
    }

    #[test]
    fn test_get_all_node_ids() {
        let storage = temp_storage();
        storage.put_node(&Node::new("x", "X")).unwrap();
        storage.put_node(&Node::new("y", "Y")).unwrap();
        let mut ids = storage.get_all_node_ids().unwrap();
        ids.sort();
        assert_eq!(ids, vec!["x", "y"]);
    }
}
