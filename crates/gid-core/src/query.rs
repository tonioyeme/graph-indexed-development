use std::collections::{HashMap, HashSet, VecDeque};
use crate::graph::{Graph, Node};

/// Query engine for graph traversal and analysis.
pub struct QueryEngine<'a> {
    graph: &'a Graph,
}

impl<'a> QueryEngine<'a> {
    pub fn new(graph: &'a Graph) -> Self {
        Self { graph }
    }

    /// Impact analysis: what nodes are affected if `node_id` changes?
    /// Follows reverse dependency edges (who depends on this node?).
    /// Traverses all edge relations by default.
    pub fn impact(&self, node_id: &str) -> Vec<&'a Node> {
        self.impact_filtered(node_id, None)
    }

    /// Impact analysis with optional relation filter.
    /// If `relations` is None, traverses all edge types.
    pub fn impact_filtered(&self, node_id: &str, relations: Option<&[&str]>) -> Vec<&'a Node> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(node_id.to_string());
        visited.insert(node_id.to_string());

        while let Some(current) = queue.pop_front() {
            // Find nodes that point to current (edges where to == current)
            for edge in &self.graph.edges {
                if edge.to != current {
                    continue;
                }
                // Apply relation filter if set
                if let Some(rels) = relations {
                    if !rels.contains(&edge.relation.as_str()) {
                        continue;
                    }
                }
                if visited.insert(edge.from.clone()) {
                    queue.push_back(edge.from.clone());
                }
            }
        }

        visited.remove(node_id);
        self.graph.nodes.iter()
            .filter(|n| visited.contains(&n.id))
            .collect()
    }

    /// Dependencies: what does `node_id` depend on? (transitive)
    /// Traverses all edge relations by default.
    pub fn deps(&self, node_id: &str, transitive: bool) -> Vec<&'a Node> {
        self.deps_filtered(node_id, transitive, None)
    }

    /// Dependencies with optional relation filter.
    /// If `relations` is None, traverses all edge types.
    pub fn deps_filtered(&self, node_id: &str, transitive: bool, relations: Option<&[&str]>) -> Vec<&'a Node> {
        if !transitive {
            // Direct deps only
            let dep_ids: HashSet<&str> = self.graph.edges.iter()
                .filter(|e| {
                    if e.from != node_id {
                        return false;
                    }
                    if let Some(rels) = relations {
                        rels.contains(&e.relation.as_str())
                    } else {
                        true
                    }
                })
                .map(|e| e.to.as_str())
                .collect();
            return self.graph.nodes.iter()
                .filter(|n| dep_ids.contains(n.id.as_str()))
                .collect();
        }

        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(node_id.to_string());
        visited.insert(node_id.to_string());

        while let Some(current) = queue.pop_front() {
            for edge in &self.graph.edges {
                if edge.from != current {
                    continue;
                }
                if let Some(rels) = relations {
                    if !rels.contains(&edge.relation.as_str()) {
                        continue;
                    }
                }
                if visited.insert(edge.to.clone()) {
                    queue.push_back(edge.to.clone());
                }
            }
        }

        visited.remove(node_id);
        self.graph.nodes.iter()
            .filter(|n| visited.contains(&n.id))
            .collect()
    }

    /// Find shortest path between two nodes (any edge direction).
    pub fn path(&self, from: &str, to: &str) -> Option<Vec<String>> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut parent: HashMap<String, String> = HashMap::new();

        queue.push_back(from.to_string());
        visited.insert(from.to_string());

        while let Some(current) = queue.pop_front() {
            if current == to {
                // Reconstruct path
                let mut path = vec![to.to_string()];
                let mut cur = to.to_string();
                while let Some(p) = parent.get(&cur) {
                    path.push(p.clone());
                    cur = p.clone();
                }
                path.reverse();
                return Some(path);
            }

            // Follow edges in both directions
            for edge in &self.graph.edges {
                let neighbor = if edge.from == current {
                    &edge.to
                } else if edge.to == current {
                    &edge.from
                } else {
                    continue;
                };
                if visited.insert(neighbor.clone()) {
                    parent.insert(neighbor.clone(), current.clone());
                    queue.push_back(neighbor.clone());
                }
            }
        }

        None
    }

    /// Common cause: find shared dependencies of two nodes.
    pub fn common_cause(&self, node_a: &str, node_b: &str) -> Vec<&'a Node> {
        let deps_a: HashSet<String> = self.deps(node_a, true)
            .iter().map(|n| n.id.clone()).collect();
        let deps_b: HashSet<String> = self.deps(node_b, true)
            .iter().map(|n| n.id.clone()).collect();
        let common: HashSet<&String> = deps_a.intersection(&deps_b).collect();

        self.graph.nodes.iter()
            .filter(|n| common.contains(&n.id))
            .collect()
    }

    /// Topological sort (returns error if cycle detected).
    pub fn topological_sort(&self) -> anyhow::Result<Vec<String>> {
        let mut in_degree: HashMap<&str, usize> = HashMap::new();
        for node in &self.graph.nodes {
            in_degree.entry(&node.id).or_insert(0);
        }
        for edge in &self.graph.edges {
            if edge.relation == "depends_on" {
                *in_degree.entry(&edge.from).or_insert(0) += 1;
            }
        }

        let mut queue: VecDeque<&str> = in_degree.iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&id, _)| id)
            .collect();

        let mut sorted = Vec::new();
        while let Some(node) = queue.pop_front() {
            sorted.push(node.to_string());
            for edge in &self.graph.edges {
                if edge.to == node && edge.relation == "depends_on" {
                    if let Some(deg) = in_degree.get_mut(edge.from.as_str()) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(&edge.from);
                        }
                    }
                }
            }
        }

        if sorted.len() != self.graph.nodes.len() {
            anyhow::bail!("Cycle detected in graph");
        }

        Ok(sorted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, Node, Edge};

    fn make_edge(from: &str, to: &str, relation: &str) -> Edge {
        Edge {
            from: from.into(),
            to: to.into(),
            relation: relation.into(),
            weight: None,
            confidence: None,
            metadata: None,
        }
    }

    fn make_test_graph() -> Graph {
        // A → depends_on → B → depends_on → C
        // A → implements → D
        // E → belongs_to → D
        let nodes = vec![
            Node::new("A", "A"),
            Node::new("B", "B"),
            Node::new("C", "C"),
            Node::new("D", "D"),
            Node::new("E", "E"),
        ];
        let edges = vec![
            make_edge("A", "B", "depends_on"),
            make_edge("B", "C", "depends_on"),
            make_edge("A", "D", "implements"),
            make_edge("E", "D", "belongs_to"),
        ];
        Graph { nodes, edges, ..Default::default() }
    }

    #[test]
    fn test_impact_multi_relation() {
        let graph = make_test_graph();
        let qe = QueryEngine::new(&graph);

        // Default impact traverses all relations
        // Changing C: B depends_on C → A depends_on B → impacted: A, B
        let impacted = qe.impact("C");
        let ids: Vec<&str> = impacted.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"B"));
        assert!(ids.contains(&"A"));
    }

    #[test]
    fn test_impact_filtered_depends_on_only() {
        let graph = make_test_graph();
        let qe = QueryEngine::new(&graph);

        // Filter to depends_on: changing D, A implements D but with depends_on filter, not traversed
        let impacted = qe.impact_filtered("D", Some(&["depends_on"]));
        let ids: Vec<&str> = impacted.iter().map(|n| n.id.as_str()).collect();
        // No node has depends_on edge to D
        assert!(ids.is_empty());
    }

    #[test]
    fn test_impact_filtered_all_relations() {
        let graph = make_test_graph();
        let qe = QueryEngine::new(&graph);

        // Changing D: A implements D, E belongs_to D → both impacted
        let impacted = qe.impact_filtered("D", None);
        let ids: Vec<&str> = impacted.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"A"), "A implements D");
        assert!(ids.contains(&"E"), "E belongs_to D");
    }

    #[test]
    fn test_deps_multi_relation() {
        let graph = make_test_graph();
        let qe = QueryEngine::new(&graph);

        // A's deps (all relations): B (depends_on), D (implements), and transitively C (via B)
        let deps = qe.deps("A", true);
        let ids: Vec<&str> = deps.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"B"));
        assert!(ids.contains(&"C"));
        assert!(ids.contains(&"D"));
    }

    #[test]
    fn test_deps_filtered_depends_on_only() {
        let graph = make_test_graph();
        let qe = QueryEngine::new(&graph);

        // A's deps with depends_on filter: B, C — but NOT D (implements edge)
        let deps = qe.deps_filtered("A", true, Some(&["depends_on"]));
        let ids: Vec<&str> = deps.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"B"));
        assert!(ids.contains(&"C"));
        assert!(!ids.contains(&"D"), "D should be excluded — implements, not depends_on");
    }

    #[test]
    fn test_deps_non_transitive_filtered() {
        let graph = make_test_graph();
        let qe = QueryEngine::new(&graph);

        // A direct deps only, all relations: B (depends_on) and D (implements)
        let deps = qe.deps_filtered("A", false, None);
        let ids: Vec<&str> = deps.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"B"));
        assert!(ids.contains(&"D"));
        assert!(!ids.contains(&"C"), "C is transitive, should be excluded");
    }

    #[test]
    fn test_backward_compat_impact_uses_all_relations() {
        let graph = make_test_graph();
        let qe = QueryEngine::new(&graph);

        // impact() without filter should traverse all relations (backward compat)
        let impacted = qe.impact("D");
        let ids: Vec<&str> = impacted.iter().map(|n| n.id.as_str()).collect();
        // A implements D, E belongs_to D
        assert!(ids.contains(&"A"));
        assert!(ids.contains(&"E"));
    }
}
