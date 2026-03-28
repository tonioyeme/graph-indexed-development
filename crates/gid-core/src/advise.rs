//! Graph analysis and advice module.
//!
//! Static analysis to detect issues and suggest improvements.

use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};
use crate::graph::{Graph, Node, NodeStatus};
use crate::query::QueryEngine;
use crate::validator::Validator;

/// Severity level for advice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

impl std::fmt::Display for Severity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Severity::Info => write!(f, "info"),
            Severity::Warning => write!(f, "warning"),
            Severity::Error => write!(f, "error"),
        }
    }
}

/// Type of advice/issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdviceType {
    CircularDependency,
    OrphanNode,
    HighFanIn,
    HighFanOut,
    MissingDescription,
    LayerViolation,
    DeepDependencyChain,
    MissingRef,
    DuplicateNode,
    SuggestedTaskOrder,
    UnreachableTask,
    BlockedChain,
}

impl std::fmt::Display for AdviceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdviceType::CircularDependency => write!(f, "circular-dependency"),
            AdviceType::OrphanNode => write!(f, "orphan-node"),
            AdviceType::HighFanIn => write!(f, "high-fan-in"),
            AdviceType::HighFanOut => write!(f, "high-fan-out"),
            AdviceType::MissingDescription => write!(f, "missing-description"),
            AdviceType::LayerViolation => write!(f, "layer-violation"),
            AdviceType::DeepDependencyChain => write!(f, "deep-dependency-chain"),
            AdviceType::MissingRef => write!(f, "missing-reference"),
            AdviceType::DuplicateNode => write!(f, "duplicate-node"),
            AdviceType::SuggestedTaskOrder => write!(f, "suggested-task-order"),
            AdviceType::UnreachableTask => write!(f, "unreachable-task"),
            AdviceType::BlockedChain => write!(f, "blocked-chain"),
        }
    }
}

/// A single piece of advice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Advice {
    /// Type of issue
    pub advice_type: AdviceType,
    /// Severity level
    pub severity: Severity,
    /// Human-readable description
    pub message: String,
    /// Affected node IDs (if any)
    pub nodes: Vec<String>,
    /// Suggested fix (if applicable)
    pub suggestion: Option<String>,
}

impl std::fmt::Display for Advice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let icon = match self.severity {
            Severity::Error => "❌",
            Severity::Warning => "⚠️ ",
            Severity::Info => "ℹ️ ",
        };
        
        write!(f, "{} [{}] {}", icon, self.advice_type, self.message)?;
        
        if !self.nodes.is_empty() {
            write!(f, "\n   📍 Nodes: {}", self.nodes.join(", "))?;
        }
        
        if let Some(ref suggestion) = self.suggestion {
            write!(f, "\n   💡 {}", suggestion)?;
        }
        
        Ok(())
    }
}

/// Analysis result with all advice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResult {
    /// All advice items
    pub items: Vec<Advice>,
    /// Health score (0-100)
    pub health_score: u8,
    /// Whether the graph passes basic validation
    pub passed: bool,
}

impl AnalysisResult {
    pub fn errors(&self) -> Vec<&Advice> {
        self.items.iter().filter(|a| a.severity == Severity::Error).collect()
    }
    
    pub fn warnings(&self) -> Vec<&Advice> {
        self.items.iter().filter(|a| a.severity == Severity::Warning).collect()
    }
    
    pub fn info(&self) -> Vec<&Advice> {
        self.items.iter().filter(|a| a.severity == Severity::Info).collect()
    }
}

impl std::fmt::Display for AnalysisResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.items.is_empty() {
            return write!(f, "✅ Graph is healthy! Score: {}/100", self.health_score);
        }
        
        writeln!(f, "📊 Analysis Result")?;
        writeln!(f, "═══════════════════════════════════════════════════")?;
        writeln!(f)?;
        
        for item in &self.items {
            writeln!(f, "{}", item)?;
            writeln!(f)?;
        }
        
        writeln!(f, "─────────────────────────────────────────────────────")?;
        writeln!(f, "Summary: {} errors, {} warnings, {} info",
            self.errors().len(),
            self.warnings().len(),
            self.info().len()
        )?;
        write!(f, "Health Score: {}/100", self.health_score)?;
        
        Ok(())
    }
}

/// Analyze a graph and return advice.
pub fn analyze(graph: &Graph) -> AnalysisResult {
    let mut items = Vec::new();
    
    // Code node types — auto-extracted, different rules than project nodes
    let code_node_types = ["file", "class", "function", "module"];
    
    // Run validator first
    let validator = Validator::new(graph);
    let validation = validator.validate();
    
    // Convert validation issues to advice
    
    // Cycles
    for cycle in &validation.cycles {
        items.push(Advice {
            advice_type: AdviceType::CircularDependency,
            severity: Severity::Error,
            message: format!("Circular dependency detected: {}", cycle.join(" → ")),
            nodes: cycle.clone(),
            suggestion: Some("Break the cycle by removing one of the dependencies.".to_string()),
        });
    }
    
    // Missing references
    for missing in &validation.missing_refs {
        items.push(Advice {
            advice_type: AdviceType::MissingRef,
            severity: Severity::Error,
            message: format!("Edge references non-existent node '{}'", missing.missing_node),
            nodes: vec![missing.edge_from.clone(), missing.edge_to.clone()],
            suggestion: Some(format!("Add node '{}' or remove the edge.", missing.missing_node)),
        });
    }
    
    // Duplicate nodes
    for dup in &validation.duplicate_nodes {
        items.push(Advice {
            advice_type: AdviceType::DuplicateNode,
            severity: Severity::Error,
            message: format!("Duplicate node ID: {}", dup),
            nodes: vec![dup.clone()],
            suggestion: Some("Rename or remove duplicate nodes.".to_string()),
        });
    }
    
    // Orphan nodes — only warn for project-level nodes, not code nodes
    for orphan in &validation.orphan_nodes {
        let is_code_orphan = orphan.starts_with("code_") 
            || orphan.starts_with("const_") 
            || orphan.starts_with("method_")
            || graph.get_node(orphan)
                .and_then(|n| n.node_type.as_deref())
                .map(|t| code_node_types.contains(&t))
                .unwrap_or(false);
        
        if !is_code_orphan {
            items.push(Advice {
                advice_type: AdviceType::OrphanNode,
                severity: Severity::Warning,
                message: format!("Node '{}' has no connections", orphan),
                nodes: vec![orphan.clone()],
                suggestion: Some("Connect to related nodes or remove if unused.".to_string()),
            });
        }
    }
    
    // Additional analysis
    
    // High fan-in/fan-out analysis — only for project-level nodes
    // Code-level coupling (imports, calls, defined_in) is structural and expected
    let (fan_in, fan_out) = compute_fan_metrics(graph);
    const HIGH_FAN_THRESHOLD: usize = 5;
    
    for (node_id, count) in &fan_in {
        if *count >= HIGH_FAN_THRESHOLD {
            let is_code = node_id.starts_with("code_") || node_id.starts_with("const_");
            if !is_code {
                items.push(Advice {
                    advice_type: AdviceType::HighFanIn,
                    severity: Severity::Warning,
                    message: format!("Node '{}' has {} dependents (high coupling)", node_id, count),
                    nodes: vec![node_id.clone()],
                    suggestion: Some("Consider splitting into smaller components or introducing an abstraction layer.".to_string()),
                });
            }
        }
    }
    
    for (node_id, count) in &fan_out {
        if *count >= HIGH_FAN_THRESHOLD {
            let is_code = node_id.starts_with("code_") || node_id.starts_with("const_");
            if !is_code {
                items.push(Advice {
                    advice_type: AdviceType::HighFanOut,
                    severity: Severity::Warning,
                    message: format!("Node '{}' depends on {} other nodes (high coupling)", node_id, count),
                    nodes: vec![node_id.clone()],
                    suggestion: Some("Consider reducing dependencies or introducing a facade.".to_string()),
                });
            }
        }
    }
    
    // Missing descriptions — only for project-level nodes (task, component, feature)
    // Code nodes (file, class, function, module) are auto-extracted and don't need descriptions
    for node in &graph.nodes {
        let is_code_node = node.node_type.as_deref()
            .map(|t| code_node_types.contains(&t))
            .unwrap_or(false)
            || node.id.starts_with("code_")
            || node.id.starts_with("const_")
            || node.id.starts_with("method_");
        
        if node.description.is_none() && !is_code_node {
            items.push(Advice {
                advice_type: AdviceType::MissingDescription,
                severity: Severity::Info,
                message: format!("Node '{}' has no description", node.id),
                nodes: vec![node.id.clone()],
                suggestion: Some("Add a description to improve documentation.".to_string()),
            });
        }
    }
    
    // Deep dependency chains
    let chain_depths = compute_chain_depths(graph);
    const DEEP_CHAIN_THRESHOLD: usize = 5;
    
    for (node_id, depth) in &chain_depths {
        if *depth >= DEEP_CHAIN_THRESHOLD {
            items.push(Advice {
                advice_type: AdviceType::DeepDependencyChain,
                severity: Severity::Info,
                message: format!("Node '{}' has dependency chain depth of {}", node_id, depth),
                nodes: vec![node_id.clone()],
                suggestion: Some("Consider flattening the dependency structure.".to_string()),
            });
        }
    }
    
    // Layer violation detection
    let layer_violations = detect_layer_violations(graph);
    for (from, to, from_layer, to_layer) in layer_violations {
        items.push(Advice {
            advice_type: AdviceType::LayerViolation,
            severity: Severity::Warning,
            message: format!(
                "Layer violation: '{}' ({}) depends on '{}' ({})",
                from, 
                from_layer.as_deref().unwrap_or("unassigned"), 
                to, 
                to_layer.as_deref().unwrap_or("unassigned")
            ),
            nodes: vec![from.clone(), to.clone()],
            suggestion: Some("Ensure dependencies flow from higher to lower layers.".to_string()),
        });
    }
    
    // Blocked chain detection
    let blocked_chains = detect_blocked_chains(graph);
    for (blocked_node, affected) in blocked_chains {
        if !affected.is_empty() {
            items.push(Advice {
                advice_type: AdviceType::BlockedChain,
                severity: Severity::Warning,
                message: format!(
                    "Blocked node '{}' is blocking {} other tasks",
                    blocked_node, affected.len()
                ),
                nodes: std::iter::once(blocked_node).chain(affected).collect(),
                suggestion: Some("Unblock this task to enable dependent work.".to_string()),
            });
        }
    }
    
    // Suggest task order
    let engine = QueryEngine::new(graph);
    if let Ok(topo_order) = engine.topological_sort() {
        // Only show if there are todo tasks
        let todo_tasks: Vec<&String> = topo_order.iter()
            .filter(|id| {
                graph.get_node(id)
                    .map(|n| n.status == NodeStatus::Todo)
                    .unwrap_or(false)
            })
            .collect();
        
        if todo_tasks.len() > 1 {
            items.push(Advice {
                advice_type: AdviceType::SuggestedTaskOrder,
                severity: Severity::Info,
                message: format!("Suggested order for {} todo tasks based on dependencies", todo_tasks.len()),
                nodes: todo_tasks.iter().take(10).map(|s| s.to_string()).collect(),
                suggestion: Some(format!(
                    "Start with: {}",
                    todo_tasks.iter().take(3).map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                )),
            });
        }
    }
    
    // Sort by severity (errors first)
    items.sort_by(|a, b| b.severity.cmp(&a.severity));
    
    // Calculate health score based on severity
    let error_count = items.iter().filter(|a| a.severity == Severity::Error).count();
    let warning_count = items.iter().filter(|a| a.severity == Severity::Warning).count();
    let info_count = items.iter().filter(|a| a.severity == Severity::Info).count();
    
    // Scoring: errors are critical, warnings matter, info is advisory
    // Cap deductions so a few info items don't tank the score
    let mut score = 100i32;
    score -= (error_count * 25) as i32;          // -25 per error (critical)
    score -= (warning_count * 10) as i32;        // -10 per warning (significant)
    score -= (info_count.min(10) * 2) as i32;    // -2 per info, max -20 (advisory, capped)
    let health_score = score.max(0).min(100) as u8;
    
    AnalysisResult {
        items,
        health_score,
        passed: validation.is_valid(),
    }
}

/// Compute fan-in and fan-out for each node.
fn compute_fan_metrics(graph: &Graph) -> (HashMap<String, usize>, HashMap<String, usize>) {
    let mut fan_in: HashMap<String, usize> = HashMap::new();
    let mut fan_out: HashMap<String, usize> = HashMap::new();
    
    for edge in &graph.edges {
        if edge.relation == "depends_on" {
            *fan_in.entry(edge.to.clone()).or_default() += 1;
            *fan_out.entry(edge.from.clone()).or_default() += 1;
        }
    }
    
    (fan_in, fan_out)
}

/// Compute maximum dependency chain depth for each node.
fn compute_chain_depths(graph: &Graph) -> HashMap<String, usize> {
    let mut depths: HashMap<String, usize> = HashMap::new();
    
    // Build adjacency list with owned strings
    let mut deps: HashMap<String, Vec<String>> = HashMap::new();
    for edge in &graph.edges {
        if edge.relation == "depends_on" {
            deps.entry(edge.from.clone()).or_default().push(edge.to.clone());
        }
    }
    
    fn compute_depth(
        node: &str,
        deps: &HashMap<String, Vec<String>>,
        cache: &mut HashMap<String, usize>,
        visiting: &mut HashSet<String>,
    ) -> usize {
        if let Some(&depth) = cache.get(node) {
            return depth;
        }
        
        if visiting.contains(node) {
            return 0; // Cycle, avoid infinite recursion
        }
        
        visiting.insert(node.to_string());
        
        let depth = deps.get(node)
            .map(|children| {
                children.iter()
                    .map(|child| compute_depth(child, deps, cache, visiting) + 1)
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        
        visiting.remove(node);
        cache.insert(node.to_string(), depth);
        depth
    }
    
    let mut visiting = HashSet::new();
    for node in &graph.nodes {
        compute_depth(&node.id, &deps, &mut depths, &mut visiting);
    }
    
    depths
}

/// Detect layer violations (lower layer depending on higher layer).
fn detect_layer_violations(graph: &Graph) -> Vec<(String, String, Option<String>, Option<String>)> {
    // Layer hierarchy (higher number = higher layer)
    fn layer_rank(layer: Option<&str>) -> Option<i32> {
        match layer {
            Some("interface") | Some("presentation") => Some(4),
            Some("application") | Some("service") => Some(3),
            Some("domain") | Some("business") => Some(2),
            Some("infrastructure") | Some("data") => Some(1),
            _ => None,
        }
    }
    
    let mut violations = Vec::new();
    
    // Build node layer map
    let node_layers: HashMap<&str, Option<&str>> = graph.nodes.iter()
        .map(|n| (n.id.as_str(), n.node_type.as_deref()))
        .collect();
    
    // Also check for explicit layer metadata
    let node_explicit_layers: HashMap<&str, Option<String>> = graph.nodes.iter()
        .map(|n| {
            let layer = n.metadata.get("layer")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (n.id.as_str(), layer)
        })
        .collect();
    
    for edge in &graph.edges {
        if edge.relation == "depends_on" {
            let from_layer = node_explicit_layers.get(edge.from.as_str())
                .and_then(|l| l.as_ref())
                .map(|s| s.as_str())
                .or_else(|| node_layers.get(edge.from.as_str()).copied().flatten());
            
            let to_layer = node_explicit_layers.get(edge.to.as_str())
                .and_then(|l| l.as_ref())
                .map(|s| s.as_str())
                .or_else(|| node_layers.get(edge.to.as_str()).copied().flatten());
            
            if let (Some(from_rank), Some(to_rank)) = (layer_rank(from_layer), layer_rank(to_layer)) {
                // Violation: lower layer depends on higher layer
                if from_rank < to_rank {
                    violations.push((
                        edge.from.clone(),
                        edge.to.clone(),
                        from_layer.map(|s| s.to_string()),
                        to_layer.map(|s| s.to_string()),
                    ));
                }
            }
        }
    }
    
    violations
}

/// Detect blocked nodes that are blocking other tasks.
fn detect_blocked_chains(graph: &Graph) -> Vec<(String, Vec<String>)> {
    let engine = QueryEngine::new(graph);
    let mut results = Vec::new();
    
    // Find blocked nodes
    let blocked: Vec<&Node> = graph.nodes.iter()
        .filter(|n| n.status == NodeStatus::Blocked)
        .collect();
    
    for node in blocked {
        // Find all nodes that depend on this blocked node (reverse impact)
        let affected: Vec<String> = engine.impact(&node.id)
            .iter()
            .filter(|n| n.status == NodeStatus::Todo || n.status == NodeStatus::InProgress)
            .map(|n| n.id.clone())
            .collect();
        
        if !affected.is_empty() {
            results.push((node.id.clone(), affected));
        }
    }
    
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Node, Edge};
    
    #[test]
    fn test_analyze_empty_graph() {
        let graph = Graph::new();
        let result = analyze(&graph);
        assert!(result.passed);
        assert_eq!(result.health_score, 100);
    }
    
    #[test]
    fn test_analyze_orphan_node() {
        let mut graph = Graph::new();
        graph.add_node(Node::new("orphan", "Orphan Node"));
        
        let result = analyze(&graph);
        assert!(result.items.iter().any(|a| a.advice_type == AdviceType::OrphanNode));
    }
    
    #[test]
    fn test_analyze_cycle() {
        let mut graph = Graph::new();
        graph.add_node(Node::new("a", "A"));
        graph.add_node(Node::new("b", "B"));
        graph.add_edge(Edge::depends_on("a", "b"));
        graph.add_edge(Edge::depends_on("b", "a"));
        
        let result = analyze(&graph);
        assert!(!result.passed);
        assert!(result.items.iter().any(|a| a.advice_type == AdviceType::CircularDependency));
    }
    
    #[test]
    fn test_analyze_high_coupling() {
        let mut graph = Graph::new();
        graph.add_node(Node::new("hub", "Hub Node"));
        for i in 0..6 {
            let id = format!("dep{}", i);
            graph.add_node(Node::new(&id, &format!("Dep {}", i)));
            graph.add_edge(Edge::depends_on(&id, "hub"));
        }
        
        let result = analyze(&graph);
        assert!(result.items.iter().any(|a| a.advice_type == AdviceType::HighFanIn));
    }
}
