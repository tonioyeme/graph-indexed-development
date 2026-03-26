/**
 * GID Advise Command
 *
 * Analyze graph and suggest improvements based on validation and heuristics.
 */

import * as path from 'node:path';
import { loadGraph, findGraphFile } from '../core/parser.js';
import { GIDGraph } from '../core/graph.js';
import { Validator } from '../core/validator.js';
import { QueryEngine } from '../core/query-engine.js';
import { detectFilePatterns } from '../analyzers/code-analysis.js';
import { calculateMetrics, formatMetrics, GraphMetrics } from '../core/metrics.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface Suggestion {
  level: 'deterministic' | 'heuristic';
  type: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
  nodeId?: string;
  fix?: Record<string, unknown>;
  codeContext?: Record<string, unknown>;
}

interface AdviseOptions {
  level?: 'deterministic' | 'heuristic' | 'all';
  includeContext?: boolean;
  json?: boolean;
  graphPath?: string;
  metrics?: boolean; // Show SAR metrics (TurboMQ, Coupling, Cohesion)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

function calculateMaxChainDepth(graph: GIDGraph, nodeId: string, visited = new Set<string>()): number {
  if (visited.has(nodeId)) return 0;
  visited.add(nodeId);

  const deps = graph.getDependencies(nodeId);
  if (deps.length === 0) return 0;

  let maxDepth = 0;
  for (const dep of deps) {
    const depth = calculateMaxChainDepth(graph, dep, new Set(visited));
    maxDepth = Math.max(maxDepth, depth);
  }

  return 1 + maxDepth;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Analysis Logic
// ═══════════════════════════════════════════════════════════════════════════════

interface AnalysisResult {
  suggestions: Suggestion[];
  healthScore: number;
  passed: boolean;
}

function analyzeGraph(
  graphData: ReturnType<typeof loadGraph>,
  level: string,
  includeContext: boolean
): AnalysisResult {
  const graph = new GIDGraph(graphData);
  const validator = new Validator();
  const engine = new QueryEngine(graph);

  const validation = validator.validate(graph);
  const suggestions: Suggestion[] = [];

  // Level 1: Deterministic suggestions from validation issues
  if (level === 'deterministic' || level === 'all') {
    for (const issue of validation.issues) {
      const suggestion: Suggestion = {
        level: 'deterministic',
        type: issue.rule,
        severity: issue.severity,
        message: issue.message,
        suggestion: issue.suggestion,
        nodeId: issue.nodes?.[0],
      };

      // Add code context if requested
      if (includeContext && suggestion.nodeId) {
        const node = graphData.nodes[suggestion.nodeId];
        if (node?.path) {
          try {
            const patterns = detectFilePatterns(node.path);
            suggestion.codeContext = { path: node.path, patterns };
          } catch {
            // Ignore if file can't be analyzed
          }
        }
      }

      suggestions.push(suggestion);
    }

    // Check for missing implements edges
    const features = graph.getFeatures();

    for (const [featureId] of features) {
      const implementers = graph.getImplementingComponents(featureId);
      if (implementers.length === 0) {
        suggestions.push({
          level: 'deterministic',
          type: 'missing-implements',
          severity: 'warning',
          message: `Feature "${featureId}" has no implementing components`,
          suggestion: 'Add an implements edge from a component to this feature',
          nodeId: featureId,
          fix: {
            action: 'add_edge',
            from: '{{component}}',
            to: featureId,
            relation: 'implements',
          },
        });
      }
    }

    // Check for orphan nodes
    for (const nodeId of Object.keys(graphData.nodes)) {
      const inEdges = graphData.edges.filter(e => e.to === nodeId);
      const outEdges = graphData.edges.filter(e => e.from === nodeId);

      if (inEdges.length === 0 && outEdges.length === 0) {
        suggestions.push({
          level: 'deterministic',
          type: 'orphan-node',
          severity: 'warning',
          message: `Node "${nodeId}" has no connections`,
          suggestion: 'Connect to related nodes or remove if unused',
          nodeId,
        });
      }
    }
  }

  // Level 2: Heuristic suggestions
  if (level === 'heuristic' || level === 'all') {
    // High coupling analysis
    const highCoupling = engine.getHighCouplingNodes(5);
    for (const { nodeId, dependentCount } of highCoupling) {
      const suggestion: Suggestion = {
        level: 'heuristic',
        type: 'high-coupling',
        severity: 'warning',
        message: `${nodeId} has ${dependentCount} dependents (high coupling)`,
        suggestion: 'Consider splitting into smaller components or introducing an abstraction layer',
        nodeId,
      };

      if (includeContext) {
        const node = graphData.nodes[nodeId];
        if (node?.path) {
          try {
            const patterns = detectFilePatterns(node.path);
            suggestion.codeContext = { path: node.path, patterns };
          } catch {
            // Ignore
          }
        }
      }

      suggestions.push(suggestion);
    }

    // Deep dependency chains
    for (const nodeId of Object.keys(graphData.nodes)) {
      const maxChain = calculateMaxChainDepth(graph, nodeId);
      if (maxChain > 4) {
        suggestions.push({
          level: 'heuristic',
          type: 'deep-chain',
          severity: 'info',
          message: `${nodeId} has a dependency chain depth of ${maxChain}`,
          suggestion: 'Consider flattening the dependency structure',
          nodeId,
        });
      }
    }

    // Missing layer assignments
    for (const [nodeId, node] of Object.entries(graphData.nodes)) {
      if (!node.layer && (node.type === 'Component' || node.type === 'File')) {
        suggestions.push({
          level: 'heuristic',
          type: 'missing-layer',
          severity: 'info',
          message: `${nodeId} has no layer assigned`,
          suggestion: 'Run `gid semantify` to automatically assign layers, or set manually',
          nodeId,
        });
      }
    }

    // Missing descriptions
    for (const [nodeId, node] of Object.entries(graphData.nodes)) {
      if (!node.description && node.type !== 'File') {
        suggestions.push({
          level: 'heuristic',
          type: 'missing-description',
          severity: 'info',
          message: `${nodeId} has no description`,
          suggestion: 'Add a description to improve graph documentation',
          nodeId,
        });
      }
    }
  }

  // Sort by severity (errors first, then warnings, then info)
  const severityOrder = { error: 0, warning: 1, info: 2 };
  suggestions.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    suggestions,
    healthScore: validation.healthScore,
    passed: validation.passed,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Display Functions
// ═══════════════════════════════════════════════════════════════════════════════

function formatSuggestion(suggestion: Suggestion, index: number): string {
  const icons = {
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
  };

  const levelBadge = suggestion.level === 'deterministic' ? '[D]' : '[H]';

  let output = `\n${index + 1}. ${icons[suggestion.severity]} ${levelBadge} ${suggestion.type}`;
  output += `\n   ${suggestion.message}`;

  if (suggestion.suggestion) {
    output += `\n   💡 ${suggestion.suggestion}`;
  }

  if (suggestion.nodeId) {
    output += `\n   📍 Node: ${suggestion.nodeId}`;
  }

  if (suggestion.codeContext) {
    const ctx = suggestion.codeContext as { path: string; patterns: Array<{ pattern: string }> };
    if (ctx.patterns && ctx.patterns.length > 0) {
      output += `\n   🏷️  Patterns: ${ctx.patterns.map(p => p.pattern).join(', ')}`;
    }
  }

  return output;
}

function displaySummary(result: AnalysisResult): void {
  const { suggestions, healthScore } = result;
  const errors = suggestions.filter(s => s.severity === 'error').length;
  const warnings = suggestions.filter(s => s.severity === 'warning').length;
  const infos = suggestions.filter(s => s.severity === 'info').length;

  console.log('\n📊 Summary:');
  console.log(`   ❌ Errors:   ${errors}`);
  console.log(`   ⚠️  Warnings: ${warnings}`);
  console.log(`   ℹ️  Info:     ${infos}`);
  console.log(`   Total:      ${suggestions.length}`);

  // Health score with color
  const scoreColor = healthScore >= 80 ? '\x1b[32m' : healthScore >= 50 ? '\x1b[33m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`\n💪 Health Score: ${scoreColor}${healthScore}/100${reset}`);

  if (errors > 0) {
    console.log('\n⛔ Graph has errors that should be fixed.');
  } else if (warnings > 0) {
    console.log('\n⚠️  Graph has warnings to review.');
  } else if (infos > 0) {
    console.log('\n✅ Graph looks good! Some minor suggestions available.');
  } else {
    console.log('\n🎉 Graph is in excellent shape!');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Command
// ═══════════════════════════════════════════════════════════════════════════════

export function runAdvise(options: AdviseOptions): void {
  const graphPath = options.graphPath ?? findGraphFile();
  if (!graphPath) {
    console.error('❌ No graph.yml found. Run `gid init` or `gid extract` first.');
    process.exit(1);
  }

  const level = options.level ?? 'all';
  const includeContext = options.includeContext ?? false;
  const showMetrics = options.metrics ?? false;

  console.log(`\n🔍 Analyzing graph (level: ${level})...`);

  // Load graph
  const graphData = loadGraph(graphPath);
  const graph = new GIDGraph(graphData);

  // Calculate SAR metrics if requested
  let metrics: GraphMetrics | null = null;
  if (showMetrics) {
    metrics = calculateMetrics(graph);
  }

  // Analyze and generate suggestions
  const result = analyzeGraph(graphData, level, includeContext);
  const { suggestions, healthScore } = result;

  // Output as JSON if requested
  if (options.json) {
    const output: Record<string, unknown> = {
      healthScore,
      suggestions,
      summary: {
        errors: suggestions.filter(s => s.severity === 'error').length,
        warnings: suggestions.filter(s => s.severity === 'warning').length,
        info: suggestions.filter(s => s.severity === 'info').length,
        total: suggestions.length,
      },
    };

    if (metrics) {
      output.metrics = metrics;
    }

    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Display metrics if requested
  if (metrics) {
    console.log(formatMetrics(metrics));
  }

  if (suggestions.length === 0) {
    const scoreColor = healthScore >= 80 ? '\x1b[32m' : healthScore >= 50 ? '\x1b[33m' : '\x1b[31m';
    const reset = '\x1b[0m';
    console.log(`\n🎉 No issues found. Health Score: ${scoreColor}${healthScore}/100${reset}`);
    return;
  }

  // Display suggestions
  console.log('\n📋 Suggestions:');
  for (let i = 0; i < suggestions.length; i++) {
    console.log(formatSuggestion(suggestions[i], i));
  }

  displaySummary(result);

  console.log('\n💡 Tips:');
  console.log('   • Run `gid semantify` to auto-fix layer and type issues');
  console.log('   • Use --include-context for code pattern analysis');
  if (!showMetrics) {
    console.log('   • Use --metrics for detailed architecture metrics (TurboMQ, Coupling, Cohesion)');
  }
}
