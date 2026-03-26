/**
 * GID Validator for MCP Server
 */

import { GIDGraph } from './graph.js';
import { ValidationIssue, ValidationResult, Edge } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface ValidatorConfig {
  highCouplingThreshold?: number;
  enabledRules?: string[];
  disabledRules?: string[];
}

type RuleFunction = (graph: GIDGraph, config: ValidatorConfig) => ValidationIssue[];

interface BuiltInRule {
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  check: RuleFunction;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Built-in Rules
// ═══════════════════════════════════════════════════════════════════════════════

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

  validate(graph: GIDGraph): ValidationResult {
    const issues: ValidationIssue[] = [];

    for (const rule of BUILT_IN_RULES) {
      if (this.config.disabledRules?.includes(rule.name)) {
        continue;
      }

      if (this.config.enabledRules && !this.config.enabledRules.includes(rule.name)) {
        continue;
      }

      const ruleIssues = rule.check(graph, this.config);
      issues.push(...ruleIssues);
    }

    const summary = {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    };

    const criticalWarnings = issues.filter((i) =>
      i.severity === 'warning' &&
      (i.rule === 'layer-dependency-direction' || i.rule === 'high-coupling-warning')
    ).length;
    const minorWarnings = summary.warnings - criticalWarnings;

    const penalty = summary.errors * 10 + criticalWarnings * 5 + minorWarnings * 2 + summary.info * 1;
    const healthScore = Math.max(0, 100 - penalty);

    // TODO: Modularity metrics disabled - see types.ts for discussion
    // const metrics = calculateModularityMetrics(graph);

    return {
      passed: summary.errors === 0,
      healthScore,
      // metrics,  // TODO: Enable for modular architectures
      issues,
      summary,
    };
  }

  static getRules(): Array<{ name: string; description: string; severity: 'error' | 'warning' | 'info' }> {
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
        const cycleStart = path.indexOf(dep);
        const cycle = cycleStart >= 0 ? path.slice(cycleStart) : [...path, dep];
        cycle.push(dep);
        cycles.push(cycle);
        return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  for (const nodeId of graph.getNodeIds()) {
    if (!visited.has(nodeId)) {
      dfs(nodeId, [nodeId]);
    }
  }

  const reportedCycles = new Set<string>();
  for (const cycle of cycles) {
    const cycleKey = [...cycle].sort().join(',');
    if (!reportedCycles.has(cycleKey)) {
      reportedCycles.add(cycleKey);
      issues.push({
        rule: 'no-circular-dependency',
        severity: 'error',
        message: `Circular dependency detected: ${cycle.join(' -> ')}`,
        nodes: cycle,
        suggestion: 'Consider introducing an event bus or interface to break the cycle',
      });
    }
  }

  return issues;
}

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

function checkFeatureImplementation(graph: GIDGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [featureId] of graph.getFeatures()) {
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

function checkComponentImplementsFeature(graph: GIDGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [compId, node] of graph.getComponents()) {
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

    if (fromLayer > toLayer) {
      if (fromNode.layer === 'domain' && toNode.layer === 'infrastructure') {
        continue;
      }

      issues.push({
        rule: 'layer-dependency-direction',
        severity: 'warning',
        message: `Layer violation: ${fromNode.layer} component "${edge.from}" depends on ${toNode.layer} component "${edge.to}"`,
        nodes: [edge.from, edge.to],
        suggestion: `Dependencies should flow: interface -> application -> domain -> infrastructure`,
      });
    }
  }

  return issues;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Modularity Metrics Calculation (DISABLED)
// ═══════════════════════════════════════════════════════════════════════════════
// TODO: TurboMQ metrics disabled - needs further discussion
// TurboMQ is designed for modular architectures (microservices) where intra-module
// cohesion is expected. For layered architectures (controller -> service -> repository),
// inter-layer dependencies are the DESIGN GOAL, making TurboMQ less suitable.
// See: planning/METRICS-DISCUSSION.md
//
// export function calculateModularityMetrics(graph: GIDGraph): ModularityMetrics {
//   ... (code preserved in git history)
// }
