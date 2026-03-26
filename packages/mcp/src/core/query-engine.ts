/**
 * GID Query Engine for MCP Server
 */

import { GIDGraph } from './graph.js';
import { ImpactResult, DependencyResult, CommonCauseResult, PathResult, EdgeRelation } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Query Engine Class
// ═══════════════════════════════════════════════════════════════════════════════

export class QueryEngine {
  constructor(private graph: GIDGraph) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Impact Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  getImpact(nodeId: string): ImpactResult {
    const node = this.graph.getNodeOrThrow(nodeId);

    const directDependents = this.graph.getDependents(nodeId);
    const allDependents = this.graph.getAllDependents(nodeId);
    const transitiveDependents = allDependents.filter(
      (d) => !directDependents.includes(d)
    );

    const affectedFeatures = this.graph.getAffectedFeatures(nodeId);
    const affectedTests = this.graph.getAffectedTests(nodeId);

    // Calculate impact score based on affected components and features
    const impactScore = Math.min(
      10,
      Math.ceil(
        (directDependents.length * 2 + transitiveDependents.length + affectedFeatures.length * 3) / 3
      )
    );

    return {
      node: nodeId,
      nodeType: node.type,
      directDependents,
      transitiveDependents,
      affectedFeatures,
      affectedTests,
      impactScore,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dependency Queries
  // ═══════════════════════════════════════════════════════════════════════════

  getDependencies(nodeId: string, depth = 1): DependencyResult {
    this.graph.getNodeOrThrow(nodeId);

    const direct = this.graph.getDependencies(nodeId);
    const directWithInfo = direct.map(name => ({
      name,
      relation: 'depends_on' as EdgeRelation,
      depth: 1,
    }));

    let transitive: Array<{ name: string; relation: EdgeRelation; depth: number }> = [];

    if (depth > 1 || depth === -1) {
      const allDeps = this.graph.getAllDependencies(nodeId);
      const transitiveDeps = allDeps.filter((d) => !direct.includes(d));

      // Calculate depth for each transitive dependency
      transitive = transitiveDeps.map(name => ({
        name,
        relation: 'depends_on' as EdgeRelation,
        depth: this.calculateDepth(nodeId, name),
      }));
    }

    return {
      node: nodeId,
      dependencies: directWithInfo,
      transitiveDependencies: transitive,
    };
  }

  getDependents(nodeId: string, depth = 1): DependencyResult {
    this.graph.getNodeOrThrow(nodeId);

    const direct = this.graph.getDependents(nodeId);
    const directWithInfo = direct.map(name => ({
      name,
      relation: 'depends_on' as EdgeRelation,
      depth: 1,
    }));

    let transitive: Array<{ name: string; relation: EdgeRelation; depth: number }> = [];

    if (depth > 1 || depth === -1) {
      const allDeps = this.graph.getAllDependents(nodeId);
      const transitiveDeps = allDeps.filter((d) => !direct.includes(d));

      transitive = transitiveDeps.map(name => ({
        name,
        relation: 'depends_on' as EdgeRelation,
        depth: this.calculateReverseDepth(nodeId, name),
      }));
    }

    return {
      node: nodeId,
      dependencies: directWithInfo,
      transitiveDependencies: transitive,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Common Cause Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  getCommonCause(nodeA: string, nodeB: string): CommonCauseResult {
    this.graph.getNodeOrThrow(nodeA);
    this.graph.getNodeOrThrow(nodeB);

    const depsA = new Set([nodeA, ...this.graph.getAllDependencies(nodeA)]);
    const depsB = new Set([nodeB, ...this.graph.getAllDependencies(nodeB)]);

    const commonDependencies: string[] = [];
    for (const dep of depsA) {
      if (depsB.has(dep) && dep !== nodeA && dep !== nodeB) {
        commonDependencies.push(dep);
      }
    }

    // Sort by number of dependents (most likely root cause first)
    commonDependencies.sort((a, b) => {
      const aCount = this.graph.getDependents(a).length;
      const bCount = this.graph.getDependents(b).length;
      return bCount - aCount;
    });

    const suggestion = commonDependencies.length > 0
      ? `If both ${nodeA} and ${nodeB} fail together, check ${commonDependencies[0]} first.`
      : `No common dependencies found between ${nodeA} and ${nodeB}.`;

    return {
      nodeA,
      nodeB,
      commonDependencies,
      suggestion,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Path Finding
  // ═══════════════════════════════════════════════════════════════════════════

  findPath(from: string, to: string): PathResult | null {
    this.graph.getNodeOrThrow(from);
    this.graph.getNodeOrThrow(to);

    // BFS to find shortest path
    const queue: Array<{ node: string; path: string[]; relations: EdgeRelation[] }> = [
      { node: from, path: [from], relations: [] },
    ];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const { node, path, relations } = queue.shift()!;

      if (node === to) {
        return {
          from,
          to,
          path,
          hops: path.length - 1,
          relations,
        };
      }

      if (visited.has(node)) continue;
      visited.add(node);

      // Get all outgoing edges (not just depends_on)
      const edges = this.graph.getOutgoingEdges(node);
      for (const edge of edges) {
        if (!visited.has(edge.to)) {
          queue.push({
            node: edge.to,
            path: [...path, edge.to],
            relations: [...relations, edge.relation],
          });
        }
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature Queries
  // ═══════════════════════════════════════════════════════════════════════════

  getFeatureComponents(featureId: string): string[] {
    const node = this.graph.getNodeOrThrow(featureId);
    if (node.type !== 'Feature') {
      throw new Error(`Node "${featureId}" is not a Feature (type: ${node.type})`);
    }

    const directComponents = this.graph.getImplementingComponents(featureId);
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

  getHighCouplingNodes(threshold = 5): Array<{ nodeId: string; dependentCount: number }> {
    const results: Array<{ nodeId: string; dependentCount: number }> = [];

    for (const nodeId of this.graph.getNodeIds()) {
      const dependents = this.graph.getDependents(nodeId);
      if (dependents.length >= threshold) {
        results.push({ nodeId, dependentCount: dependents.length });
      }
    }

    return results.sort((a, b) => b.dependentCount - a.dependentCount);
  }

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

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private calculateDepth(from: string, to: string): number {
    const result = this.findPath(from, to);
    return result ? result.hops : -1;
  }

  private calculateReverseDepth(from: string, to: string): number {
    // For dependents, we need to search in reverse
    const queue: Array<{ node: string; depth: number }> = [{ node: from, depth: 0 }];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const { node, depth } = queue.shift()!;

      if (node === to) {
        return depth;
      }

      if (visited.has(node)) continue;
      visited.add(node);

      const dependents = this.graph.getDependents(node);
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          queue.push({ node: dep, depth: depth + 1 });
        }
      }
    }

    return -1;
  }
}
