/**
 * GID Metrics
 *
 * Standard Software Architecture Recovery (SAR) metrics:
 * - TurboMQ: Modularization Quality
 * - Coupling: Inter-module dependencies
 * - Cohesion: Intra-module connectivity
 *
 * References:
 * - Mancoridis et al., "Bunch: A Clustering Tool for the Recovery and Maintenance of Software System Structures"
 * - Mitchell & Mancoridis, "On the Automatic Modularization of Software Systems Using the Bunch Tool"
 */

import { GIDGraph } from './graph.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface GraphMetrics {
  turboMQ: number; // 0-1, higher is better modularization
  coupling: number; // 0-1, lower is better (less inter-module deps)
  cohesion: number; // 0-1, higher is better (more intra-module connectivity)
  modularity: number; // 0-1, combined metric

  // Raw counts for detailed analysis
  details: {
    totalNodes: number;
    totalEdges: number;
    modules: number;
    intraEdges: number; // Edges within modules
    interEdges: number; // Edges between modules
    avgFanIn: number;
    avgFanOut: number;
    maxFanIn: number;
    maxFanOut: number;
  };
}

export interface ModuleMetrics {
  moduleId: string;
  nodeCount: number;
  intraEdges: number;
  interEdgesIn: number;
  interEdgesOut: number;
  clusterFactor: number; // CF for TurboMQ
  cohesion: number;
  coupling: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Metric Calculations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate all SAR metrics for a graph
 */
export function calculateMetrics(graph: GIDGraph): GraphMetrics {
  const modules = identifyModules(graph);
  const moduleMetrics = calculateModuleMetrics(graph, modules);

  // Calculate TurboMQ (sum of cluster factors)
  const turboMQ = calculateTurboMQ(moduleMetrics);

  // Calculate average coupling and cohesion
  const { coupling, cohesion } = calculateCouplingCohesion(moduleMetrics);

  // Calculate modularity (combined metric)
  const modularity = (turboMQ + cohesion + (1 - coupling)) / 3;

  // Calculate edge statistics
  const allEdges = graph.getAllEdges();
  const nodeIds = graph.getNodeIds();

  let totalIntraEdges = 0;
  let totalInterEdges = 0;

  for (const edge of allEdges) {
    const fromModule = findModule(edge.from, modules);
    const toModule = findModule(edge.to, modules);

    if (fromModule === toModule && fromModule !== null) {
      totalIntraEdges++;
    } else {
      totalInterEdges++;
    }
  }

  // Calculate fan-in/fan-out
  const fanInOut = calculateFanInOut(graph);

  return {
    turboMQ: roundTo(turboMQ, 2),
    coupling: roundTo(coupling, 2),
    cohesion: roundTo(cohesion, 2),
    modularity: roundTo(modularity, 2),
    details: {
      totalNodes: nodeIds.length,
      totalEdges: allEdges.length,
      modules: modules.size,
      intraEdges: totalIntraEdges,
      interEdges: totalInterEdges,
      avgFanIn: roundTo(fanInOut.avgFanIn, 2),
      avgFanOut: roundTo(fanInOut.avgFanOut, 2),
      maxFanIn: fanInOut.maxFanIn,
      maxFanOut: fanInOut.maxFanOut,
    },
  };
}

/**
 * Identify modules (clusters) in the graph
 *
 * Strategy:
 * 1. If nodes have 'layer' attribute, use layer as primary grouping
 * 2. If nodes have 'component' parent, group by component
 * 3. Otherwise, group by directory path
 */
function identifyModules(graph: GIDGraph): Map<string, Set<string>> {
  const modules = new Map<string, Set<string>>();
  const nodeIds = graph.getNodeIds();

  for (const nodeId of nodeIds) {
    const node = graph.getNode(nodeId);
    if (!node) continue;

    // Determine module ID
    let moduleId: string;

    if (node.type === 'Component' || node.type === 'Feature') {
      // Components and Features are their own modules
      moduleId = nodeId;
    } else if (node.layer) {
      // Group by layer if available
      moduleId = `layer:${node.layer}`;
    } else if (node.path) {
      // Group by directory
      const dir = getDirectory(node.path);
      moduleId = `dir:${dir}`;
    } else {
      // Fallback: each node is its own module
      moduleId = nodeId;
    }

    if (!modules.has(moduleId)) {
      modules.set(moduleId, new Set());
    }
    modules.get(moduleId)!.add(nodeId);
  }

  return modules;
}

/**
 * Calculate metrics for each module
 */
function calculateModuleMetrics(
  graph: GIDGraph,
  modules: Map<string, Set<string>>
): ModuleMetrics[] {
  const results: ModuleMetrics[] = [];
  const allEdges = graph.getAllEdges();

  for (const [moduleId, nodes] of modules) {
    let intraEdges = 0;
    let interEdgesIn = 0;
    let interEdgesOut = 0;

    for (const edge of allEdges) {
      const fromInModule = nodes.has(edge.from);
      const toInModule = nodes.has(edge.to);

      if (fromInModule && toInModule) {
        intraEdges++;
      } else if (fromInModule && !toInModule) {
        interEdgesOut++;
      } else if (!fromInModule && toInModule) {
        interEdgesIn++;
      }
    }

    // Calculate Cluster Factor (CF) for TurboMQ
    // CF = 0 if no edges, otherwise 2 * intra / (2 * intra + inter_in + inter_out)
    const totalInter = interEdgesIn + interEdgesOut;
    const clusterFactor =
      intraEdges === 0 && totalInter === 0
        ? 0
        : (2 * intraEdges) / (2 * intraEdges + totalInter);

    // Calculate cohesion: intra-edges / possible intra-edges
    const n = nodes.size;
    const maxIntraEdges = n * (n - 1); // Directed graph
    const cohesion = maxIntraEdges === 0 ? 1 : intraEdges / maxIntraEdges;

    // Calculate coupling: inter-edges / total edges involving this module
    const totalModuleEdges = intraEdges + interEdgesIn + interEdgesOut;
    const coupling = totalModuleEdges === 0 ? 0 : totalInter / totalModuleEdges;

    results.push({
      moduleId,
      nodeCount: nodes.size,
      intraEdges,
      interEdgesIn,
      interEdgesOut,
      clusterFactor,
      cohesion,
      coupling,
    });
  }

  return results;
}

/**
 * Calculate TurboMQ (Turbo Modularization Quality)
 *
 * TurboMQ = (1/k) * sum(CF_i) for all k modules
 * where CF_i is the cluster factor of module i
 */
function calculateTurboMQ(moduleMetrics: ModuleMetrics[]): number {
  if (moduleMetrics.length === 0) return 0;

  const sumCF = moduleMetrics.reduce((sum, m) => sum + m.clusterFactor, 0);
  return sumCF / moduleMetrics.length;
}

/**
 * Calculate average coupling and cohesion across modules
 */
function calculateCouplingCohesion(moduleMetrics: ModuleMetrics[]): {
  coupling: number;
  cohesion: number;
} {
  if (moduleMetrics.length === 0) {
    return { coupling: 0, cohesion: 0 };
  }

  const avgCoupling =
    moduleMetrics.reduce((sum, m) => sum + m.coupling, 0) / moduleMetrics.length;
  const avgCohesion =
    moduleMetrics.reduce((sum, m) => sum + m.cohesion, 0) / moduleMetrics.length;

  return { coupling: avgCoupling, cohesion: avgCohesion };
}

/**
 * Calculate fan-in and fan-out statistics
 */
function calculateFanInOut(graph: GIDGraph): {
  avgFanIn: number;
  avgFanOut: number;
  maxFanIn: number;
  maxFanOut: number;
} {
  const nodeIds = graph.getNodeIds();
  if (nodeIds.length === 0) {
    return { avgFanIn: 0, avgFanOut: 0, maxFanIn: 0, maxFanOut: 0 };
  }

  let totalFanIn = 0;
  let totalFanOut = 0;
  let maxFanIn = 0;
  let maxFanOut = 0;

  for (const nodeId of nodeIds) {
    const fanIn = graph.getDependents(nodeId).length;
    const fanOut = graph.getDependencies(nodeId).length;

    totalFanIn += fanIn;
    totalFanOut += fanOut;
    maxFanIn = Math.max(maxFanIn, fanIn);
    maxFanOut = Math.max(maxFanOut, fanOut);
  }

  return {
    avgFanIn: totalFanIn / nodeIds.length,
    avgFanOut: totalFanOut / nodeIds.length,
    maxFanIn,
    maxFanOut,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

function findModule(nodeId: string, modules: Map<string, Set<string>>): string | null {
  for (const [moduleId, nodes] of modules) {
    if (nodes.has(nodeId)) {
      return moduleId;
    }
  }
  return null;
}

function getDirectory(filePath: string): string {
  const parts = filePath.split('/');
  parts.pop(); // Remove filename
  return parts.join('/') || '.';
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Display Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format metrics for console display
 */
export function formatMetrics(metrics: GraphMetrics): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('📊 Architecture Metrics');
  lines.push('═'.repeat(50));

  // Main metrics with interpretations
  lines.push('');
  lines.push(`  TurboMQ:    ${formatScore(metrics.turboMQ)} ${interpretTurboMQ(metrics.turboMQ)}`);
  lines.push(`  Coupling:   ${formatScore(metrics.coupling, true)} ${interpretCoupling(metrics.coupling)}`);
  lines.push(`  Cohesion:   ${formatScore(metrics.cohesion)} ${interpretCohesion(metrics.cohesion)}`);
  lines.push(`  Modularity: ${formatScore(metrics.modularity)} ${interpretModularity(metrics.modularity)}`);

  // Details
  lines.push('');
  lines.push('  Details:');
  lines.push(`    Nodes: ${metrics.details.totalNodes} | Edges: ${metrics.details.totalEdges} | Modules: ${metrics.details.modules}`);
  lines.push(`    Intra-module edges: ${metrics.details.intraEdges} | Inter-module edges: ${metrics.details.interEdges}`);
  lines.push(`    Avg fan-in: ${metrics.details.avgFanIn} | Avg fan-out: ${metrics.details.avgFanOut}`);
  lines.push(`    Max fan-in: ${metrics.details.maxFanIn} | Max fan-out: ${metrics.details.maxFanOut}`);

  return lines.join('\n');
}

function formatScore(value: number, lowerIsBetter = false): string {
  // Color coding: green >= 0.7, yellow >= 0.4, red < 0.4
  // For metrics where lower is better (coupling), invert the logic
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';
  const red = '\x1b[31m';
  const reset = '\x1b[0m';

  let color: string;
  if (lowerIsBetter) {
    // Lower is better (coupling)
    color = value <= 0.3 ? green : value <= 0.6 ? yellow : red;
  } else {
    // Higher is better (TurboMQ, cohesion, modularity)
    color = value >= 0.7 ? green : value >= 0.4 ? yellow : red;
  }
  return `${color}${value.toFixed(2)}${reset}`;
}

function interpretTurboMQ(value: number): string {
  if (value >= 0.7) return '(excellent modularity)';
  if (value >= 0.5) return '(good modularity)';
  if (value >= 0.3) return '(moderate modularity)';
  return '(poor modularity - consider restructuring)';
}

function interpretCoupling(value: number): string {
  // For coupling, lower is better
  if (value <= 0.3) return '(low coupling - good)';
  if (value <= 0.5) return '(moderate coupling)';
  if (value <= 0.7) return '(high coupling - review dependencies)';
  return '(very high coupling - refactor recommended)';
}

function interpretCohesion(value: number): string {
  if (value >= 0.7) return '(high cohesion - good)';
  if (value >= 0.5) return '(moderate cohesion)';
  if (value >= 0.3) return '(low cohesion - modules may be too broad)';
  return '(very low cohesion - consider splitting modules)';
}

function interpretModularity(value: number): string {
  if (value >= 0.7) return '(well-structured)';
  if (value >= 0.5) return '(reasonably structured)';
  if (value >= 0.3) return '(needs improvement)';
  return '(poorly structured - significant refactoring needed)';
}
