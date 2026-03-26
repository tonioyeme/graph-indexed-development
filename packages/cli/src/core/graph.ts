/**
 * GID Graph Class
 *
 * Provides graph operations and traversal methods.
 */

import { Graph, Node, Edge, EdgeRelation, GIDError } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Graph Class
// ═══════════════════════════════════════════════════════════════════════════════

export class GIDGraph {
  private nodes: Map<string, Node>;
  private edges: Edge[];

  // Pre-computed indexes for fast lookups
  private outgoingEdges: Map<string, Edge[]>;
  private incomingEdges: Map<string, Edge[]>;

  constructor(data: Graph) {
    this.nodes = new Map(Object.entries(data.nodes));
    this.edges = data.edges;

    // Build edge indexes
    this.outgoingEdges = new Map();
    this.incomingEdges = new Map();

    for (const edge of this.edges) {
      // Outgoing edges (from -> to)
      if (!this.outgoingEdges.has(edge.from)) {
        this.outgoingEdges.set(edge.from, []);
      }
      this.outgoingEdges.get(edge.from)!.push(edge);

      // Incoming edges (to <- from)
      if (!this.incomingEdges.has(edge.to)) {
        this.incomingEdges.set(edge.to, []);
      }
      this.incomingEdges.get(edge.to)!.push(edge);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Node Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | undefined {
    return this.nodes.get(id);
  }

  /**
   * Get a node by ID, throw if not found
   */
  getNodeOrThrow(id: string): Node {
    const node = this.nodes.get(id);
    if (!node) {
      throw new GIDError(
        `Node not found: "${id}"`,
        'NODE_NOT_FOUND',
        { nodeId: id, availableNodes: this.getNodeIds().slice(0, 10) }
      );
    }
    return node;
  }

  /**
   * Check if a node exists
   */
  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /**
   * Get all node IDs
   */
  getNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Get all nodes as a Map
   */
  getNodes(): Map<string, Node> {
    return this.nodes;
  }

  /**
   * Get nodes by type
   */
  getNodesByType(type: Node['type']): Array<[string, Node]> {
    return Array.from(this.nodes.entries()).filter(([_, node]) => node.type === type);
  }

  /**
   * Get all Features
   */
  getFeatures(): Array<[string, Node]> {
    return this.getNodesByType('Feature');
  }

  /**
   * Get all Components
   */
  getComponents(): Array<[string, Node]> {
    return this.getNodesByType('Component');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get all edges from a node
   */
  getOutgoingEdges(nodeId: string, relation?: EdgeRelation): Edge[] {
    const edges = this.outgoingEdges.get(nodeId) ?? [];
    if (relation) {
      return edges.filter((e) => e.relation === relation);
    }
    return edges;
  }

  /**
   * Get all edges to a node
   */
  getIncomingEdges(nodeId: string, relation?: EdgeRelation): Edge[] {
    const edges = this.incomingEdges.get(nodeId) ?? [];
    if (relation) {
      return edges.filter((e) => e.relation === relation);
    }
    return edges;
  }

  /**
   * Get all edges
   */
  getAllEdges(): Edge[] {
    return this.edges;
  }

  /**
   * Get all edges (alias for getAllEdges)
   */
  getEdges(): Edge[] {
    return this.edges;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dependency Queries
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get direct dependencies of a node (what it depends on)
   */
  getDependencies(nodeId: string): string[] {
    return this.getOutgoingEdges(nodeId, 'depends_on').map((e) => e.to);
  }

  /**
   * Get direct dependents of a node (what depends on it)
   */
  getDependents(nodeId: string): string[] {
    return this.getIncomingEdges(nodeId, 'depends_on').map((e) => e.from);
  }

  /**
   * Get all transitive dependencies (recursive)
   */
  getAllDependencies(nodeId: string, visited = new Set<string>()): string[] {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);

    const directDeps = this.getDependencies(nodeId);
    const allDeps: string[] = [...directDeps];

    for (const dep of directDeps) {
      const transitiveDeps = this.getAllDependencies(dep, visited);
      allDeps.push(...transitiveDeps);
    }

    return [...new Set(allDeps)];
  }

  /**
   * Get all transitive dependents (recursive)
   */
  getAllDependents(nodeId: string, visited = new Set<string>()): string[] {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);

    const directDeps = this.getDependents(nodeId);
    const allDeps: string[] = [...directDeps];

    for (const dep of directDeps) {
      const transitiveDeps = this.getAllDependents(dep, visited);
      allDeps.push(...transitiveDeps);
    }

    return [...new Set(allDeps)];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature Queries
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get features that a component implements
   */
  getImplementedFeatures(componentId: string): string[] {
    return this.getOutgoingEdges(componentId, 'implements').map((e) => e.to);
  }

  /**
   * Get components that implement a feature
   */
  getImplementingComponents(featureId: string): string[] {
    return this.getIncomingEdges(featureId, 'implements').map((e) => e.from);
  }

  /**
   * Get all features affected by changing a component
   * (follows implements edges from all dependents)
   */
  getAffectedFeatures(nodeId: string): string[] {
    const affectedComponents = [nodeId, ...this.getAllDependents(nodeId)];
    const features = new Set<string>();

    for (const compId of affectedComponents) {
      const implFeatures = this.getImplementedFeatures(compId);
      for (const f of implFeatures) {
        features.add(f);
      }
    }

    return [...features];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Test Queries
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get tests for a component
   */
  getTests(componentId: string): string[] {
    return this.getOutgoingEdges(componentId, 'tested_by').map((e) => e.to);
  }

  /**
   * Get all tests affected by changing a component
   */
  getAffectedTests(nodeId: string): string[] {
    const affectedComponents = [nodeId, ...this.getAllDependents(nodeId)];
    const tests = new Set<string>();

    for (const compId of affectedComponents) {
      const compTests = this.getTests(compId);
      for (const t of compTests) {
        tests.add(t);
      }
    }

    return [...tests];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utility
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get summary statistics
   */
  getStats(): {
    nodeCount: number;
    edgeCount: number;
    featureCount: number;
    componentCount: number;
  } {
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      featureCount: this.getFeatures().length,
      componentCount: this.getComponents().length,
    };
  }

  /**
   * Convert back to plain object
   */
  toJSON(): Graph {
    return {
      nodes: Object.fromEntries(this.nodes),
      edges: this.edges,
    };
  }
}
