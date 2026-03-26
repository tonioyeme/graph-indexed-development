/**
 * GID Validator
 *
 * Validates graph integrity rules:
 * - No circular dependencies
 * - No orphan nodes
 * - No high coupling (configurable threshold)
 * - Features must have implementations
 * - Layer dependency direction
 */

import { GIDGraph } from './graph.js';
import { Node, Edge, IntegrityRule } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type RuleSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  rule: string;
  severity: RuleSeverity;
  message: string;
  nodes?: string[];
  edges?: Edge[];
  suggestion?: string;
}

export interface ValidationSummary {
  passed: boolean;
  issues: ValidationIssue[];
  stats: {
    errors: number;
    warnings: number;
    info: number;
    total: number;
  };
  healthScore: number; // 0-100
}

export interface ValidatorConfig {
  highCouplingThreshold?: number; // Default: 5
  enabledRules?: string[]; // If specified, only run these rules
  disabledRules?: string[]; // Rules to skip
}

// ═══════════════════════════════════════════════════════════════════════════════
// Built-in Rules
// ═══════════════════════════════════════════════════════════════════════════════

type RuleFunction = (graph: GIDGraph, config: ValidatorConfig) => ValidationIssue[];

interface BuiltInRule {
  name: string;
  description: string;
  severity: RuleSeverity;
  check: RuleFunction;
}

const BUILT_IN_RULES: BuiltInRule[] = [
  {
    name: 'no-circular-dependency',
    description: 'No circular dependencies in depends_on edges',
    severity: 'error',
    check: checkCircularDependencies,
  },
  {
    name: 'no-orphan-nodes',
    description: 'All nodes should have at least one edge',
    severity: 'warning',
    check: checkOrphanNodes,
  },
  {
    name: 'feature-has-implementation',
    description: 'Every Feature should have at least one implementing Component',
    severity: 'warning',
    check: checkFeatureImplementation,
  },
  {
    name: 'component-implements-feature',
    description: 'Application-layer Components should implement at least one Feature',
    severity: 'info',
    check: checkComponentImplementsFeature,
  },
  {
    name: 'high-coupling-warning',
    description: 'Components with many dependents may be bottlenecks',
    severity: 'warning',
    check: checkHighCoupling,
  },
  {
    name: 'layer-dependency-direction',
    description: 'Dependencies should follow layer hierarchy',
    severity: 'warning',
    check: checkLayerDependencies,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Validator Class
// ═══════════════════════════════════════════════════════════════════════════════

export class Validator {
  private config: ValidatorConfig;

  constructor(config: ValidatorConfig = {}) {
    this.config = {
      highCouplingThreshold: 5,
      ...config,
    };
  }

  /**
   * Run all enabled validation rules
   */
  validate(graph: GIDGraph): ValidationSummary {
    const issues: ValidationIssue[] = [];

    for (const rule of BUILT_IN_RULES) {
      // Check if rule is disabled
      if (this.config.disabledRules?.includes(rule.name)) {
        continue;
      }

      // Check if only specific rules are enabled
      if (this.config.enabledRules && !this.config.enabledRules.includes(rule.name)) {
        continue;
      }

      // Run the rule
      const ruleIssues = rule.check(graph, this.config);
      issues.push(...ruleIssues);
    }

    // Calculate stats
    const stats = {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
      total: issues.length,
    };

    // Calculate health score (0-100)
    // Use a more nuanced scoring system:
    // - Errors (circular deps, critical issues): -10 each
    // - Critical warnings (layer violations): -5 each
    // - Minor warnings (orphan nodes, missing impl): -2 each
    // - Info: -1 each
    const criticalWarnings = issues.filter((i) =>
      i.severity === 'warning' &&
      (i.rule === 'layer-dependency-direction' || i.rule === 'high-coupling-warning')
    ).length;
    const minorWarnings = stats.warnings - criticalWarnings;

    const penalty = stats.errors * 10 + criticalWarnings * 5 + minorWarnings * 2 + stats.info * 1;
    const healthScore = Math.max(0, 100 - penalty);

    return {
      passed: stats.errors === 0,
      issues,
      stats,
      healthScore,
    };
  }

  /**
   * Get list of available rules
   */
  static getRules(): Array<{ name: string; description: string; severity: RuleSeverity }> {
    return BUILT_IN_RULES.map((r) => ({
      name: r.name,
      description: r.description,
      severity: r.severity,
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rule Implementations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect circular dependencies using DFS
 */
function checkCircularDependencies(graph: GIDGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(nodeId: string, path: string[]): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);

    const dependencies = graph.getDependencies(nodeId);

    for (const dep of dependencies) {
      if (!visited.has(dep)) {
        if (dfs(dep, [...path, dep])) {
          return true;
        }
      } else if (recursionStack.has(dep)) {
        // Found a cycle
        const cycleStart = path.indexOf(dep);
        const cycle = cycleStart >= 0 ? path.slice(cycleStart) : [...path, dep];
        cycle.push(dep); // Complete the cycle
        cycles.push(cycle);
        return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  // Run DFS from each unvisited node
  for (const nodeId of graph.getNodeIds()) {
    if (!visited.has(nodeId)) {
      dfs(nodeId, [nodeId]);
    }
  }

  // Report unique cycles
  const reportedCycles = new Set<string>();
  for (const cycle of cycles) {
    const cycleKey = [...cycle].sort().join(',');
    if (!reportedCycles.has(cycleKey)) {
      reportedCycles.add(cycleKey);
      issues.push({
        rule: 'no-circular-dependency',
        severity: 'error',
        message: `Circular dependency detected: ${cycle.join(' → ')}`,
        nodes: cycle,
        suggestion: 'Consider introducing an event bus or interface to break the cycle',
      });
    }
  }

  return issues;
}

/**
 * Find nodes with no edges (orphans)
 */
function checkOrphanNodes(graph: GIDGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const nodeId of graph.getNodeIds()) {
    const incoming = graph.getIncomingEdges(nodeId);
    const outgoing = graph.getOutgoingEdges(nodeId);

    if (incoming.length === 0 && outgoing.length === 0) {
      const node = graph.getNode(nodeId)!;
      issues.push({
        rule: 'no-orphan-nodes',
        severity: 'warning',
        message: `Orphan node: "${nodeId}" has no connections`,
        nodes: [nodeId],
        suggestion:
          node.type === 'Feature'
            ? 'Add Components that implement this Feature'
            : 'Connect this node to the graph or remove it',
      });
    }
  }

  return issues;
}

/**
 * Check that Features have at least one implementing Component
 */
function checkFeatureImplementation(graph: GIDGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [featureId, node] of graph.getFeatures()) {
    const implementers = graph.getImplementingComponents(featureId);

    if (implementers.length === 0) {
      issues.push({
        rule: 'feature-has-implementation',
        severity: 'warning',
        message: `Feature "${featureId}" has no implementing Components`,
        nodes: [featureId],
        suggestion: 'Add a Component with an "implements" edge to this Feature',
      });
    }
  }

  return issues;
}

/**
 * Check that application-layer Components implement at least one Feature
 */
function checkComponentImplementsFeature(graph: GIDGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [compId, node] of graph.getComponents()) {
    // Only check application-layer components
    if (node.layer && node.layer !== 'application') {
      continue;
    }

    const features = graph.getImplementedFeatures(compId);

    if (features.length === 0) {
      issues.push({
        rule: 'component-implements-feature',
        severity: 'info',
        message: `Component "${compId}" doesn't implement any Feature`,
        nodes: [compId],
        suggestion: 'Consider adding an "implements" edge to a Feature',
      });
    }
  }

  return issues;
}

/**
 * Find components with too many dependents (potential bottlenecks)
 */
function checkHighCoupling(graph: GIDGraph, config: ValidatorConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const threshold = config.highCouplingThreshold ?? 5;

  for (const nodeId of graph.getNodeIds()) {
    const dependents = graph.getDependents(nodeId);

    if (dependents.length >= threshold) {
      issues.push({
        rule: 'high-coupling-warning',
        severity: 'warning',
        message: `"${nodeId}" has ${dependents.length} dependents (threshold: ${threshold})`,
        nodes: [nodeId, ...dependents],
        suggestion: 'Consider splitting this component or introducing an abstraction layer',
      });
    }
  }

  return issues;
}

/**
 * Check that dependencies follow layer hierarchy
 * interface → application → domain → infrastructure
 *
 * Note: domain can depend on infrastructure (for persistence)
 */
function checkLayerDependencies(graph: GIDGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const layerOrder: Record<string, number> = {
    interface: 0,
    application: 1,
    domain: 2,
    infrastructure: 3,
  };

  for (const edge of graph.getAllEdges()) {
    if (edge.relation !== 'depends_on') continue;

    const fromNode = graph.getNode(edge.from);
    const toNode = graph.getNode(edge.to);

    if (!fromNode?.layer || !toNode?.layer) continue;

    const fromLayer = layerOrder[fromNode.layer];
    const toLayer = layerOrder[toNode.layer];

    // Check for upward dependencies (lower layer depending on higher layer)
    // Exception: domain can depend on infrastructure
    if (fromLayer > toLayer) {
      // Allow domain → infrastructure
      if (fromNode.layer === 'domain' && toNode.layer === 'infrastructure') {
        continue;
      }

      issues.push({
        rule: 'layer-dependency-direction',
        severity: 'warning',
        message: `Layer violation: ${fromNode.layer} component "${edge.from}" depends on ${toNode.layer} component "${edge.to}"`,
        nodes: [edge.from, edge.to],
        suggestion: `Dependencies should flow: interface → application → domain → infrastructure`,
      });
    }
  }

  return issues;
}
