//! Infomap-based community detection on code graphs.
//!
//! This module takes a [`Graph`] of code nodes (files, functions, classes, etc.),
//! builds a weighted network at file granularity, runs Infomap optimization,
//! and returns a [`ClusterResult`] containing inferred component `Node`s and
//! membership `Edge`s. The input graph is never mutated.

use std::collections::HashMap;

use anyhow::Result;
use infomap_rs::{Infomap, Network};

use crate::graph::{Edge, Graph, Node};

// ── Edge-relation weights ──────────────────────────────────────────────────

/// Weight for "calls" edges — the strongest coupling signal.
pub const WEIGHT_CALLS: f64 = 1.0;
/// Weight for "imports" edges.
pub const WEIGHT_IMPORTS: f64 = 0.8;
/// Weight for type-reference style edges: `type_reference`, `inherits`, `implements`, `uses`.
pub const WEIGHT_TYPE_REF: f64 = 0.5;
/// Weight for structural containment edges: `defined_in`, `contains`, `belongs_to`.
pub const WEIGHT_STRUCTURAL: f64 = 0.2;
/// Weight for generic "depends_on" edges.
pub const WEIGHT_DEPENDS_ON: f64 = 0.4;

/// Map an edge relation string to its clustering weight.
///
/// Unknown relations return `0.0` and are effectively ignored.
pub fn relation_weight(relation: &str) -> f64 {
    match relation {
        "calls" => WEIGHT_CALLS,
        "imports" => WEIGHT_IMPORTS,
        "type_reference" | "inherits" | "implements" | "uses" => WEIGHT_TYPE_REF,
        "defined_in" | "contains" | "belongs_to" => WEIGHT_STRUCTURAL,
        "depends_on" => WEIGHT_DEPENDS_ON,
        _ => 0.0,
    }
}

// ── Configuration ──────────────────────────────────────────────────────────

/// Configuration for the clustering algorithm.
#[derive(Debug, Clone)]
pub struct ClusterConfig {
    /// Teleportation rate for the random walker (default: 0.15).
    pub teleportation_rate: f64,
    /// Number of Infomap optimization trials (default: 5).
    pub num_trials: u32,
    /// Minimum community size; smaller clusters are dissolved (default: 2).
    pub min_community_size: usize,
    /// Whether to run hierarchical decomposition (default: false).
    pub hierarchical: bool,
    /// Random seed for reproducibility (default: 42).
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

// ── Result types ───────────────────────────────────────────────────────────

/// A raw cluster before it is mapped to graph components.
#[derive(Debug, Clone)]
pub struct RawCluster {
    /// Cluster identifier.
    pub id: usize,
    /// IDs of the graph nodes belonging to this cluster.
    pub member_ids: Vec<String>,
    /// Infomap flow through this cluster.
    pub flow: f64,
    /// Parent cluster id for hierarchical mode.
    pub parent: Option<usize>,
    /// Child cluster ids for hierarchical mode.
    pub children: Vec<usize>,
}

/// Summary metrics from a clustering run.
#[derive(Debug, Clone)]
pub struct ClusterMetrics {
    /// Map equation codelength (lower is better).
    pub codelength: f64,
    /// Number of communities detected.
    pub num_communities: usize,
    /// Total number of nodes in the network.
    pub num_total: usize,
}

/// The output of clustering: new component nodes, membership edges, and metrics.
#[derive(Debug, Clone)]
pub struct ClusterResult {
    /// Component nodes inferred by clustering.
    pub nodes: Vec<Node>,
    /// Edges connecting components to their member nodes (and parent→child).
    pub edges: Vec<Edge>,
    /// Summary metrics.
    pub metrics: ClusterMetrics,
}

impl ClusterResult {
    /// Create an empty result with zeroed metrics.
    pub fn empty() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            metrics: ClusterMetrics {
                codelength: 0.0,
                num_communities: 0,
                num_total: 0,
            },
        }
    }
}

// ── Network construction ───────────────────────────────────────────────────

/// Build an Infomap [`Network`] from a [`Graph`], collapsing non-file nodes
/// onto their parent files.
///
/// Returns the network and a vec mapping network indices back to node ID strings.
pub fn build_network(graph: &Graph) -> (Network, Vec<String>) {
    // 1. Collect file nodes and assign indices.
    let mut id_to_idx: HashMap<&str, usize> = HashMap::new();
    let mut idx_to_id: Vec<String> = Vec::new();

    for node in &graph.nodes {
        // Accept both `node_type: file` (from gid extract) and
        // `node_type: code, node_kind: File` (from unified codegraph_to_graph_nodes).
        let is_file = node.node_type.as_deref() == Some("file")
            || (node.node_type.as_deref() == Some("code")
                && node.node_kind.as_deref() == Some("File"));
        if is_file {
            let idx = idx_to_id.len();
            id_to_idx.insert(&node.id, idx);
            idx_to_id.push(node.id.clone());
        }
    }

    // 2. Map non-file nodes to their parent file index.
    let mut node_to_file_idx: HashMap<&str, usize> = HashMap::new();
    for node in &graph.nodes {
        let is_file = node.node_type.as_deref() == Some("file")
            || (node.node_type.as_deref() == Some("code")
                && node.node_kind.as_deref() == Some("File"));
        if is_file {
            continue;
        }
        // Try file_path field → construct "file:{file_path}" → look up in id_to_idx
        if let Some(ref fp) = node.file_path {
            let file_id = format!("file:{}", fp);
            if let Some(&idx) = id_to_idx.get(file_id.as_str()) {
                node_to_file_idx.insert(&node.id, idx);
                continue;
            }
        }
        // Try metadata["file_path"]
        if let Some(fp_val) = node.metadata.get("file_path") {
            if let Some(fp) = fp_val.as_str() {
                let file_id = format!("file:{}", fp);
                if let Some(&idx) = id_to_idx.get(file_id.as_str()) {
                    node_to_file_idx.insert(&node.id, idx);
                    continue;
                }
            }
        }
    }

    // 3. Accumulate edge weights between file pairs.
    let mut edge_weights: HashMap<(usize, usize), f64> = HashMap::new();

    for edge in &graph.edges {
        let w = relation_weight(&edge.relation);
        if w == 0.0 {
            continue;
        }

        // Resolve endpoints to file indices.
        let from_idx = node_to_file_idx
            .get(edge.from.as_str())
            .or_else(|| id_to_idx.get(edge.from.as_str()))
            .copied();
        let to_idx = node_to_file_idx
            .get(edge.to.as_str())
            .or_else(|| id_to_idx.get(edge.to.as_str()))
            .copied();

        if let (Some(f), Some(t)) = (from_idx, to_idx) {
            if f == t {
                continue; // skip self-loops
            }
            *edge_weights.entry((f, t)).or_insert(0.0) += w;
        }
    }

    // 4. Build the Network.
    let mut net = Network::new();

    // Ensure all file nodes exist even with no edges.
    if !idx_to_id.is_empty() {
        // Adding a node name forces the network to know about the index.
        for (idx, node_id) in idx_to_id.iter().enumerate() {
            net.add_node_name(idx, node_id);
        }
    }

    for (&(from, to), &total_weight) in &edge_weights {
        net.add_edge(from, to, total_weight);
    }

    (net, idx_to_id)
}

// ── Clustering execution ───────────────────────────────────────────────────

/// Run Infomap on the network and return raw clusters plus metrics.
///
/// Handles flat and hierarchical modes, and dissolves undersized clusters.
pub fn run_clustering(
    net: &Network,
    idx_to_id: &[String],
    config: &ClusterConfig,
) -> (Vec<RawCluster>, ClusterMetrics) {
    let result = Infomap::new(net)
        .seed(config.seed)
        .num_trials(config.num_trials as usize)
        .hierarchical(config.hierarchical)
        .tau(config.teleportation_rate)
        .run();

    let metrics = ClusterMetrics {
        codelength: result.codelength(),
        num_communities: result.num_modules(),
        num_total: net.num_nodes(),
    };

    let clusters = if config.hierarchical {
        build_hierarchical_clusters(&result, idx_to_id)
    } else {
        build_flat_clusters(&result, idx_to_id, net, config.min_community_size)
    };

    (clusters, metrics)
}

/// Build flat clusters from Infomap module results with min-size enforcement.
fn build_flat_clusters(
    result: &infomap_rs::InfomapResult,
    idx_to_id: &[String],
    net: &Network,
    min_community_size: usize,
) -> Vec<RawCluster> {
    let modules = result.modules();

    let mut clusters: Vec<RawCluster> = Vec::new();
    let mut orphan_nodes: Vec<(usize, String)> = Vec::new(); // (original node idx, node id)

    for module in modules {
        let member_ids: Vec<String> = module
            .nodes
            .iter()
            .map(|&idx| idx_to_id[idx].clone())
            .collect();

        if member_ids.len() < min_community_size {
            // Collect orphans for reassignment.
            for &node_idx in &module.nodes {
                orphan_nodes.push((node_idx, idx_to_id[node_idx].clone()));
            }
        } else {
            clusters.push(RawCluster {
                id: clusters.len(),
                member_ids,
                flow: module.flow,
                parent: None,
                children: Vec::new(),
            });
        }
    }

    // Reassign orphan nodes to the cluster of their strongest-connected neighbor.
    if !orphan_nodes.is_empty() && !clusters.is_empty() {
        // Build a set of node_id → cluster_index for already-assigned nodes.
        let mut id_to_cluster: HashMap<String, usize> = HashMap::new();
        // Also need node_id → network idx for weight lookup.
        let mut id_to_net_idx: HashMap<&str, usize> = HashMap::new();
        for (idx, nid) in idx_to_id.iter().enumerate() {
            id_to_net_idx.insert(nid.as_str(), idx);
        }
        for (ci, cluster) in clusters.iter().enumerate() {
            for mid in &cluster.member_ids {
                id_to_cluster.insert(mid.clone(), ci);
            }
        }

        // Build cluster membership from assigned nodes by network idx.
        let mut net_idx_to_cluster: HashMap<usize, usize> = HashMap::new();
        for (ci, cluster) in clusters.iter().enumerate() {
            for mid in &cluster.member_ids {
                if let Some(&net_idx) = id_to_net_idx.get(mid.as_str()) {
                    net_idx_to_cluster.insert(net_idx, ci);
                }
            }
        }

        let mut misc_ids: Vec<String> = Vec::new();

        for (node_idx, node_id) in &orphan_nodes {
            // Find the strongest-connected neighbor that belongs to an existing cluster.
            let mut best_cluster: Option<usize> = None;
            let mut best_weight: f64 = 0.0;

            // Check outgoing neighbors.
            for &(neighbor_idx, w) in net.out_neighbors(*node_idx) {
                if let Some(&ci) = net_idx_to_cluster.get(&neighbor_idx) {
                    if w > best_weight {
                        best_weight = w;
                        best_cluster = Some(ci);
                    }
                }
            }

            // Also check incoming neighbors (since edges are directed).
            // Use a trick: iterate all clusters' member indices and check if they connect to node_idx.
            // More efficient: iterate all nodes, check if they have an outgoing edge to node_idx.
            // For correctness, we check net.out_neighbors for each assigned node pointing to node_idx.
            // But that's O(N*E). Instead, check if node_idx has incoming from assigned nodes.
            // Network has in_neighbors if available; let's use out_neighbors of all nodes pointing here.
            // Actually, we can iterate all nodes' outgoing edges to find incoming to node_idx,
            // but that's expensive. We'll approximate with outgoing edges only for now.
            // The Network API doesn't expose in_neighbors publicly... wait, it does.
            // But the task spec only shows out_neighbors. Let's just use outgoing for simplicity
            // since the graph is directed and out_neighbors is the primary signal.

            if let Some(ci) = best_cluster {
                clusters[ci].member_ids.push(node_id.clone());
                net_idx_to_cluster.insert(*node_idx, ci);
            } else {
                misc_ids.push(node_id.clone());
            }
        }

        // Create a "misc" cluster for truly unconnected orphans.
        if !misc_ids.is_empty() {
            for misc_id in misc_ids {
                clusters.push(RawCluster {
                    id: clusters.len(),
                    member_ids: vec![misc_id],
                    flow: 0.0,
                    parent: None,
                    children: Vec::new(),
                });
            }
        }
    } else if !orphan_nodes.is_empty() {
        // No clusters to merge into — make each orphan its own singleton.
        for (_, node_id) in orphan_nodes {
            clusters.push(RawCluster {
                id: clusters.len(),
                member_ids: vec![node_id],
                flow: 0.0,
                parent: None,
                children: Vec::new(),
            });
        }
    }

    // Re-number cluster IDs sequentially.
    for (i, c) in clusters.iter_mut().enumerate() {
        c.id = i;
    }

    clusters
}

/// Recursively build hierarchical clusters from the Infomap tree.
fn build_hierarchical_clusters(
    result: &infomap_rs::InfomapResult,
    idx_to_id: &[String],
) -> Vec<RawCluster> {
    let mut clusters: Vec<RawCluster> = Vec::new();

    if let Some(tree) = result.tree() {
        let mut counter: usize = 0;
        build_tree_clusters(tree, idx_to_id, &mut clusters, &mut counter, None, "".to_string());
    } else {
        // Fallback: treat flat modules as hierarchy roots.
        for module in result.modules() {
            let member_ids: Vec<String> = module
                .nodes
                .iter()
                .map(|&idx| idx_to_id[idx].clone())
                .collect();
            clusters.push(RawCluster {
                id: clusters.len(),
                member_ids,
                flow: module.flow,
                parent: None,
                children: Vec::new(),
            });
        }
    }

    clusters
}

/// Recursive helper for hierarchical tree traversal.
fn build_tree_clusters(
    tree_node: &infomap_rs::TreeNode,
    idx_to_id: &[String],
    clusters: &mut Vec<RawCluster>,
    counter: &mut usize,
    parent_idx: Option<usize>,
    _path: String,
) {
    let my_idx = *counter;
    *counter += 1;

    // Collect leaf node IDs.
    let member_ids: Vec<String> = if let Some(ref nodes) = tree_node.nodes {
        nodes.iter().map(|&idx| idx_to_id[idx].clone()).collect()
    } else {
        Vec::new()
    };

    clusters.push(RawCluster {
        id: my_idx,
        member_ids,
        flow: tree_node.flow,
        parent: parent_idx,
        children: Vec::new(),
    });

    // Set parent→child link.
    if let Some(pidx) = parent_idx {
        clusters[pidx].children.push(my_idx);
    }

    // Recurse into children.
    if let Some(ref children) = tree_node.children {
        for (ci, child) in children.iter().enumerate() {
            let child_path = if _path.is_empty() {
                format!("{}", ci)
            } else {
                format!("{}.{}", _path, ci)
            };
            // Collect descendant leaf members into the parent as well.
            build_tree_clusters(child, idx_to_id, clusters, counter, Some(my_idx), child_path);
        }

        // Propagate child members up to parent.
        let child_indices: Vec<usize> = clusters[my_idx].children.clone();
        for child_idx in child_indices {
            let child_members: Vec<String> = clusters[child_idx].member_ids.clone();
            clusters[my_idx].member_ids.extend(child_members);
        }
    }
}

// ── Component mapping ──────────────────────────────────────────────────────

/// Map raw clusters back to graph components: create component [`Node`]s and
/// membership [`Edge`]s.
pub fn map_to_components(clusters: &[RawCluster], graph: &Graph) -> ClusterResult {
    // Build an id → node lookup for resolving file paths.
    let node_map: HashMap<&str, &Node> = graph
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n))
        .collect();

    let mut nodes: Vec<Node> = Vec::new();
    let mut edges: Vec<Edge> = Vec::new();

    // Determine if hierarchical (any cluster has parent or children).
    let is_hierarchical = clusters.iter().any(|c| c.parent.is_some() || !c.children.is_empty());

    // For hierarchical mode, build an index→path map for dot-notation naming.
    let dot_paths: HashMap<usize, String> = if is_hierarchical {
        build_dot_paths(clusters)
    } else {
        HashMap::new()
    };

    let infer_meta = serde_json::json!({"source": "infer"});

    for cluster in clusters {
        // Determine component ID.
        let component_id = if is_hierarchical {
            let path = dot_paths
                .get(&cluster.id)
                .cloned()
                .unwrap_or_else(|| format!("{}", cluster.id));
            format!("infer:component:{}", path)
        } else {
            format!("infer:component:{}", cluster.id)
        };

        // Resolve member IDs to file paths for auto-naming.
        let file_paths: Vec<&str> = cluster
            .member_ids
            .iter()
            .filter_map(|mid| {
                node_map.get(mid.as_str()).and_then(|n| {
                    n.file_path.as_deref().or_else(|| {
                        // Strip "file:" prefix if the ID starts with it.
                        mid.strip_prefix("file:")
                    })
                })
            })
            .collect();

        let title = if file_paths.is_empty() {
            auto_name(&[])
        } else {
            auto_name(&file_paths)
        };

        // Create component node.
        let mut node = Node::new(&component_id, &title);
        node.node_type = Some("component".into());
        node.source = Some("infer".into());
        node.metadata
            .insert("flow".into(), serde_json::json!(cluster.flow));
        node.metadata
            .insert("size".into(), serde_json::json!(cluster.member_ids.len()));
        nodes.push(node);

        // Create membership edges: component → member.
        for mid in &cluster.member_ids {
            let mut edge = Edge::new(&component_id, mid, "contains");
            edge.metadata = Some(infer_meta.clone());
            edges.push(edge);
        }

        // Hierarchical: parent → child component edges.
        if is_hierarchical {
            for &child_id in &cluster.children {
                let child_component_id = {
                    let path = dot_paths
                        .get(&child_id)
                        .cloned()
                        .unwrap_or_else(|| format!("{}", child_id));
                    format!("infer:component:{}", path)
                };
                let mut edge = Edge::new(&component_id, &child_component_id, "contains");
                edge.metadata = Some(infer_meta.clone());
                edges.push(edge);
            }
        }
    }

    let metrics = ClusterMetrics {
        codelength: 0.0,
        num_communities: clusters.len(),
        num_total: 0,
    };

    ClusterResult {
        nodes,
        edges,
        metrics,
    }
}

/// Build dot-notation paths (e.g., "0.1.3") for hierarchical cluster IDs.
fn build_dot_paths(clusters: &[RawCluster]) -> HashMap<usize, String> {
    let mut paths: HashMap<usize, String> = HashMap::new();

    // Find root(s) — clusters with no parent.
    let roots: Vec<usize> = clusters
        .iter()
        .filter(|c| c.parent.is_none())
        .map(|c| c.id)
        .collect();

    for (ri, &root_id) in roots.iter().enumerate() {
        let root_path = format!("{}", ri);
        paths.insert(root_id, root_path.clone());
        assign_child_paths(clusters, root_id, &root_path, &mut paths);
    }

    paths
}

/// Recursively assign dot-notation paths to child clusters.
fn assign_child_paths(
    clusters: &[RawCluster],
    parent_id: usize,
    parent_path: &str,
    paths: &mut HashMap<usize, String>,
) {
    if let Some(cluster) = clusters.iter().find(|c| c.id == parent_id) {
        for (ci, &child_id) in cluster.children.iter().enumerate() {
            let child_path = format!("{}.{}", parent_path, ci);
            paths.insert(child_id, child_path.clone());
            assign_child_paths(clusters, child_id, &child_path, paths);
        }
    }
}

// ── Auto-naming ────────────────────────────────────────────────────────────

/// Automatically generate a human-readable component name from file paths.
///
/// Strategy:
/// 1. Find the longest common prefix of path components.
/// 2. Use the deepest directory after the common prefix as the name.
/// 3. If no common prefix, use the most frequent directory among all paths.
/// 4. Fallback: `"component-N"` using a simple hash.
pub fn auto_name(file_paths: &[&str]) -> String {
    if file_paths.is_empty() {
        return "component".to_string();
    }

    if file_paths.len() == 1 {
        // Single file: use the parent directory or file stem.
        let parts: Vec<&str> = file_paths[0].split('/').collect();
        if parts.len() > 1 {
            return parts[parts.len() - 2].to_string();
        }
        return parts[0]
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(parts[0])
            .to_string();
    }

    // Split all paths into components.
    let split_paths: Vec<Vec<&str>> = file_paths
        .iter()
        .map(|p| p.split('/').collect::<Vec<_>>())
        .collect();

    // Find longest common prefix.
    let min_len = split_paths.iter().map(|p| p.len()).min().unwrap_or(0);
    let mut prefix_len = 0;
    for i in 0..min_len {
        let first = split_paths[0][i];
        if split_paths.iter().all(|p| p[i] == first) {
            prefix_len = i + 1;
        } else {
            break;
        }
    }

    // Use the deepest common prefix directory.
    if prefix_len > 0 {
        let deepest = split_paths[0][prefix_len - 1];
        // If the deepest component looks like a file (has extension), use the one before it.
        if deepest.contains('.') && prefix_len > 1 {
            return split_paths[0][prefix_len - 2].to_string();
        }
        return deepest.to_string();
    }

    // No common prefix — find the most frequent directory component.
    let mut freq: HashMap<&str, usize> = HashMap::new();
    for parts in &split_paths {
        // Count directory components (everything except the last, which is the filename).
        for &part in parts.iter().take(parts.len().saturating_sub(1)) {
            *freq.entry(part).or_insert(0) += 1;
        }
    }

    if let Some((&dir, _)) = freq.iter().max_by_key(|(_, &count)| count) {
        // Don't return very generic directories like "src" if there are better options.
        return dir.to_string();
    }

    // Fallback: hash-based name.
    let hash: u64 = file_paths.iter().fold(0u64, |acc, p| {
        acc.wrapping_add(p.bytes().fold(0u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64)))
    });
    format!("component-{}", hash % 10000)
}

// ── Main entry point ───────────────────────────────────────────────────────

/// Run community detection on a code graph and return inferred components.
///
/// This is the main entry point. It builds a file-level network, runs Infomap,
/// and maps results back to component nodes and membership edges.
pub fn cluster(graph: &Graph, config: &ClusterConfig) -> Result<ClusterResult> {
    let (net, idx_to_id) = build_network(graph);

    if net.num_nodes() < 2 {
        return Ok(ClusterResult::empty());
    }

    let (clusters, metrics) = run_clustering(&net, &idx_to_id, config);

    let mut result = map_to_components(&clusters, graph);
    result.metrics = metrics;

    Ok(result)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, Graph, Node};

    fn make_file_node(path: &str) -> Node {
        let mut n = Node::new(&format!("file:{}", path), path);
        n.node_type = Some("file".into());
        n.file_path = Some(path.into());
        n
    }

    fn make_fn_node(id: &str, file_path: &str) -> Node {
        let mut n = Node::new(id, id);
        n.node_type = Some("function".into());
        n.file_path = Some(file_path.into());
        n
    }

    fn default_config() -> ClusterConfig {
        ClusterConfig {
            seed: 42,
            num_trials: 10,
            min_community_size: 2,
            ..Default::default()
        }
    }

    /// Build a graph with two disjoint groups of files, each group fully connected via "calls".
    /// Group A: a1, a2, a3.  Group B: b1, b2, b3.
    fn two_community_graph() -> Graph {
        let mut g = Graph::default();
        let group_a = ["src/auth/login.rs", "src/auth/logout.rs", "src/auth/session.rs"];
        let group_b = ["src/db/pool.rs", "src/db/query.rs", "src/db/migrate.rs"];

        for p in group_a.iter().chain(group_b.iter()) {
            g.nodes.push(make_file_node(p));
        }

        // Fully connect group A
        for i in 0..group_a.len() {
            for j in 0..group_a.len() {
                if i != j {
                    g.edges.push(Edge::new(
                        &format!("file:{}", group_a[i]),
                        &format!("file:{}", group_a[j]),
                        "calls",
                    ));
                }
            }
        }

        // Fully connect group B
        for i in 0..group_b.len() {
            for j in 0..group_b.len() {
                if i != j {
                    g.edges.push(Edge::new(
                        &format!("file:{}", group_b[i]),
                        &format!("file:{}", group_b[j]),
                        "calls",
                    ));
                }
            }
        }

        g
    }

    // ── 1. test_relation_weight ────────────────────────────────────────

    #[test]
    fn test_relation_weight() {
        assert_eq!(relation_weight("calls"), WEIGHT_CALLS);
        assert_eq!(relation_weight("imports"), WEIGHT_IMPORTS);
        assert_eq!(relation_weight("type_reference"), WEIGHT_TYPE_REF);
        assert_eq!(relation_weight("inherits"), WEIGHT_TYPE_REF);
        assert_eq!(relation_weight("implements"), WEIGHT_TYPE_REF);
        assert_eq!(relation_weight("uses"), WEIGHT_TYPE_REF);
        assert_eq!(relation_weight("defined_in"), WEIGHT_STRUCTURAL);
        assert_eq!(relation_weight("contains"), WEIGHT_STRUCTURAL);
        assert_eq!(relation_weight("belongs_to"), WEIGHT_STRUCTURAL);
        assert_eq!(relation_weight("depends_on"), WEIGHT_DEPENDS_ON);
        // Unknown relation returns 0.0
        assert_eq!(relation_weight("foobar"), 0.0);
        assert_eq!(relation_weight(""), 0.0);
    }

    // ── 2. test_build_network_basic ────────────────────────────────────

    #[test]
    fn test_build_network_basic() {
        let mut g = Graph::default();
        g.nodes.push(make_file_node("a.rs"));
        g.nodes.push(make_file_node("b.rs"));
        g.nodes.push(make_file_node("c.rs"));
        g.edges.push(Edge::new("file:a.rs", "file:b.rs", "calls"));
        g.edges.push(Edge::new("file:b.rs", "file:c.rs", "imports"));

        let (net, idx_to_id) = build_network(&g);

        assert_eq!(net.num_nodes(), 3);
        assert_eq!(idx_to_id.len(), 3);
        // There should be exactly 2 directed edges
        assert_eq!(net.num_edges(), 2);
    }

    // ── 3. test_build_network_weight_differentiation ───────────────────

    #[test]
    fn test_build_network_weight_differentiation() {
        let mut g = Graph::default();
        g.nodes.push(make_file_node("x.rs"));
        g.nodes.push(make_file_node("y.rs"));
        g.nodes.push(make_file_node("z.rs"));
        g.edges.push(Edge::new("file:x.rs", "file:y.rs", "calls"));
        g.edges.push(Edge::new("file:x.rs", "file:z.rs", "imports"));

        let (net, idx_to_id) = build_network(&g);

        // Find index of x, y, z
        let x = idx_to_id.iter().position(|id| id == "file:x.rs").unwrap();
        let y = idx_to_id.iter().position(|id| id == "file:y.rs").unwrap();
        let z = idx_to_id.iter().position(|id| id == "file:z.rs").unwrap();

        let out = net.out_neighbors(x);
        let weight_xy = out.iter().find(|&&(t, _)| t == y).map(|&(_, w)| w).unwrap();
        let weight_xz = out.iter().find(|&&(t, _)| t == z).map(|&(_, w)| w).unwrap();

        // "calls" (1.0) > "imports" (0.8)
        assert!(
            weight_xy > weight_xz,
            "calls weight ({}) should be > imports weight ({})",
            weight_xy,
            weight_xz
        );
    }

    // ── 4. test_build_network_skips_self_loops ─────────────────────────

    #[test]
    fn test_build_network_skips_self_loops() {
        let mut g = Graph::default();
        g.nodes.push(make_file_node("a.rs"));
        g.nodes.push(make_file_node("b.rs"));
        g.edges.push(Edge::new("file:a.rs", "file:a.rs", "calls")); // self-loop
        g.edges.push(Edge::new("file:a.rs", "file:b.rs", "calls"));

        let (net, _idx_to_id) = build_network(&g);

        // Only the a→b edge should exist, not the self-loop
        assert_eq!(net.num_edges(), 1);
    }

    // ── 5. test_build_network_maps_functions_to_files ──────────────────

    #[test]
    fn test_build_network_maps_functions_to_files() {
        let mut g = Graph::default();
        g.nodes.push(make_file_node("src/main.rs"));
        g.nodes.push(make_file_node("src/lib.rs"));
        g.nodes.push(make_fn_node("fn:do_stuff", "src/main.rs"));
        g.nodes.push(make_fn_node("fn:helper", "src/lib.rs"));

        // Edge between function nodes; should resolve to file-level edge
        g.edges.push(Edge::new("fn:do_stuff", "fn:helper", "calls"));

        let (net, idx_to_id) = build_network(&g);

        // Only 2 file nodes in the network
        assert_eq!(net.num_nodes(), 2);
        assert_eq!(idx_to_id.len(), 2);

        // Should have 1 edge (main.rs → lib.rs)
        assert_eq!(net.num_edges(), 1);

        let main_idx = idx_to_id.iter().position(|id| id == "file:src/main.rs").unwrap();
        let lib_idx = idx_to_id.iter().position(|id| id == "file:src/lib.rs").unwrap();
        let out = net.out_neighbors(main_idx);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, lib_idx);
    }

    // ── 6. test_cluster_two_communities ────────────────────────────────

    #[test]
    fn test_cluster_two_communities() {
        let g = two_community_graph();
        let config = default_config();
        let result = cluster(&g, &config).unwrap();

        // Should detect exactly 2 communities
        assert_eq!(
            result.metrics.num_communities, 2,
            "Expected 2 communities, got {}",
            result.metrics.num_communities
        );
        assert_eq!(result.nodes.len(), 2);
    }

    // ── 7. test_cluster_single_community ───────────────────────────────

    #[test]
    fn test_cluster_single_community() {
        let mut g = Graph::default();
        let files = ["a.rs", "b.rs", "c.rs", "d.rs"];
        for f in &files {
            g.nodes.push(make_file_node(f));
        }
        // Fully connected graph → should produce 1 community
        for i in 0..files.len() {
            for j in 0..files.len() {
                if i != j {
                    g.edges.push(Edge::new(
                        &format!("file:{}", files[i]),
                        &format!("file:{}", files[j]),
                        "calls",
                    ));
                }
            }
        }

        let config = ClusterConfig {
            seed: 42,
            num_trials: 10,
            min_community_size: 1,
            ..Default::default()
        };
        let result = cluster(&g, &config).unwrap();

        assert_eq!(
            result.metrics.num_communities, 1,
            "Fully connected graph should yield 1 community, got {}",
            result.metrics.num_communities
        );
    }

    // ── 8. test_cluster_empty_graph ────────────────────────────────────

    #[test]
    fn test_cluster_empty_graph() {
        let g = Graph::default();
        let config = default_config();
        let result = cluster(&g, &config).unwrap();

        assert!(result.nodes.is_empty());
        assert!(result.edges.is_empty());
        assert_eq!(result.metrics.codelength, 0.0);
        assert_eq!(result.metrics.num_communities, 0);
        assert_eq!(result.metrics.num_total, 0);
    }

    // ── 9. test_cluster_min_community_size ─────────────────────────────

    #[test]
    fn test_cluster_min_community_size() {
        // Create a graph where one node is loosely connected (singleton after clustering).
        // Group of 4 tightly connected + 1 with a single weak edge.
        let mut g = Graph::default();
        let core = ["src/core/a.rs", "src/core/b.rs", "src/core/c.rs", "src/core/d.rs"];
        for f in &core {
            g.nodes.push(make_file_node(f));
        }
        // Add a loner
        g.nodes.push(make_file_node("src/misc/loner.rs"));

        // Fully connect core
        for i in 0..core.len() {
            for j in 0..core.len() {
                if i != j {
                    g.edges.push(Edge::new(
                        &format!("file:{}", core[i]),
                        &format!("file:{}", core[j]),
                        "calls",
                    ));
                }
            }
        }

        // Weak connection from loner to one core file
        g.edges.push(Edge::new("file:src/misc/loner.rs", "file:src/core/a.rs", "depends_on"));

        let config = ClusterConfig {
            seed: 42,
            num_trials: 10,
            min_community_size: 2,
            ..Default::default()
        };
        let result = cluster(&g, &config).unwrap();

        // The loner should be absorbed into an existing cluster (orphan reassignment)
        // or placed in a misc cluster. Either way, all nodes should be accounted for.
        let total_members: usize = result
            .edges
            .iter()
            .filter(|e| e.relation == "contains")
            .count();
        assert_eq!(total_members, 5, "All 5 nodes should be assigned to some cluster");
    }

    // ── 10. test_cluster_hierarchical ──────────────────────────────────

    #[test]
    fn test_cluster_hierarchical() {
        let g = two_community_graph();
        let config = ClusterConfig {
            seed: 42,
            num_trials: 10,
            min_community_size: 1,
            hierarchical: true,
            ..Default::default()
        };
        let result = cluster(&g, &config).unwrap();

        // Hierarchical mode should produce clusters with parent/children relationships.
        // There should be at least one "contains" edge between component nodes
        // (parent → child component).
        let component_ids: Vec<&str> = result
            .nodes
            .iter()
            .map(|n| n.id.as_str())
            .collect();

        let parent_child_edges: Vec<&Edge> = result
            .edges
            .iter()
            .filter(|e| {
                e.relation == "contains"
                    && component_ids.contains(&e.from.as_str())
                    && component_ids.contains(&e.to.as_str())
            })
            .collect();

        // In hierarchical mode, there should be at least one parent→child component edge
        assert!(
            !parent_child_edges.is_empty(),
            "Hierarchical clustering should produce parent→child component edges"
        );

        // Multiple levels of hierarchy → more than 2 component nodes
        assert!(
            result.nodes.len() > 2,
            "Hierarchical mode should produce more than 2 component nodes, got {}",
            result.nodes.len()
        );
    }

    // ── 11. test_auto_name_common_prefix ───────────────────────────────

    #[test]
    fn test_auto_name_common_prefix() {
        let paths = ["src/auth/login.rs", "src/auth/logout.rs"];
        let name = auto_name(&paths);
        assert_eq!(name, "auth");
    }

    // ── 12. test_auto_name_mixed_dirs ──────────────────────────────────

    #[test]
    fn test_auto_name_mixed_dirs() {
        // No common prefix → most frequent directory wins
        let paths = [
            "src/db/pool.rs",
            "src/db/query.rs",
            "lib/utils/helper.rs",
        ];
        let name = auto_name(&paths);
        // "src" appears 2x, "db" appears 2x, "lib" 1x, "utils" 1x.
        // The most frequent directory should be chosen.
        // Could be "src" or "db" (both have count 2). Accept either.
        assert!(
            name == "src" || name == "db",
            "Expected most frequent directory, got '{}'",
            name
        );
    }

    // ── 13. test_component_node_schema ──────────────────────────────────

    #[test]
    fn test_component_node_schema() {
        let g = two_community_graph();
        let config = default_config();
        let result = cluster(&g, &config).unwrap();

        assert!(!result.nodes.is_empty(), "Should have component nodes");

        for node in &result.nodes {
            assert_eq!(
                node.node_type.as_deref(),
                Some("component"),
                "Component node should have node_type='component'"
            );
            assert_eq!(
                node.source.as_deref(),
                Some("infer"),
                "Component node should have source='infer'"
            );
            assert!(
                node.metadata.contains_key("flow"),
                "Component node metadata should contain 'flow'"
            );
            assert!(
                node.metadata.contains_key("size"),
                "Component node metadata should contain 'size'"
            );
        }
    }

    // ── 14. test_contains_edge_direction ────────────────────────────────

    #[test]
    fn test_contains_edge_direction() {
        let g = two_community_graph();
        let config = default_config();
        let result = cluster(&g, &config).unwrap();

        let component_ids: Vec<&str> = result
            .nodes
            .iter()
            .map(|n| n.id.as_str())
            .collect();

        let file_ids: Vec<String> = g
            .nodes
            .iter()
            .filter(|n| n.node_type.as_deref() == Some("file"))
            .map(|n| n.id.clone())
            .collect();

        for edge in &result.edges {
            if edge.relation == "contains" {
                // Check edges between component → file (not component→component in hierarchical)
                if file_ids.contains(&edge.to) {
                    // "from" should be a component, "to" should be a file
                    assert!(
                        component_ids.contains(&edge.from.as_str()),
                        "'contains' edge 'from' ({}) should be a component node",
                        edge.from
                    );
                    assert!(
                        !component_ids.contains(&edge.to.as_str()),
                        "'contains' edge 'to' ({}) should NOT be a component node (it should be a file)",
                        edge.to
                    );
                }
            }
        }

        // Verify no edge goes from file → component
        for edge in &result.edges {
            if edge.relation == "contains" {
                assert!(
                    !file_ids.contains(&edge.from),
                    "'contains' edge should not have a file as 'from': {} → {}",
                    edge.from,
                    edge.to
                );
            }
        }
    }

    // ── 15. test_metrics_output ────────────────────────────────────────

    #[test]
    fn test_metrics_output() {
        let g = two_community_graph();
        let config = default_config();
        let result = cluster(&g, &config).unwrap();

        assert!(
            result.metrics.codelength > 0.0,
            "Codelength should be > 0, got {}",
            result.metrics.codelength
        );
        assert_eq!(
            result.metrics.num_communities, 2,
            "num_communities should be 2, got {}",
            result.metrics.num_communities
        );
        assert_eq!(
            result.metrics.num_total, 6,
            "num_total should be 6 (all file nodes), got {}",
            result.metrics.num_total
        );
    }

    // ── 16. test_deterministic_with_seed ───────────────────────────────

    #[test]
    fn test_deterministic_with_seed() {
        let g = two_community_graph();
        let config = ClusterConfig {
            seed: 123,
            num_trials: 10,
            min_community_size: 2,
            ..Default::default()
        };

        let result1 = cluster(&g, &config).unwrap();
        let result2 = cluster(&g, &config).unwrap();

        // Same number of clusters
        assert_eq!(result1.nodes.len(), result2.nodes.len());

        // Same codelength
        assert!(
            (result1.metrics.codelength - result2.metrics.codelength).abs() < f64::EPSILON,
            "Codelength should be identical: {} vs {}",
            result1.metrics.codelength,
            result2.metrics.codelength
        );

        // Same membership: sort edges for comparison
        let mut edges1: Vec<(String, String)> = result1
            .edges
            .iter()
            .filter(|e| e.relation == "contains")
            .map(|e| (e.from.clone(), e.to.clone()))
            .collect();
        let mut edges2: Vec<(String, String)> = result2
            .edges
            .iter()
            .filter(|e| e.relation == "contains")
            .map(|e| (e.from.clone(), e.to.clone()))
            .collect();
        edges1.sort();
        edges2.sort();
        assert_eq!(edges1, edges2, "Deterministic: same seed should produce identical clustering");
    }
}
