# Design: `infer-integration` — Graph Output, CLI & API

## §1 Overview

### §1.1 Goals

The integration layer that:
1. Merges clustering + labeling results into the graph (YAML or SQLite)
2. Provides the `gid infer` CLI command
3. Exposes a Rust library API for GidHub

**Covers**: GOAL-3.1 through GOAL-5.5

### §1.2 Non-Goals

- Clustering algorithm (see `infer-clustering`)
- LLM interaction (see `infer-labeling`)

### §1.3 Trade-offs

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| API returns result, caller merges | Yes — `run() -> InferResult` | Mutate graph internally | Testable, composable. GidHub and CLI have different merge strategies. |
| Incremental = delete-then-add | Clear `source: infer` nodes, re-add | Diff-based update | Simpler, idempotent, no drift. Infer runs in seconds — full recompute is fine. |
| Auto-extract trigger | If code layer empty + source path given | Always re-extract | Avoid redundant work. Extract is expensive for large repos. |

---

## §2 Architecture

```
                    ┌──────────────┐
                    │  gid infer   │  (CLI command, §3.5)
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  infer::run  │  (Public API, §3.4)
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
     ┌────────────┐ ┌───────────┐ ┌──────────┐
     │ clustering │ │ labeling  │ │  merger   │
     │  (§dep)    │ │  (§dep)   │ │  (§3.1)  │
     └────────────┘ └───────────┘ └──────────┘
                                       │
                              ┌────────┼────────┐
                              ▼        ▼        ▼
                          graph.yml  SQLite   stdout
                                              (dry-run)
```

---

## §3 Components

### §3.1 GraphMerger

Merges InferResult into an existing graph, respecting guards.

```rust
/// Stats from what merge_into_graph() actually persisted.
pub struct MergeStats {
    /// Number of component nodes added/updated
    pub components_added: usize,
    /// Number of feature nodes added/updated
    pub features_added: usize,
    /// Number of edges added
    pub edges_added: usize,
    /// Number of old infer nodes removed (incremental re-run)
    pub old_nodes_removed: usize,
    /// Number of old infer edges removed
    pub old_edges_removed: usize,
    /// Number of nodes skipped (user-modified, preserved)
    pub nodes_skipped: usize,
}

/// Merge infer results into graph.
/// Handles incremental re-runs: clears old source=infer nodes first.
/// Respects GUARD-1 (no code node modification) and GUARD-2 (no user node modification).
/// Note: pub(crate) — external callers should use `infer::run()` + `InferCmd` for the full pipeline.
/// Exposed internally for testing and phase-by-phase CLI usage (--phase integration).
pub(crate) fn merge_into_graph(
    graph: &mut Graph,
    result: &InferResult,
    incremental: bool,
) -> MergeStats {
    let mut stats = MergeStats::default();
    
    // Step 1: If incremental, remove old infer nodes/edges
    if incremental {
        // ORDER: Remove edges first, then nodes (edges reference node IDs)
        // Remove edges where metadata.source == "infer"
        // Remove nodes where source == "infer"
        // GUARD-2: Skip any node where source != "infer"
        // GUARD-1: Skip any node where node_type is code-layer
    }
    
    // Step 2: Add component nodes
    for node in &result.component_nodes {
        // GUARD-1 check: assert node.node_type != code types
        // Upsert semantics:
        //   - Infer-generated metadata (description, metrics, flow, size) → OVERWRITE
        //   - User-added metadata keys (not present in infer output) → PRESERVE
        //   - Implementation: merge metadata maps, infer keys win on conflict
        match graph.upsert_node(node.clone()) {
            Ok(_) => stats.components_added += 1,
            Err(e) => {
                warn!("Failed to upsert component {}: {e}", node.id);
                stats.nodes_skipped += 1;
            }
        }
    }
    
    // Step 3: Add feature nodes (same upsert semantics)
    for node in &result.feature_nodes {
        match graph.upsert_node(node.clone()) {
            Ok(_) => stats.features_added += 1,
            Err(e) => {
                warn!("Failed to upsert feature {}: {e}", node.id);
                stats.nodes_skipped += 1;
            }
        }
    }
    
    // Step 4: Add all edges (contains, depends_on)
    // Edges are fully replaced (old removed in Step 1, new added here)
    for edge in &result.edges {
        if graph.add_edge_dedup(edge.clone()) {
            stats.edges_added += 1;
        }
    }
    
    stats
}
```

**Satisfies**: GOAL-3.1 (write to graph), GOAL-3.3 (incremental), GOAL-3.4 (user override priority)

### §3.2 OutputFormatter

Formats results for display (CLI summary, dry-run YAML, JSON).

```rust
pub enum OutputFormat {
    /// Human-readable summary (default CLI output)
    Summary,
    /// Full YAML of generated nodes/edges (--dry-run)
    Yaml,
    /// JSON summary for batch/programmatic use (--format json)
    Json,
}

/// Format InferResult for display.
pub fn format_output(
    result: &InferResult,
    format: OutputFormat,
) -> String {
    match format {
        OutputFormat::Summary => {
            // "Inferred 8 components, 4 features from 142 code files"
            // "Clustering: 8 communities, codelength=3.45"
            // "Features: Auth, Data Pipeline, CLI, Core Library"
            // "Token usage: 12,345 input + 2,100 output = 14,445 total"
        },
        OutputFormat::Yaml => {
            // serde_yaml::to_string of nodes + edges
        },
        OutputFormat::Json => {
            // Stable schema for programmatic consumers:
            // {
            //   "components": N, "features": M, "edges": E,
            //   "metrics": { "codelength": f64, "num_communities": usize },
            //   "token_usage": { "input": N, "output": N, "calls": N },
            //   "component_list": [ { "id": "...", "title": "...", "size": N } ],
            //   "feature_list": [ { "id": "...", "title": "...", "components": [...] } ]
            // }
            // NOTE: This schema is a public contract. Field additions are non-breaking,
            // field removals/renames are breaking changes requiring a version bump.
        },
    }
}
```

**Satisfies**: GOAL-3.5 (dry-run), GOAL-5.4 (JSON format)

### §3.3 InferConfig & InferResult

Top-level configuration and result types.

```rust
pub struct InferConfig {
    /// Clustering configuration
    pub clustering: ClusterConfig,
    /// Labeling configuration (None = --no-llm)
    pub labeling: Option<LabelingConfig>,
    /// Inference level
    pub level: InferLevel,
    /// Output format
    pub format: OutputFormat,
    /// Dry-run mode (don't write to graph)
    pub dry_run: bool,
    /// Source directory (for auto-extract trigger)
    pub source_dir: Option<PathBuf>,
}

pub enum InferLevel {
    /// Only Infomap clustering → component layer
    Component,
    /// Clustering + LLM → component + feature layers  
    Feature,
    /// Same as Feature (alias for completeness)
    All,
}

pub struct InferResult {
    /// Component nodes (from clustering + labeling names)
    pub component_nodes: Vec<Node>,
    /// Feature nodes (from labeling)
    pub feature_nodes: Vec<Node>,
    /// All edges: component→code (contains), feature→component (contains), feature→feature (depends_on)
    pub edges: Vec<Edge>,
    /// Clustering metrics
    pub cluster_metrics: ClusterMetrics,
    /// Token usage (0 if no LLM)
    pub token_usage: TokenUsage,
}

impl InferResult {
    /// Total number of new nodes
    pub fn node_count(&self) -> usize {
        self.component_nodes.len() + self.feature_nodes.len()
    }
    
    /// Build graph Node objects with proper schema.
    /// Component: node_type="component", source="infer", metadata={title, description, flow, size}
    /// Feature: node_type="feature", source="infer", metadata={title, description, components}
    fn build_nodes(
        cluster_result: &ClusterResult,
        labeling_result: &LabelingResult,
    ) -> (Vec<Node>, Vec<Node>) {
        // Component nodes: start from cluster_result.nodes, apply labels from labeling_result
        // Feature nodes: create from labeling_result.feature_nodes
        // All nodes get source="infer"
    }
}
```

**Satisfies**: GOAL-5.3 (stable output schema)

### §3.4 Public API — `infer::run()`

The single library entry point.

```rust
/// Run the full infer pipeline: clustering → labeling → result.
///
/// Does NOT modify the input graph. Returns InferResult for caller to merge.
/// GidHub calls this directly. CLI calls this then merges.
pub fn run(
    graph: &Graph,
    config: &InferConfig,
    llm: Option<&dyn LlmClient>,
) -> Result<InferResult> {
    // Step 0: Auto-extract if needed (GOAL-5.5)
    // If graph has no code nodes AND config.source_dir is Some:
    //   Run extract, merge code layer into a temporary working Graph.
    //   The caller's original graph is NOT mutated (we work on a clone).
    //   let working_graph = if needs_extract { clone_and_extract(graph, source_dir)? } else { graph };
    
    // Step 1: Clustering (always runs)
    let cluster_result = clustering::cluster(graph, &config.clustering)?;
    
    if cluster_result.nodes.is_empty() {
        return Ok(InferResult::empty("No communities detected"));
    }
    
    // Step 2: Labeling (conditional on level + llm availability)
    let labeling_result = match config.level {
        InferLevel::Component => LabelingResult::empty(),
        InferLevel::Feature | InferLevel::All => {
            if let Some(llm) = llm {
                labeling::label(graph, &cluster_result, Some(llm), config.labeling.as_ref().unwrap_or(&Default::default()))?
            } else {
                // --no-llm or no LLM client provided
                LabelingResult::empty()
            }
        }
    };
    
    // Step 3: Build final nodes with labels applied
    let (component_nodes, feature_nodes) = InferResult::build_nodes(&cluster_result, &labeling_result);
    
    // Step 4: Collect all edges
    let mut edges = cluster_result.edges;       // component→code (contains)
    edges.extend(labeling_result.feature_component_edges); // feature→component (contains)
    edges.extend(labeling_result.feature_deps);            // feature→feature (depends_on)
    
    Ok(InferResult {
        component_nodes,
        feature_nodes,
        edges,
        cluster_metrics: cluster_result.metrics,
        token_usage: labeling_result.token_usage,
    })
}
```

**Satisfies**: GOAL-5.1 (Rust API), GOAL-4.3 (--level)

### §3.5 CLI Command — `gid infer`

```rust
/// Phases of the infer pipeline, selectable via --phase.
#[derive(Clone, ValueEnum)]
pub enum InferPhase {
    /// Run only clustering (produces ClusterResult, saved to .gid/cache/cluster.json)
    Clustering,
    /// Run only labeling (reads ClusterResult from cache, produces LabelingResult)
    Labeling,
    /// Run only graph merge (reads InferResult from cache, writes to graph)
    Integration,
}

/// CLI subcommand: gid infer [OPTIONS]
#[derive(Parser)]
pub struct InferCmd {
    /// Inference level
    #[arg(long, default_value = "all")]
    level: InferLevel,  // component | feature | all
    
    /// Run only a specific phase (skip others)
    #[arg(long)]
    phase: Option<InferPhase>,  // clustering | labeling | integration
    
    /// LLM model for labeling
    #[arg(long, default_value = "claude-sonnet-4-20250514")]
    model: String,
    
    /// Skip LLM — clustering only with auto-naming
    #[arg(long)]
    no_llm: bool,
    
    /// Preview results without writing to graph
    #[arg(long)]
    dry_run: bool,
    
    /// Output format
    #[arg(long, default_value = "summary")]
    format: OutputFormat,  // summary | yaml | json
    
    /// Max LLM tokens
    #[arg(long, default_value = "50000")]
    max_tokens: usize,
    
    /// Source directory (for auto-extract)
    #[arg(long)]
    source: Option<PathBuf>,
    
    // Clustering params
    #[arg(long)]
    hierarchical: bool,
    #[arg(long)]
    num_trials: Option<u32>,
    #[arg(long)]
    min_community_size: Option<usize>,
}

impl InferCmd {
    pub fn run(&self, graph_ctx: &mut GraphContext) -> Result<()> {
        // 1. Load graph
        let graph = graph_ctx.load()?;
        
        // 2. Build config from CLI args
        let config = self.build_config();
        
        // 3. Create LLM client (if needed)
        let llm = if self.no_llm { None } else { Some(create_llm_client(&self.model)?) };
        
        // 4. Run infer (phase-aware)
        //    --phase clustering:   run clustering only, cache ClusterResult
        //    --phase labeling:     load cached ClusterResult, run labeling, cache LabelingResult
        //    --phase integration:  load cached InferResult, merge into graph
        //    None (default):       run all phases sequentially
        let result = match self.phase {
            Some(InferPhase::Clustering) => {
                let cluster_result = clustering::cluster(&graph, &config.clustering)?;
                cache::write("cluster", &cluster_result)?;
                println!("Clustering complete: {} communities", cluster_result.nodes.len());
                return Ok(());
            }
            Some(InferPhase::Labeling) => {
                let cluster_result: ClusterResult = cache::read("cluster")?;
                let labeling_result = labeling::label(&graph, &cluster_result, llm.as_deref(), config.labeling.as_ref().unwrap_or(&Default::default()))?;
                let result = InferResult::from_phases(&cluster_result, &labeling_result);
                cache::write("infer_result", &result)?;
                result
            }
            Some(InferPhase::Integration) => {
                cache::read("infer_result")?
            }
            None => infer::run(&graph, &config, llm.as_deref())?,
        };
        
        // 5. Output
        if self.dry_run {
            println!("{}", format_output(&result, OutputFormat::Yaml));
            return Ok(());
        }
        
        // 6. Merge into graph
        let stats = merge_into_graph(&mut graph, &result, /*incremental=*/true);
        
        // 7. Save
        graph_ctx.save(&graph)?;
        
        // 8. Print summary (uses MergeStats for actual counts, not pre-computed InferResult counts)
        println!("{}", format_output(&result, self.format));
        println!("Merged: +{} components, +{} features, +{} edges ({} old nodes removed, {} skipped)",
            stats.components_added, stats.features_added, stats.edges_added, stats.old_nodes_removed, stats.nodes_skipped);
        
        Ok(())
    }
}
```

**Satisfies**: GOAL-4.1 (command), GOAL-4.2 (--model), GOAL-4.3 (--level), GOAL-3.5 (--dry-run)

### §3.6 Extract Integration

For `gid extract --infer` (GOAL-4.4):

```rust
// In extract CLI handler, after extract completes:
if args.infer {
    let config = InferConfig::default();
    let llm = create_llm_client_from_env()?;
    let result = infer::run(&graph, &config, llm.as_deref())?;
    merge_into_graph(&mut graph, &result, true);
}
```

For auto-extract in `infer::run()` (GOAL-5.5):

```rust
// At the start of infer::run():
if graph.code_nodes().is_empty() {
    if let Some(source_dir) = &config.source_dir {
        // Auto-run extract
        let code_graph = extract::extract_from_dir(source_dir)?;
        // Merge code layer into a working graph copy
        // Then proceed with clustering
    } else {
        return Err(anyhow!("No code layer in graph. Run `gid extract` first or pass --source <dir>"));
    }
}
```

**Satisfies**: GOAL-4.4 (extract --infer), GOAL-5.5 (auto-extract)

---

## §4 Data Flow — Full Pipeline

```
User runs: gid infer --level all --model claude-sonnet-4-20250514

Step 0: Load graph from graph.yml or SQLite (GraphContext)
  → If no code nodes + --source given → auto-extract → merge code layer

Step 1: infer::run(graph, config, llm)
  │
  ├─ clustering::cluster(graph, cluster_config)
  │    → Network with weighted edges
  │    → Infomap → communities
  │    → ClusterResult { component nodes, contains edges, metrics }
  │
  ├─ labeling::label(graph, cluster_result, llm, labeling_config)
  │    → LLM names components (batched)
  │    → LLM groups into features
  │    → Algorithmic feature dependency inference
  │    → LabelingResult { labels, features, deps, edges }
  │
  └─ InferResult::build_nodes(cluster, labeling)
       → Final component nodes (with LLM names applied)
       → Final feature nodes
       → All edges collected

Step 2: merge_into_graph(graph, result, incremental=true)
  → Remove old source=infer nodes/edges
  → Add new component/feature nodes
  → Add new edges (contains, depends_on)
  → MergeStats

Step 3: graph_ctx.save(graph)
  → Write to graph.yml or SQLite

Step 4: Print summary
  → "Inferred 8 components, 4 features from 142 code files"
```

---

## §5 Guard Implementation

### GUARD-1: Never modify code layer nodes

- `infer::run()` takes `&Graph` (immutable)
- `merge_into_graph()` only adds new nodes (source=infer) and removes old infer nodes
- Code-layer node types checked: `file`, `class`, `function`, `module`, `constant`, `interface`, `enum`, `type_alias`, `trait`
- If a node has any of these types, merger skips it unconditionally

### GUARD-2: Never modify user-created nodes

- `merge_into_graph()` only removes nodes where `source == "infer"`
- Nodes without `source` field or with any other source value are untouched
- Before removing, double-check: `node.source.as_deref() == Some("infer")`

### GUARD-4: Token budget

- Tracked in `labeling::label()` via `TokenBudget`
- `merge_into_graph()` is unaffected (no LLM)
- Budget overflow → truncate context, then skip feature inference, then warn

---

## §6 Configuration

### §6.1 Full .gid/config.yml

```yaml
infer:
  clustering:
    teleportation_rate: 0.15
    num_trials: 5
    min_community_size: 2
    hierarchical: false
    seed: 42
  labeling:
    model: "claude-sonnet-4-20250514"
    naming_batch_size: 10
    max_total_tokens: 50000
  level: all          # component | feature | all
  auto_extract: true  # trigger extract if code layer missing
```

### §6.2 Environment Variables (GOAL-5.4)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for labeling |
| `OPENAI_API_KEY` | OpenAI API key (if model is gpt-*) |
| `GID_INFER_MODEL` | Override default model |
| `GID_INFER_MAX_TOKENS` | Override token budget |

CLI args > env vars > config file > defaults.

---

## §7 Testing Strategy

### §7.1 Unit Tests

| Test | What | GOAL |
|------|------|------|
| `test_merge_adds_nodes` | Merge result into empty graph → nodes added | 3.1 |
| `test_merge_preserves_existing` | Merge into graph with manual tasks → tasks preserved | 3.1, GUARD-2 |
| `test_merge_incremental_clears_old` | Two merges → old infer nodes removed, new added | 3.3 |
| `test_merge_skips_code_nodes` | Guard: merger never touches code-layer nodes | GUARD-1 |
| `test_merge_skips_user_nodes` | Guard: source != "infer" nodes untouched | 3.4, GUARD-2 |
| `test_format_summary` | Summary output has component/feature counts | 4.1 |
| `test_format_yaml` | Dry-run YAML is valid and parseable | 3.5 |
| `test_format_json` | JSON output is valid | 5.4 |
| `test_schema_component` | Component node has required fields | 5.3 |
| `test_schema_feature` | Feature node has required fields | 5.3 |
| `test_level_component_only` | level=component → no features | 4.3 |
| `test_level_feature_auto_chains` | level=feature with no components → runs clustering first | 4.3 |
| `test_auto_extract_trigger` | Empty code layer + source dir → extract runs | 5.5 |
| `test_auto_extract_no_source` | Empty code layer + no source → error message | 5.5 |

### §7.2 Integration Tests

| Test | What |
|------|------|
| `test_full_pipeline_yaml` | extract → infer → verify graph.yml has 3 layers |
| `test_full_pipeline_sqlite` | Same but with SqliteStorage backend |
| `test_idempotent_rerun` | Run infer twice → same result, no duplicates |
| `test_batch_mode_error_isolation` | One repo fails → others succeed |
| `test_gid_rs_self_infer` | Run infer on gid-rs codebase → sanity check |

### §7.3 Performance Targets (FINDING-7)

| Scenario | Target | Measurement |
|----------|--------|-------------|
| Component only, 100 files | < 1s | clustering + merge |
| Component only, 500 files | < 5s | clustering + merge |
| Full pipeline, 100 files | < 30s | including 2 LLM calls |
| Full pipeline, 500 files | < 60s | including batched LLM calls |

LLM latency dominates. Clustering is O(E·log(N)) via Infomap, negligible for code graphs.
