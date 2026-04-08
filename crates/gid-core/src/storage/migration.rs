//! YAML → SQLite migration pipeline.
//!
//! Five-phase pipeline: Parse → Validate → Transform → Insert → Verify.
//! Design reference: `.gid/features/sqlite-migration/design-migration.md`

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use sha2::{Sha256, Digest};

use crate::graph::{Edge, Graph, Node};
use super::sqlite::SqliteStorage;
use super::trait_def::{BatchOp, GraphStorage};
use super::error::StorageError;

// ═══════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════

/// Controls migration behaviour. Constructed by CLI or calling code.
#[derive(Debug, Clone)]
pub struct MigrationConfig {
    /// Path to source YAML file (default: `.gid/graph.yml`).
    pub source_path: PathBuf,
    /// Path to SQLite database (default: `.gid/graph.db`).
    pub target_path: PathBuf,
    /// Directory for backup copies of the original YAML.
    /// `None` disables backup.
    pub backup_dir: Option<PathBuf>,
    /// Validation strictness.
    pub validation_level: ValidationLevel,
    /// When `true`, skip the pre-existence check and overwrite existing DB.
    pub force: bool,
    /// When `true`, emit detailed per-record diagnostics.
    pub verbose: bool,
}

impl Default for MigrationConfig {
    fn default() -> Self {
        Self {
            source_path: PathBuf::from(".gid/graph.yml"),
            target_path: PathBuf::from(".gid/graph.db"),
            backup_dir: Some(PathBuf::from(".gid/backups")),
            validation_level: ValidationLevel::Strict,
            force: false,
            verbose: false,
        }
    }
}

/// Validation strictness levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationLevel {
    /// Reject on structural errors (but duplicates/dangles are always warnings).
    Strict,
    /// Log warnings but continue if structurally recoverable.
    Permissive,
    /// Skip validation entirely (testing only).
    None,
}

// ═══════════════════════════════════════════════════════════
// Error types
// ═══════════════════════════════════════════════════════════

/// Migration-specific errors (separate from StorageError).
#[derive(Debug)]
pub enum MigrationError {
    SourceNotFound(String),
    TargetExists(String),
    ParseFailed(String),
    ValidationFailed(Vec<ValidationDiagnostic>),
    TransformFailed(String),
    InsertFailed(String),
    VerifyFailed(String),
    BackupFailed(String),
    Storage(StorageError),
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrationError::SourceNotFound(s) => write!(f, "source not found: {s}"),
            MigrationError::TargetExists(s) => write!(f, "target already exists: {s}"),
            MigrationError::ParseFailed(s) => write!(f, "YAML parse failed: {s}"),
            MigrationError::ValidationFailed(diags) => {
                write!(f, "validation failed: {} diagnostics", diags.len())
            }
            MigrationError::TransformFailed(s) => write!(f, "transform failed: {s}"),
            MigrationError::InsertFailed(s) => write!(f, "insert failed: {s}"),
            MigrationError::VerifyFailed(s) => write!(f, "verification failed: {s}"),
            MigrationError::BackupFailed(s) => write!(f, "backup failed: {s}"),
            MigrationError::Storage(e) => write!(f, "storage error: {e}"),
        }
    }
}

impl std::error::Error for MigrationError {}

impl From<StorageError> for MigrationError {
    fn from(err: StorageError) -> Self {
        MigrationError::Storage(err)
    }
}

/// Non-fatal diagnostics from validation.
#[derive(Debug, Clone)]
pub enum ValidationDiagnostic {
    DuplicateNodeId {
        id: String,
        kept_index: usize,
        dropped_index: usize,
    },
    DanglingEdgeRef {
        field: String,
        id: String,
    },
    UnknownNodeType(String),
    UnknownEdgeRelation(String),
    SelfLoop(String),
}

impl ValidationDiagnostic {
    /// True if this diagnostic is a hard error (blocks migration in Strict mode).
    /// Duplicates and dangling edges are always warnings per GOAL-2.9.
    pub fn is_error(&self) -> bool {
        matches!(
            self,
            ValidationDiagnostic::UnknownNodeType(_) | ValidationDiagnostic::UnknownEdgeRelation(_)
        )
    }
}

impl std::fmt::Display for ValidationDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationDiagnostic::DuplicateNodeId { id, kept_index, dropped_index } => {
                write!(f, "duplicate node ID '{id}': keeping index {kept_index}, dropping {dropped_index}")
            }
            ValidationDiagnostic::DanglingEdgeRef { field, id } => {
                write!(f, "dangling edge reference: {field}='{id}' not found in nodes")
            }
            ValidationDiagnostic::UnknownNodeType(t) => {
                write!(f, "unknown node type: '{t}'")
            }
            ValidationDiagnostic::UnknownEdgeRelation(r) => {
                write!(f, "unknown edge relation: '{r}'")
            }
            ValidationDiagnostic::SelfLoop(id) => {
                write!(f, "self-loop on node '{id}'")
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════
// Report types
// ═══════════════════════════════════════════════════════════

/// Migration outcome report.
#[derive(Debug, Clone)]
pub struct MigrationReport {
    pub nodes_migrated: u64,
    pub edges_migrated: u64,
    pub knowledge_migrated: u64,
    pub tags_migrated: u64,
    pub metadata_migrated: u64,
    pub warnings: Vec<ValidationDiagnostic>,
    pub status: MigrationStatus,
    pub duration: std::time::Duration,
    pub backup_path: Option<PathBuf>,
    pub source_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationStatus {
    Success,
    SuccessWithWarnings,
    Failed,
}

// ═══════════════════════════════════════════════════════════
// Validated intermediate type
// ═══════════════════════════════════════════════════════════

/// Graph data after validation: deduplicated nodes, original edges, diagnostics.
struct ValidatedGraph {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    project_name: Option<String>,
    diagnostics: Vec<ValidationDiagnostic>,
}

// ═══════════════════════════════════════════════════════════
// Insert stats (used for verification)
// ═══════════════════════════════════════════════════════════

#[derive(Debug, Default)]
struct InsertStats {
    nodes_inserted: u64,
    edges_inserted: u64,
    knowledge_inserted: u64,
    tags_inserted: u64,
    metadata_inserted: u64,
}

// ═══════════════════════════════════════════════════════════
// Known types for validation
// ═══════════════════════════════════════════════════════════

const KNOWN_NODE_TYPES: &[&str] = &[
    "task", "file", "component", "feature", "layer", "code", "module",
    "class", "function", "method", "trait", "enum", "struct", "interface",
    "test", "config", "doc", "legacy",
];

const KNOWN_EDGE_RELATIONS: &[&str] = &[
    "depends_on", "blocks", "subtask_of", "relates_to", "implements",
    "contains", "tests_for", "calls", "imports", "defined_in",
    "belongs_to", "maps_to", "overrides", "inherits",
    "documents", "extends", "specifies", "used_by",
];

fn is_known_node_type(t: &str) -> bool {
    KNOWN_NODE_TYPES.contains(&t)
}

fn is_known_edge_relation(r: &str) -> bool {
    KNOWN_EDGE_RELATIONS.contains(&r)
}

// ═══════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════

/// Run the full YAML → SQLite migration pipeline.
pub fn migrate(config: &MigrationConfig) -> Result<MigrationReport, MigrationError> {
    let start = Instant::now();

    // ── Precondition checks ──
    if !config.force {
        check_preconditions(config)?;
    } else if !config.source_path.exists() {
        return Err(MigrationError::SourceNotFound(format!(
            "source YAML not found: {}",
            config.source_path.display()
        )));
    } else if config.target_path.exists() {
        // Force mode: remove existing DB
        fs::remove_file(&config.target_path).map_err(|e| {
            MigrationError::InsertFailed(format!(
                "failed to remove existing DB at {}: {e}",
                config.target_path.display()
            ))
        })?;
    }

    // ── Phase 1: Parse ──
    let (graph, yaml_bytes) = parse_yaml(&config.source_path)?;

    // ── Phase 2: Validate ──
    let validated = validate(&graph, config.validation_level)?;

    // ── Phase 3: Transform ──
    let ops = transform(&validated)?;

    // ── Backup (before writes) ──
    let backup_path = if let Some(ref backup_dir) = config.backup_dir {
        Some(backup_source(&config.source_path, backup_dir)?)
    } else {
        None
    };

    // ── Phase 4: Insert ──
    let stats = insert(&config.target_path, &ops, &validated)?;

    // ── Phase 5: Verify ──
    verify(&config.target_path, &stats, &validated)?;

    // ── Build report ──
    let fingerprint = hex_sha256(&yaml_bytes);
    let has_warnings = !validated.diagnostics.is_empty();

    Ok(MigrationReport {
        nodes_migrated: stats.nodes_inserted,
        edges_migrated: stats.edges_inserted,
        knowledge_migrated: stats.knowledge_inserted,
        tags_migrated: stats.tags_inserted,
        metadata_migrated: stats.metadata_inserted,
        warnings: validated.diagnostics,
        status: if has_warnings {
            MigrationStatus::SuccessWithWarnings
        } else {
            MigrationStatus::Success
        },
        duration: start.elapsed(),
        backup_path,
        source_fingerprint: fingerprint,
    })
}

// ═══════════════════════════════════════════════════════════
// Phase 0: Precondition checks
// ═══════════════════════════════════════════════════════════

fn check_preconditions(config: &MigrationConfig) -> Result<(), MigrationError> {
    if config.target_path.exists() {
        return Err(MigrationError::TargetExists(format!(
            "SQLite database already exists at {}. Use --force to overwrite.",
            config.target_path.display()
        )));
    }
    if !config.source_path.exists() {
        return Err(MigrationError::SourceNotFound(format!(
            "no YAML graph found at {}",
            config.source_path.display()
        )));
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════
// Phase 1: Parse
// ═══════════════════════════════════════════════════════════

fn parse_yaml(source_path: &Path) -> Result<(Graph, Vec<u8>), MigrationError> {
    let bytes = fs::read(source_path).map_err(|e| {
        MigrationError::ParseFailed(format!("failed to read {}: {e}", source_path.display()))
    })?;

    // File size check: reject > 100MB
    if bytes.len() > 100 * 1024 * 1024 {
        return Err(MigrationError::ParseFailed(format!(
            "file too large: {} bytes, max 100MB",
            bytes.len()
        )));
    }

    // Empty file → empty graph
    if bytes.is_empty() {
        return Ok((Graph::default(), bytes));
    }

    let yaml_str = std::str::from_utf8(&bytes).map_err(|e| {
        MigrationError::ParseFailed(format!("non-UTF-8 content: {e}"))
    })?;

    let graph: Graph = serde_yaml::from_str(yaml_str).map_err(|e| {
        MigrationError::ParseFailed(format!("YAML deserialization failed: {e}"))
    })?;

    Ok((graph, bytes))
}

// ═══════════════════════════════════════════════════════════
// Phase 2: Validate
// ═══════════════════════════════════════════════════════════

fn validate(graph: &Graph, level: ValidationLevel) -> Result<ValidatedGraph, MigrationError> {
    if level == ValidationLevel::None {
        return Ok(ValidatedGraph {
            nodes: graph.nodes.clone(),
            edges: graph.edges.clone(),
            project_name: graph.project.as_ref().map(|p| p.name.clone()),
            diagnostics: vec![],
        });
    }

    let mut diagnostics: Vec<ValidationDiagnostic> = Vec::new();

    // 5.1 — Duplicate node IDs (last wins + warning)
    let mut seen_ids: HashMap<&str, usize> = HashMap::new();
    for (i, node) in graph.nodes.iter().enumerate() {
        if let Some(prev_idx) = seen_ids.insert(&node.id, i) {
            diagnostics.push(ValidationDiagnostic::DuplicateNodeId {
                id: node.id.clone(),
                kept_index: i,
                dropped_index: prev_idx,
            });
        }
    }

    // 5.2 — Dangling edge references (warn only)
    for edge in &graph.edges {
        if !seen_ids.contains_key(edge.from.as_str()) {
            diagnostics.push(ValidationDiagnostic::DanglingEdgeRef {
                field: "from".into(),
                id: edge.from.clone(),
            });
        }
        if !seen_ids.contains_key(edge.to.as_str()) {
            diagnostics.push(ValidationDiagnostic::DanglingEdgeRef {
                field: "to".into(),
                id: edge.to.clone(),
            });
        }
    }

    // 5.3 — Type checks
    for node in &graph.nodes {
        if let Some(ref t) = node.node_type {
            if !is_known_node_type(t) {
                diagnostics.push(ValidationDiagnostic::UnknownNodeType(t.clone()));
            }
        }
    }
    for edge in &graph.edges {
        if !is_known_edge_relation(&edge.relation) {
            diagnostics.push(ValidationDiagnostic::UnknownEdgeRelation(edge.relation.clone()));
        }
    }

    // 5.4 — Self-loops
    for edge in &graph.edges {
        if edge.from == edge.to {
            diagnostics.push(ValidationDiagnostic::SelfLoop(edge.from.clone()));
        }
    }

    // Deduplicate nodes (last wins)
    let deduped_nodes = deduplicate_nodes(&graph.nodes, &seen_ids);

    // In Strict mode, only true errors (not warnings) block migration
    if level == ValidationLevel::Strict {
        let errors: Vec<_> = diagnostics.iter().filter(|d| d.is_error()).cloned().collect();
        if !errors.is_empty() {
            return Err(MigrationError::ValidationFailed(errors));
        }
    }

    Ok(ValidatedGraph {
        nodes: deduped_nodes,
        edges: graph.edges.clone(),
        project_name: graph.project.as_ref().map(|p| p.name.clone()),
        diagnostics,
    })
}

fn deduplicate_nodes(nodes: &[Node], seen_ids: &HashMap<&str, usize>) -> Vec<Node> {
    // Keep only the last occurrence of each ID
    nodes
        .iter()
        .enumerate()
        .filter(|(i, node)| seen_ids.get(node.id.as_str()) == Some(i))
        .map(|(_, node)| node.clone())
        .collect()
}

// ═══════════════════════════════════════════════════════════
// Phase 3: Transform
// ═══════════════════════════════════════════════════════════

fn transform(validated: &ValidatedGraph) -> Result<Vec<BatchOp>, MigrationError> {
    let mut ops = Vec::new();

    for node in &validated.nodes {
        // Node itself
        ops.push(BatchOp::PutNode(node.clone()));

        // Tags → separate table
        if !node.tags.is_empty() {
            ops.push(BatchOp::SetTags(node.id.clone(), node.tags.clone()));
        }

        // Metadata → separate table
        if !node.metadata.is_empty() {
            ops.push(BatchOp::SetMetadata(node.id.clone(), node.metadata.clone()));
        }

        // Knowledge → separate table
        if !node.knowledge.is_empty() {
            ops.push(BatchOp::SetKnowledge(node.id.clone(), node.knowledge.clone()));
        }
    }

    for edge in &validated.edges {
        ops.push(BatchOp::AddEdge(edge.clone()));
    }

    Ok(ops)
}

// ═══════════════════════════════════════════════════════════
// Phase 4: Insert
// ═══════════════════════════════════════════════════════════

fn insert(
    target_path: &Path,
    ops: &[BatchOp],
    validated: &ValidatedGraph,
) -> Result<InsertStats, MigrationError> {
    // Open DB (creates it + applies schema)
    let storage = SqliteStorage::open(target_path)?;

    // Set project metadata if available
    if let Some(ref name) = validated.project_name {
        let meta = crate::graph::ProjectMeta {
            name: name.clone(),
            description: None,
        };
        storage.set_project_meta(&meta)?;
    }

    // Disable FK enforcement for migration (dangling edges, GOAL-2.9).
    // SqliteStorage wraps Connection in RefCell, so we need direct SQL access.
    // Instead, we'll use execute_batch which already handles transactions.
    // But we need FK off before the batch. Use a two-step approach:
    // 1. Turn off FK via a single PragmaOff op (we do this via raw SQL on the storage)
    // 2. Run batch
    // 3. Turn FK back on
    //
    // Since SqliteStorage doesn't expose raw SQL, we handle dangling edges
    // by using execute_batch which catches FK violations. The schema has
    // ON DELETE CASCADE but we need to handle refs to non-existent nodes.
    //
    // Actually, SqliteStorage::execute_batch wraps in a transaction. The FK
    // constraint is checked at commit time with deferred FKs, or immediately
    // with PRAGMA foreign_keys=ON. We need to temporarily disable it.
    //
    // Use SqliteStorage's internal conn via a dedicated migration method.
    storage.execute_migration_batch(ops)?;

    // Count what we inserted
    let mut stats = InsertStats::default();
    for op in ops {
        match op {
            BatchOp::PutNode(_) => stats.nodes_inserted += 1,
            BatchOp::AddEdge(_) => stats.edges_inserted += 1,
            BatchOp::SetTags(_, tags) => stats.tags_inserted += tags.len() as u64,
            BatchOp::SetMetadata(_, meta) => stats.metadata_inserted += meta.len() as u64,
            BatchOp::SetKnowledge(_, _) => stats.knowledge_inserted += 1,
            _ => {}
        }
    }

    Ok(stats)
}

// ═══════════════════════════════════════════════════════════
// Phase 5: Verify
// ═══════════════════════════════════════════════════════════

fn verify(
    target_path: &Path,
    expected: &InsertStats,
    validated: &ValidatedGraph,
) -> Result<(), MigrationError> {
    let storage = SqliteStorage::open(target_path).map_err(|e| {
        MigrationError::VerifyFailed(format!("failed to reopen DB for verification: {e}"))
    })?;

    // ── Count verification ──
    let node_count = storage.get_node_count().map_err(|e| {
        MigrationError::VerifyFailed(format!("failed to count nodes: {e}"))
    })? as u64;

    let edge_count = storage.get_edge_count().map_err(|e| {
        MigrationError::VerifyFailed(format!("failed to count edges: {e}"))
    })? as u64;

    if node_count != expected.nodes_inserted {
        return Err(MigrationError::VerifyFailed(format!(
            "node count mismatch: expected {}, got {node_count}",
            expected.nodes_inserted
        )));
    }

    if edge_count != expected.edges_inserted {
        return Err(MigrationError::VerifyFailed(format!(
            "edge count mismatch: expected {}, got {edge_count}",
            expected.edges_inserted
        )));
    }

    // ── Content verification: sample up to 20 nodes ──
    let sample_size = validated.nodes.len().min(20);
    // Pick evenly spaced nodes: first, last, and uniformly distributed
    let indices: Vec<usize> = if validated.nodes.is_empty() {
        vec![]
    } else if validated.nodes.len() <= sample_size {
        (0..validated.nodes.len()).collect()
    } else {
        let step = validated.nodes.len() as f64 / sample_size as f64;
        (0..sample_size).map(|i| (i as f64 * step) as usize).collect()
    };

    for idx in indices {
        let src_node = &validated.nodes[idx];
        let db_node = storage.get_node(&src_node.id).map_err(|e| {
            MigrationError::VerifyFailed(format!(
                "failed to read node '{}': {e}", src_node.id
            ))
        })?;

        let db_node = match db_node {
            Some(n) => n,
            None => {
                return Err(MigrationError::VerifyFailed(format!(
                    "node '{}' not found in SQLite", src_node.id
                )));
            }
        };

        // Core fields
        if db_node.title != src_node.title {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' title mismatch: YAML='{}' DB='{}'",
                src_node.id, src_node.title, db_node.title
            )));
        }
        if db_node.status != src_node.status {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' status mismatch: YAML='{}' DB='{}'",
                src_node.id, src_node.status, db_node.status
            )));
        }
        if db_node.node_type != src_node.node_type {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' type mismatch: YAML={:?} DB={:?}",
                src_node.id, src_node.node_type, db_node.node_type
            )));
        }

        // Code-specific fields
        if db_node.file_path != src_node.file_path {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' file_path mismatch: YAML={:?} DB={:?}",
                src_node.id, src_node.file_path, db_node.file_path
            )));
        }
        if db_node.lang != src_node.lang {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' lang mismatch: YAML={:?} DB={:?}",
                src_node.id, src_node.lang, db_node.lang
            )));
        }
        if db_node.start_line != src_node.start_line {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' start_line mismatch: YAML={:?} DB={:?}",
                src_node.id, src_node.start_line, db_node.start_line
            )));
        }
        if db_node.end_line != src_node.end_line {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' end_line mismatch: YAML={:?} DB={:?}",
                src_node.id, src_node.end_line, db_node.end_line
            )));
        }
        if db_node.signature != src_node.signature {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' signature mismatch: YAML={:?} DB={:?}",
                src_node.id, src_node.signature, db_node.signature
            )));
        }
        if db_node.node_kind != src_node.node_kind {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' node_kind mismatch: YAML={:?} DB={:?}",
                src_node.id, src_node.node_kind, db_node.node_kind
            )));
        }

        // Tags
        let db_tags = storage.get_tags(&src_node.id).map_err(|e| {
            MigrationError::VerifyFailed(format!(
                "failed to read tags for '{}': {e}", src_node.id
            ))
        })?;
        let mut src_tags = src_node.tags.clone();
        let mut db_tags_sorted = db_tags.clone();
        src_tags.sort();
        db_tags_sorted.sort();
        if src_tags != db_tags_sorted {
            return Err(MigrationError::VerifyFailed(format!(
                "node '{}' tags mismatch: YAML={:?} DB={:?}",
                src_node.id, src_node.tags, db_tags
            )));
        }

        // Metadata
        if !src_node.metadata.is_empty() {
            let db_meta = storage.get_metadata(&src_node.id).map_err(|e| {
                MigrationError::VerifyFailed(format!(
                    "failed to read metadata for '{}': {e}", src_node.id
                ))
            })?;
            for (key, val) in &src_node.metadata {
                match db_meta.get(key) {
                    Some(db_val) if db_val == val => {}
                    Some(db_val) => {
                        return Err(MigrationError::VerifyFailed(format!(
                            "node '{}' metadata key '{}' mismatch: YAML={} DB={}",
                            src_node.id, key, val, db_val
                        )));
                    }
                    None => {
                        return Err(MigrationError::VerifyFailed(format!(
                            "node '{}' metadata key '{}' missing in DB",
                            src_node.id, key
                        )));
                    }
                }
            }
        }

        // Knowledge
        if !src_node.knowledge.is_empty() {
            let db_knowledge = storage.get_knowledge(&src_node.id).map_err(|e| {
                MigrationError::VerifyFailed(format!(
                    "failed to read knowledge for '{}': {e}", src_node.id
                ))
            })?;
            match db_knowledge {
                Some(k) if k == src_node.knowledge => {}
                Some(k) => {
                    return Err(MigrationError::VerifyFailed(format!(
                        "node '{}' knowledge mismatch: YAML findings={} DB findings={}",
                        src_node.id,
                        src_node.knowledge.findings.len(),
                        k.findings.len()
                    )));
                }
                None => {
                    return Err(MigrationError::VerifyFailed(format!(
                        "node '{}' knowledge missing in DB",
                        src_node.id
                    )));
                }
            }
        }
    }

    // ── Edge content verification: sample up to 20 edges ──
    let edge_sample_size = validated.edges.len().min(20);
    let edge_indices: Vec<usize> = if validated.edges.is_empty() {
        vec![]
    } else if validated.edges.len() <= edge_sample_size {
        (0..validated.edges.len()).collect()
    } else {
        let step = validated.edges.len() as f64 / edge_sample_size as f64;
        (0..edge_sample_size).map(|i| (i as f64 * step) as usize).collect()
    };

    for idx in edge_indices {
        let src_edge = &validated.edges[idx];
        let db_edges = storage.get_edges(&src_edge.from).map_err(|e| {
            MigrationError::VerifyFailed(format!(
                "failed to read edges for '{}': {e}", src_edge.from
            ))
        })?;

        let found = db_edges.iter().any(|e| {
            e.from == src_edge.from && e.to == src_edge.to && e.relation == src_edge.relation
        });

        if !found {
            return Err(MigrationError::VerifyFailed(format!(
                "edge '{}' -> '{}' ({}) not found in SQLite",
                src_edge.from, src_edge.to, src_edge.relation
            )));
        }
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════
// Backup
// ═══════════════════════════════════════════════════════════

fn backup_source(source_path: &Path, backup_dir: &Path) -> Result<PathBuf, MigrationError> {
    fs::create_dir_all(backup_dir).map_err(|e| {
        MigrationError::BackupFailed(format!(
            "failed to create backup dir {}: {e}",
            backup_dir.display()
        ))
    })?;

    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let backup_path = backup_dir.join(format!("graph.yml.{timestamp}.bak"));

    fs::copy(source_path, &backup_path).map_err(|e| {
        MigrationError::BackupFailed(format!(
            "failed to copy {} → {}: {e}",
            source_path.display(),
            backup_path.display()
        ))
    })?;

    Ok(backup_path)
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

fn hex_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_yaml(dir: &Path, content: &str) -> PathBuf {
        let gid_dir = dir.join(".gid");
        fs::create_dir_all(&gid_dir).unwrap();
        let path = gid_dir.join("graph.yml");
        fs::write(&path, content).unwrap();
        path
    }

    const BASIC_YAML: &str = r#"
project:
  name: test-project
nodes:
- id: task-1
  title: First task
  status: todo
  type: task
  tags:
  - p0
  - core
  description: A test task
- id: task-2
  title: Second task
  status: done
  type: task
- id: file-1
  title: main.rs
  status: done
  type: code
  file_path: src/main.rs
  lang: rust
  start_line: 1
  end_line: 50
  signature: "fn main()"
  node_kind: Function
  source: extract
  metadata:
    line_count: 50
edges:
- from: task-2
  to: task-1
  relation: depends_on
"#;

    #[test]
    fn test_parse_basic_yaml() {
        let dir = TempDir::new().unwrap();
        let path = write_yaml(dir.path(), BASIC_YAML);
        let (graph, _bytes) = parse_yaml(&path).unwrap();

        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.project.as_ref().unwrap().name, "test-project");

        let node0 = &graph.nodes[0];
        assert_eq!(node0.id, "task-1");
        assert_eq!(node0.title, "First task");

        let node2 = &graph.nodes[2];
        assert_eq!(node2.file_path.as_deref(), Some("src/main.rs"));
        assert_eq!(node2.lang.as_deref(), Some("rust"));
        assert_eq!(node2.start_line, Some(1));
        assert_eq!(node2.end_line, Some(50));
        assert_eq!(node2.node_kind.as_deref(), Some("Function"));
    }

    #[test]
    fn test_parse_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = write_yaml(dir.path(), "");
        let (graph, _) = parse_yaml(&path).unwrap();
        assert!(graph.nodes.is_empty());
        assert!(graph.edges.is_empty());
    }

    #[test]
    fn test_parse_file_not_found() {
        let result = parse_yaml(Path::new("/nonexistent/graph.yml"));
        assert!(matches!(result, Err(MigrationError::ParseFailed(_))));
    }

    #[test]
    fn test_validate_duplicate_ids() {
        let graph = Graph {
            project: None,
            nodes: vec![
                Node::new("dup", "First"),
                Node::new("unique", "Unique"),
                Node::new("dup", "Second (wins)"),
            ],
            edges: vec![],
        };

        let validated = validate(&graph, ValidationLevel::Strict).unwrap();
        assert_eq!(validated.nodes.len(), 2); // deduped
        assert_eq!(validated.diagnostics.len(), 1);
        assert!(matches!(
            &validated.diagnostics[0],
            ValidationDiagnostic::DuplicateNodeId { id, .. } if id == "dup"
        ));
        // Last wins: "Second (wins)" should be kept
        let dup_node = validated.nodes.iter().find(|n| n.id == "dup").unwrap();
        assert_eq!(dup_node.title, "Second (wins)");
    }

    #[test]
    fn test_validate_dangling_edges() {
        let graph = Graph {
            project: None,
            nodes: vec![Node::new("a", "Node A")],
            edges: vec![Edge::new("a", "nonexistent", "depends_on")],
        };

        // Dangling edges are warnings, not errors — migration should succeed
        let validated = validate(&graph, ValidationLevel::Strict).unwrap();
        assert_eq!(validated.diagnostics.len(), 1);
        assert!(matches!(
            &validated.diagnostics[0],
            ValidationDiagnostic::DanglingEdgeRef { field, id }
            if field == "to" && id == "nonexistent"
        ));
    }

    #[test]
    fn test_validate_self_loop() {
        let graph = Graph {
            project: None,
            nodes: vec![Node::new("a", "Node A")],
            edges: vec![Edge::new("a", "a", "depends_on")],
        };

        let validated = validate(&graph, ValidationLevel::Strict).unwrap();
        assert!(validated.diagnostics.iter().any(|d| matches!(d, ValidationDiagnostic::SelfLoop(_))));
    }

    #[test]
    fn test_transform_basic() {
        let validated = ValidatedGraph {
            nodes: vec![
                {
                    let mut n = Node::new("t1", "Task 1");
                    n.tags = vec!["p0".to_string()];
                    n.metadata.insert("custom_key".to_string(), serde_json::json!("value"));
                    n
                },
            ],
            edges: vec![Edge::new("t1", "t2", "depends_on")],
            project_name: None,
            diagnostics: vec![],
        };

        let ops = transform(&validated).unwrap();
        // PutNode + SetTags + SetMetadata + AddEdge = 4
        assert_eq!(ops.len(), 4);
        assert!(matches!(&ops[0], BatchOp::PutNode(_)));
        assert!(matches!(&ops[1], BatchOp::SetTags(_, _)));
        assert!(matches!(&ops[2], BatchOp::SetMetadata(_, _)));
        assert!(matches!(&ops[3], BatchOp::AddEdge(_)));
    }

    #[test]
    fn test_transform_with_knowledge() {
        let validated = ValidatedGraph {
            nodes: vec![
                {
                    let mut n = Node::new("t1", "Task 1");
                    n.knowledge.findings.insert("key".to_string(), "value".to_string());
                    n
                },
            ],
            edges: vec![],
            project_name: None,
            diagnostics: vec![],
        };

        let ops = transform(&validated).unwrap();
        // PutNode + SetKnowledge = 2
        assert_eq!(ops.len(), 2);
        assert!(matches!(&ops[1], BatchOp::SetKnowledge(_, _)));
    }

    #[test]
    fn test_full_migration_pipeline() {
        let dir = TempDir::new().unwrap();
        let source = write_yaml(dir.path(), BASIC_YAML);
        let target = dir.path().join(".gid/graph.db");

        let config = MigrationConfig {
            source_path: source,
            target_path: target.clone(),
            backup_dir: Some(dir.path().join(".gid/backups")),
            validation_level: ValidationLevel::Strict,
            force: false,
            verbose: false,
        };

        let report = migrate(&config).unwrap();
        assert_eq!(report.nodes_migrated, 3);
        assert_eq!(report.edges_migrated, 1);
        assert!(report.status == MigrationStatus::Success || report.status == MigrationStatus::SuccessWithWarnings);
        assert!(target.exists());
        assert!(report.backup_path.is_some());
        assert!(!report.source_fingerprint.is_empty());

        // Verify we can read back from SQLite
        let storage = SqliteStorage::open(&target).unwrap();
        assert_eq!(storage.get_node_count().unwrap(), 3);
        assert_eq!(storage.get_edge_count().unwrap(), 1);

        // Verify specific node data
        let node = storage.get_node("file-1").unwrap().unwrap();
        assert_eq!(node.file_path.as_deref(), Some("src/main.rs"));
        assert_eq!(node.lang.as_deref(), Some("rust"));
        assert_eq!(node.start_line, Some(1));
        assert_eq!(node.node_kind.as_deref(), Some("Function"));
    }

    #[test]
    fn test_migration_target_exists_error() {
        let dir = TempDir::new().unwrap();
        let source = write_yaml(dir.path(), BASIC_YAML);
        let target = dir.path().join(".gid/graph.db");

        // Create target file first
        fs::write(&target, b"existing").unwrap();

        let config = MigrationConfig {
            source_path: source,
            target_path: target,
            backup_dir: None,
            validation_level: ValidationLevel::Strict,
            force: false,
            verbose: false,
        };

        let result = migrate(&config);
        assert!(matches!(result, Err(MigrationError::TargetExists(_))));
    }

    #[test]
    fn test_migration_force_overwrite() {
        let dir = TempDir::new().unwrap();
        let source = write_yaml(dir.path(), BASIC_YAML);
        let target = dir.path().join(".gid/graph.db");

        // First migration
        let config = MigrationConfig {
            source_path: source.clone(),
            target_path: target.clone(),
            backup_dir: None,
            validation_level: ValidationLevel::Strict,
            force: false,
            verbose: false,
        };
        migrate(&config).unwrap();

        // Second migration with force
        let config2 = MigrationConfig {
            source_path: source,
            target_path: target.clone(),
            backup_dir: None,
            validation_level: ValidationLevel::Strict,
            force: true,
            verbose: false,
        };
        let report = migrate(&config2).unwrap();
        assert_eq!(report.nodes_migrated, 3);
    }

    #[test]
    fn test_migration_source_not_found() {
        let dir = TempDir::new().unwrap();
        let config = MigrationConfig {
            source_path: dir.path().join("nonexistent.yml"),
            target_path: dir.path().join("graph.db"),
            backup_dir: None,
            validation_level: ValidationLevel::Strict,
            force: false,
            verbose: false,
        };

        let result = migrate(&config);
        assert!(matches!(result, Err(MigrationError::SourceNotFound(_))));
    }

    #[test]
    fn test_validate_skip() {
        let graph = Graph {
            project: None,
            nodes: vec![Node::new("a", "Node A")],
            edges: vec![Edge::new("a", "nonexistent", "totally_bogus_relation")],
        };

        // None level skips all validation
        let validated = validate(&graph, ValidationLevel::None).unwrap();
        assert!(validated.diagnostics.is_empty());
    }

    #[test]
    fn test_content_verification_all_fields() {
        // Comprehensive test: every node field must survive the round-trip
        let yaml = r#"
project:
  name: verify-project
nodes:
- id: task-a
  title: Task Alpha
  status: todo
  type: task
  description: A detailed description
  tags:
  - urgent
  - backend
  - p0
  metadata:
    assignee: potato
    sprint: 3
    estimated_hours: 4.5
- id: code-fn
  title: "fn process_data()"
  status: done
  type: code
  file_path: src/core/processor.rs
  lang: rust
  start_line: 42
  end_line: 85
  signature: "pub fn process_data(input: &str) -> Result<Output>"
  node_kind: Function
  source: extract
  metadata:
    line_count: 44
    complexity: high
- id: code-struct
  title: Processor
  status: done
  type: code
  file_path: src/core/processor.rs
  lang: rust
  start_line: 10
  end_line: 25
  node_kind: Class
  source: extract
edges:
- from: task-a
  to: code-fn
  relation: implements
- from: code-fn
  to: code-struct
  relation: defined_in
- from: code-struct
  to: code-fn
  relation: contains
"#;
        let dir = TempDir::new().unwrap();
        let source = write_yaml(dir.path(), yaml);
        let target = dir.path().join(".gid/graph.db");

        let config = MigrationConfig {
            source_path: source,
            target_path: target.clone(),
            backup_dir: None,
            validation_level: ValidationLevel::Strict,
            force: false,
            verbose: false,
        };

        // Migration succeeds (including content verification in verify phase)
        let report = migrate(&config).unwrap();
        assert_eq!(report.nodes_migrated, 3);
        assert_eq!(report.edges_migrated, 3);
        assert_eq!(report.status, MigrationStatus::Success);

        // Manual round-trip verification of every field
        let storage = SqliteStorage::open(&target).unwrap();

        // ── task-a ──
        let n = storage.get_node("task-a").unwrap().unwrap();
        assert_eq!(n.title, "Task Alpha");
        assert_eq!(n.status, crate::graph::NodeStatus::Todo);
        assert_eq!(n.node_type.as_deref(), Some("task"));
        assert_eq!(n.description.as_deref(), Some("A detailed description"));
        assert!(n.file_path.is_none());
        assert!(n.lang.is_none());

        let tags = storage.get_tags("task-a").unwrap();
        let mut sorted_tags = tags.clone();
        sorted_tags.sort();
        assert_eq!(sorted_tags, vec!["backend", "p0", "urgent"]);

        let meta = storage.get_metadata("task-a").unwrap();
        assert_eq!(meta.get("assignee"), Some(&serde_json::json!("potato")));
        assert_eq!(meta.get("sprint"), Some(&serde_json::json!(3)));
        assert_eq!(meta.get("estimated_hours"), Some(&serde_json::json!(4.5)));

        // ── code-fn ──
        let n = storage.get_node("code-fn").unwrap().unwrap();
        assert_eq!(n.title, "fn process_data()");
        assert_eq!(n.file_path.as_deref(), Some("src/core/processor.rs"));
        assert_eq!(n.lang.as_deref(), Some("rust"));
        assert_eq!(n.start_line, Some(42));
        assert_eq!(n.end_line, Some(85));
        assert_eq!(
            n.signature.as_deref(),
            Some("pub fn process_data(input: &str) -> Result<Output>")
        );
        assert_eq!(n.node_kind.as_deref(), Some("Function"));
        assert_eq!(n.source.as_deref(), Some("extract"));

        let meta = storage.get_metadata("code-fn").unwrap();
        assert_eq!(meta.get("line_count"), Some(&serde_json::json!(44)));
        assert_eq!(meta.get("complexity"), Some(&serde_json::json!("high")));

        // ── code-struct ──
        let n = storage.get_node("code-struct").unwrap().unwrap();
        assert_eq!(n.node_kind.as_deref(), Some("Class"));
        assert_eq!(n.start_line, Some(10));
        assert_eq!(n.end_line, Some(25));

        // ── Edges ──
        let edges = storage.get_edges("task-a").unwrap();
        assert!(edges.iter().any(|e| e.to == "code-fn" && e.relation == "implements"));

        let edges = storage.get_edges("code-fn").unwrap();
        assert!(edges.iter().any(|e| e.to == "code-struct" && e.relation == "defined_in"));

        let edges = storage.get_edges("code-struct").unwrap();
        assert!(edges.iter().any(|e| e.to == "code-fn" && e.relation == "contains"));
    }

    #[test]
    fn test_sha256_fingerprint() {
        let hash = hex_sha256(b"hello world");
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_backup_creates_file() {
        let dir = TempDir::new().unwrap();
        let source = write_yaml(dir.path(), BASIC_YAML);
        let backup_dir = dir.path().join("backups");

        let backup_path = backup_source(&source, &backup_dir).unwrap();
        assert!(backup_path.exists());
        assert!(backup_dir.exists());
    }
}
