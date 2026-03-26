/**
 * GID Query Engine
 *
 * Provides high-level query operations for impact analysis,
 * dependency lookup, and root cause analysis.
 */

import { GIDGraph } from './graph.js';
import { ImpactResult, DependencyResult, CommonCauseResult } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Query Engine Class
// ═══════════════════════════════════════════════════════════════════════════════

export class QueryEngine {
  constructor(private graph: GIDGraph) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Impact Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Analyze the impact of changing a node
   *
   * Returns:
   * - Direct dependents (components that directly depend on this)
   * - Transitive dependents (all components affected)
   * - Affected features (features that could be impacted)
   * - Affected tests (tests that should be run)
   */
  getImpact(nodeId: string): ImpactResult {
    // Validate node exists
    const node = this.graph.getNodeOrThrow(nodeId);

    // Get dependents
    const directDependents = this.graph.getDependents(nodeId);
    const allDependents = this.graph.getAllDependents(nodeId);
    const transitiveDependents = allDependents.filter(
      (d) => !directDependents.includes(d)
    );

    // Get affected features
    const affectedFeatures = this.graph.getAffectedFeatures(nodeId);

    // Get affected tests
    const affectedTests = this.graph.getAffectedTests(nodeId);

    return {
      node: nodeId,
      nodeType: node.type,
      directDependents,
      transitiveDependents,
      affectedFeatures,
      affectedTests,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dependency Queries
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get dependencies of a node (what it depends on)
   */
  getDependencies(nodeId: string): DependencyResult {
    // Validate node exists
    this.graph.getNodeOrThrow(nodeId);

    const direct = this.graph.getDependencies(nodeId);
    const allDeps = this.graph.getAllDependencies(nodeId);
    const transitive = allDeps.filter((d) => !direct.includes(d));

    return {
      node: nodeId,
      direct,
      transitive,
    };
  }

  /**
   * Get dependents of a node (what depends on it)
   */
  getDependents(nodeId: string): DependencyResult {
    // Validate node exists
    this.graph.getNodeOrThrow(nodeId);

    const direct = this.graph.getDependents(nodeId);
    const allDeps = this.graph.getAllDependents(nodeId);
    const transitive = allDeps.filter((d) => !direct.includes(d));

    return {
      node: nodeId,
      direct,
      transitive,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Root Cause Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find common dependencies of two nodes
   * Useful for debugging when multiple components are affected
   */
  getCommonCause(nodeA: string, nodeB: string): CommonCauseResult {
    // Validate nodes exist
    this.graph.getNodeOrThrow(nodeA);
    this.graph.getNodeOrThrow(nodeB);

    // Get all dependencies (including self)
    const depsA = new Set([nodeA, ...this.graph.getAllDependencies(nodeA)]);
    const depsB = new Set([nodeB, ...this.graph.getAllDependencies(nodeB)]);

    // Find intersection
    const commonDependencies: string[] = [];
    for (const dep of depsA) {
      if (depsB.has(dep) && dep !== nodeA && dep !== nodeB) {
        commonDependencies.push(dep);
      }
    }

    return {
      nodeA,
      nodeB,
      commonDependencies,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Path Finding
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find dependency path between two nodes
   * Returns null if no path exists
   */
  findPath(from: string, to: string): string[] | null {
    // Validate nodes exist
    this.graph.getNodeOrThrow(from);
    this.graph.getNodeOrThrow(to);

    // BFS to find shortest path
    const queue: Array<{ node: string; path: string[] }> = [
      { node: from, path: [from] },
    ];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;

      if (node === to) {
        return path;
      }

      if (visited.has(node)) continue;
      visited.add(node);

      // Get dependencies (what this node depends on)
      const deps = this.graph.getDependencies(node);
      for (const dep of deps) {
        if (!visited.has(dep)) {
          queue.push({ node: dep, path: [...path, dep] });
        }
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature Queries
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get all components needed to implement a feature
   */
  getFeatureComponents(featureId: string): string[] {
    // Validate node exists and is a Feature
    const node = this.graph.getNodeOrThrow(featureId);
    if (node.type !== 'Feature') {
      throw new Error(`Node "${featureId}" is not a Feature (type: ${node.type})`);
    }

    // Get direct implementing components
    const directComponents = this.graph.getImplementingComponents(featureId);

    // Get all their dependencies
    const allComponents = new Set(directComponents);
    for (const comp of directComponents) {
      const deps = this.graph.getAllDependencies(comp);
      for (const dep of deps) {
        const depNode = this.graph.getNode(dep);
        if (depNode?.type === 'Component') {
          allComponents.add(dep);
        }
      }
    }

    return [...allComponents];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary Queries
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get nodes with most dependents (potential bottlenecks)
   */
  getHighCouplingNodes(threshold = 5): Array<{ nodeId: string; dependentCount: number }> {
    const results: Array<{ nodeId: string; dependentCount: number }> = [];

    for (const nodeId of this.graph.getNodeIds()) {
      const dependents = this.graph.getDependents(nodeId);
      if (dependents.length >= threshold) {
        results.push({ nodeId, dependentCount: dependents.length });
      }
    }

    // Sort by dependent count descending
    return results.sort((a, b) => b.dependentCount - a.dependentCount);
  }

  /**
   * Get orphan nodes (no incoming or outgoing edges)
   */
  getOrphanNodes(): string[] {
    const orphans: string[] = [];

    for (const nodeId of this.graph.getNodeIds()) {
      const incoming = this.graph.getIncomingEdges(nodeId);
      const outgoing = this.graph.getOutgoingEdges(nodeId);

      if (incoming.length === 0 && outgoing.length === 0) {
        orphans.push(nodeId);
      }
    }

    return orphans;
  }
}
