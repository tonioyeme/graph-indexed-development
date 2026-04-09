# Design: `infer-clustering` — Infomap Code→Component Mapping

## §1 Overview

### §1.1 Goals

Transform code-layer graph (files, classes, functions, edges) into component-layer nodes using Infomap community detection. Pure algorithm — no LLM, deterministic with seed.

**Covers**: GOAL-1.1 through GOAL-1.5

### §1.2 Non-Goals

- LLM-based naming (see `infer-labeling`)
- Writing results to graph storage (see `infer-integration`)
- Feature-layer inference

### §1.3 Trade-offs

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Weight scheme | 4-tier fixed | Learned/adaptive | Fixed is deterministic, reproducible, debuggable. Adaptive adds complexity with uncertain benefit. |
| Node granularity | File-level clustering | Function-level | File-level matches user mental model. Function-level produces too many tiny communities. |
| Hierarchy | Optional, off by default | Always on | Most projects (50-200 files) don't benefit from hierarchy. Large projects opt in. |
| API style | Pure function returning result | Mutate graph in place | Pure is testable, composable, caller decides when to merge. |

---

## §2 Architecture

### §2.1 Data Flow

```
Graph (code layer)
  │
  ├─ §3.1 NetworkBuilder
  │    └─ filters code nodes + edges
  │    └─ applies weight mapping
  │    └─ outputs: infomap_rs::Network
  │
  ├─ §3.2 ClusterEngine
  │    └─ runs Infomap (flat or hierarchical)
  │    └─ outputs: Vec<RawCluster>
  │
  └─ §3.3 ComponentMapper
       └─ maps clusters → component Node + belongs_to/contains Edge
       └─ outputs: ClusterResult { nodes, edges, metrics }
```

### §2.2 Relationship to Existing Code

`advise.rs::detect_code_modules()` already implements a basic version of this pipeline. Differences:

| Aspect | detect_code_modules() | infer-clustering |
|--------|----------------------|------------------|
| Edge weights | Uniform 1.0 | 4-tier (calls=1.0, imports=0.8, type=0.5, structural=0.2) |
| Hierarchy | Always flat | Configurable |
| Output | `Vec<DetectedModule>` (info only) | `ClusterResult` with component Nodes + Edges |
| Node scope | File nodes only | File nodes (with sub-node → file mapping) |
| Quality metrics | None | Codelength + community count |

**Strategy**: Extract shared network-building logic into `infer/network.rs`. `detect_code_modules()` calls the same builder with default weights. No code duplication.

---

## §3 Components

### §3.1 NetworkBuilder

Converts code-layer graph into an `infomap_rs::Network`.

```rust
/// Edge weight mapping by relation type
pub const WEIGHT_CALLS: f64 = 1.0;
pub const WEIGHT_IMPORTS: f64 = 0.8;
pub const WEIGHT_TYPE_REF: f64 = 0.5;  // type_reference, inherits, implements
pub const WEIGHT_STRUCTURAL: f64 = 0.2; // defined_in, contains, belongs_to

/// Build an Infomap network from code-layer edges.
/// Returns (Network, index-to-node-id mapping).
pub fn build_network(graph: &Graph) -> (Network, Vec<String>) {
    // 1. Collect file nodes: node_type == "file"
    // 2. Build node_id → index map
    // 3. Map non-file nodes (class, function) to their parent file via:
    //    - file_path metadata field
    //    - OR defined_in edge target
    // 4. For each code edge, resolve both endpoints to file indices
    //    - Look up weight from relation type
    //    - Skip self-loops (same file)
    //    - Accumulate weights: use HashMap<(usize,usize), f64> to sum weights
    //      when multiple edges connect the same file pair (e.g. calls + imports)
    // 5. Add accumulated edges to Network: net.add_edge(from, to, total_weight)
    // 6. Return (net, idx_to_node_id)
}
```

**Weight resolution**:
```rust
fn relation_weight(relation: &str) -> f64 {
    match relation {
        "calls" => WEIGHT_CALLS,
        "imports" => WEIGHT_IMPORTS,
        "type_reference" | "inherits" | "implements" | "uses" => WEIGHT_TYPE_REF,
        "defined_in" | "contains" | "belongs_to" => WEIGHT_STRUCTURAL,
        "depends_on" => 0.4, // project-level dependency — weaker than code coupling but meaningful
        _ => 0.0, // unknown relations ignored
    }
}
```

**Satisfies**: GOAL-1.1 (network construction with weighted edges)

### §3.2 Configuration Types

```rust
pub struct ClusterConfig {
    /// Infomap teleportation rate (default: 0.15)
    pub teleportation_rate: f64,
    /// Number of optimization trials (default: 5)
    pub num_trials: u32,
    /// Minimum community size — communities smaller than this are merged into nearest neighbor (default: 2)
    pub min_community_size: usize,
    /// Enable hierarchical decomposition (default: false)
    pub hierarchical: bool,
    /// Random seed for reproducibility (default: 42)
    pub seed: u64,
}

impl Default for ClusterConfig {
    fn default() -> Self {
        Self {
            teleportation_rate: 0.15,
            num_trials: 5,
            min_community_size: 2,
            hierarchical: false,
            seed: 42,
        }
    }
}
```

**Satisfies**: GOAL-1.4 (configurable parameters)

### §3.3 ClusterEngine

Runs Infomap and produces raw cluster results.

```rust
pub struct RawCluster {
    /// Cluster index (0-based)
    pub id: usize,
    /// Node IDs (file node IDs) belonging to this cluster
    pub member_ids: Vec<String>,
    /// Flow proportion from Infomap
    pub flow: f64,
    /// Parent cluster ID (None for top-level)
    pub parent: Option<usize>,
    /// Child cluster IDs (empty for leaf clusters)
    pub children: Vec<usize>,
}

pub struct ClusterMetrics {
    /// Infomap codelength (lower = better modular structure)
    pub codelength: f64,
    /// Number of top-level communities
    pub num_communities: usize,
    /// Number of total communities (including sub-communities)
    pub num_total: usize,
}

/// Run Infomap clustering on the network.
pub fn run_clustering(
    net: &Network,
    idx_to_id: &[String],
    config: &ClusterConfig,
) -> (Vec<RawCluster>, ClusterMetrics) {
    // 1. Configure Infomap
    //    let result = Infomap::new(net)
    //        .seed(config.seed)
    //        .num_trials(config.num_trials as usize)
    //        .hierarchical(config.hierarchical)
    //        .run();
    //
    // 2. If flat (hierarchical=false):
    //    - result.modules() → one RawCluster per module
    //    - Filter out clusters < min_community_size, reassign orphans
    //
    // 3. If hierarchical:
    //    - result.tree() → traverse TreeNode hierarchy
    //    - Top-level children = top-level clusters
    //    - Recursively map sub-trees to nested RawClusters
    //    - Set parent/children relationships
    //
    // 4. Build metrics from result.codelength(), result.num_modules()
}
```

**Min-community handling**: Communities with fewer than `min_community_size` members are dissolved. Each orphaned node is assigned to the community of its strongest-connected neighbor (highest total edge weight). If no connections exist, it forms a singleton "misc" cluster.

**Satisfies**: GOAL-1.2 (community mapping), GOAL-1.3 (hierarchical), GOAL-1.5 (quality metrics)

### §3.4 ComponentMapper

Converts raw clusters into graph nodes and edges.

```rust
pub struct ClusterResult {
    /// Component nodes to add to graph
    pub nodes: Vec<Node>,
    /// Edges: component→code (contains), component→component (contains for hierarchy)
    pub edges: Vec<Edge>,
    /// Clustering quality metrics
    pub metrics: ClusterMetrics,
}

/// Map raw clusters to component nodes and edges.
pub fn map_to_components(clusters: &[RawCluster]) -> ClusterResult {
    // For each cluster:
    //   1. Create Node {
    //        id: format!("infer:component:{}", cluster.id),
    //        // For hierarchical: "infer:component:{L0}.{L1}...{LN}" (dot-separated level indices,
    //        //   e.g. `infer:component:0.1.3` for sub-component 3 under sub-community 1 of community 0)
    //        title: auto_name(&member_file_paths), // see §3.5 (caller resolves member IDs → file paths)
    //        node_type: Some("component".into()),
    //        source: Some("infer".into()),
    //        metadata: { "flow": cluster.flow, "size": cluster.member_ids.len() },
    //      }
    //
    //   2. For each member_id in cluster:
    //      Create Edge {
    //        from: component_node_id,
    //        to: member_id,
    //        relation: "contains",
    //        metadata: { "source": "infer" },
    //      }
    //
    //   3. For hierarchical clusters with parent:
    //      Create Edge {
    //        from: parent_component_id,
    //        to: child_component_id,
    //        relation: "contains",
    //        metadata: { "source": "infer" },
    //      }
}
```

**Edge direction**: Parent `contains` child. Component `contains` code-node. This is consistent with how `defined_in` edges work (parent→child in `contains` direction).

**Satisfies**: GOAL-1.2 (component nodes + edges), GOAL-1.3 (hierarchical nesting)

### §3.5 AutoNamer

Generates placeholder names for components when no LLM is available (used in `--no-llm` mode and as fallback).

```rust
/// Generate a component name from member file paths.
/// Strategy: find common directory prefix, use deepest unique directory name.
/// Example: ["src/auth/login.rs", "src/auth/session.rs"] → "auth"
/// Example: ["src/db/sqlite.rs", "src/db/migration.rs", "src/db/schema.rs"] → "db"
/// Fallback: "component-{id}" if no common prefix
/// Accepts resolved file paths (not node IDs — caller strips prefixes via file_path metadata).
pub fn auto_name(file_paths: &[&str]) -> String {
    // 1. Use file paths directly (caller resolves node ID → file_path)
    // 2. Find longest common path prefix
    // 3. Use the last path component as name
    // 4. If no common prefix (mixed directories), use most frequent directory
    // 5. Fallback: "component-{hash}"
}
```

**Satisfies**: GOAL-2.5 partially (no-LLM naming — the rest is in infer-labeling)

### §3.6 Public API — `cluster()`

The single entry point for this feature.

```rust
/// Run Infomap clustering on code-layer nodes and produce component nodes.
///
/// Returns ClusterResult with new nodes and edges. Does NOT modify the input graph.
/// Caller is responsible for merging results (see infer-integration).
pub fn cluster(graph: &Graph, config: &ClusterConfig) -> Result<ClusterResult> {
    // 1. Build network
    let (net, idx_to_id) = build_network(graph);
    
    // 2. Early return if too few nodes
    if net.num_nodes() < 2 {
        return Ok(ClusterResult::empty());
    }
    
    // 3. Run clustering
    let (raw_clusters, metrics) = run_clustering(&net, &idx_to_id, config);
    
    // 4. Map to component nodes/edges
    let mut result = map_to_components(&raw_clusters);
    result.metrics = metrics;
    
    Ok(result)
}
```

---

## §4 Data Flow — Step by Step

```
Input: Graph with code layer (nodes: file, class, function; edges: calls, imports, ...)

Step 1: NetworkBuilder.build_network(graph)
  → Scan all nodes where node_type == "file" → file_nodes[0..N]
  → Build node_id↔index bimap
  → Map non-file nodes to their parent file (via file_path or defined_in edges)
  → For each edge: resolve endpoints to file indices, apply weight, add to Network
  → Output: (Network, Vec<String> index_to_id)

Step 2: ClusterEngine.run_clustering(net, idx_to_id, config)
  → Configure Infomap with config params
  → Run optimization (num_trials iterations, best codelength wins)
  → Extract communities (flat or hierarchical)
  → Enforce min_community_size (dissolve small clusters)
  → Output: (Vec<RawCluster>, ClusterMetrics)

Step 3: ComponentMapper.map_to_components(clusters)
  → For each cluster → Node { id: "infer:component:{N}", node_type: "component", source: "infer" }
  → For each member → Edge { from: component, to: code_node, relation: "contains" }
  → For hierarchical parent/child → Edge { from: parent_component, to: child_component, relation: "contains" }
  → Auto-name each component from member file paths
  → Output: ClusterResult { nodes, edges, metrics }

Output: ClusterResult ready for infer-integration to merge into graph
```

---

## §5 Guard Implementation

### GUARD-1: Never modify code layer nodes

**Enforcement**: `cluster()` takes `&Graph` (immutable reference). It returns `ClusterResult` with NEW nodes/edges only. The function physically cannot modify the input graph.

The merge logic (in `infer-integration`) is responsible for the actual `add_node` / `add_edge_dedup` calls, and must skip any node where `node_type` is a code type (file, class, function, etc.).

---

## §6 Configuration

### §6.1 ClusterConfig Defaults

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| teleportation_rate | 0.15 | 0.0-1.0 | Standard Infomap default. Higher = less modular. |
| num_trials | 5 | 1-100 | More trials = better but slower. 5 is good for <500 files. |
| min_community_size | 2 | 1-∞ | 1 = allow singletons. 2+ = merge tiny clusters. |
| hierarchical | false | bool | Enable for 200+ file projects. |
| seed | 42 | u64 | Deterministic results. |

### §6.2 .gid/config.yml Integration

```yaml
infer:
  clustering:
    teleportation_rate: 0.15
    num_trials: 5
    min_community_size: 2
    hierarchical: false
    seed: 42
```

CLI overrides config file. Config file overrides defaults.

---

## §7 Testing Strategy

### §7.1 Unit Tests

| Test | What | GOAL |
|------|------|------|
| `test_relation_weight` | Weight mapping for all relation types | 1.1 |
| `test_build_network_basic` | 3 files with imports → Network has correct edges | 1.1 |
| `test_build_network_weight_differentiation` | calls edge gets 1.0, structural gets 0.2 | 1.1 |
| `test_build_network_skips_self_loops` | Edges within same file are excluded | 1.1 |
| `test_build_network_maps_functions_to_files` | Function→function call edge resolves to file→file | 1.1 |
| `test_cluster_two_communities` | Two disconnected clusters → 2 components | 1.2 |
| `test_cluster_single_community` | All connected → 1 component | 1.2 |
| `test_cluster_empty_graph` | No code nodes → empty result | 1.2 |
| `test_cluster_min_community_size` | Small cluster dissolved, members reassigned | 1.4 |
| `test_cluster_hierarchical` | Large graph → nested components with contains edges | 1.3 |
| `test_auto_name_common_prefix` | Files in same dir → dir name | — |
| `test_auto_name_mixed_dirs` | Files in different dirs → most frequent dir | — |
| `test_component_node_schema` | Generated nodes have correct type, source, metadata | 1.2 |
| `test_contains_edge_direction` | Component→code edges go parent→child | 1.2 |
| `test_metrics_output` | Codelength and community count present | 1.5 |
| `test_deterministic_with_seed` | Same input + same seed → same output | 1.4 |
| `test_guard1_input_immutable` | cluster() takes &Graph, cannot modify (compile-time) | GUARD-1 |

### §7.2 Integration Tests

| Test | What |
|------|------|
| `test_real_project_clustering` | Run on gid-rs's own code graph, verify 3-15 communities |
| `test_advise_uses_shared_builder` | After refactor, `detect_code_modules()` produces same results |

---

## §8 Migration from detect_code_modules()

After implementing `infer::clustering`, refactor `advise.rs::detect_code_modules()` to call `build_network()` with uniform weights (1.0 for all coupling relations). This preserves existing behavior while sharing the network-building code.

```rust
// advise.rs — after refactor
// Note: passes a custom weight fn that maps ALL coupling relations to 1.0
// (preserving original uniform-weight behavior, unlike infer's 4-tier weights)
pub fn detect_code_modules(graph: &Graph) -> Vec<DetectedModule> {
    let config = ClusterConfig::default();
    let result = infer::clustering::cluster(graph, &config)?;
    // Convert ClusterResult back to Vec<DetectedModule> for backward compat
    result.to_detected_modules()
}
```

This is a backward-compatible change. `detect_code_modules()` keeps its existing signature and return type.
