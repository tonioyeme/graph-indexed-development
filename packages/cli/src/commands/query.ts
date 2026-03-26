/**
 * gid query commands
 *
 * Query the dependency graph for impact analysis, dependencies, etc.
 */

import chalk from 'chalk';
import { loadGraph, GIDGraph, QueryEngine, GIDError, ImpactResult, DependencyResult, CommonCauseResult } from '../core/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Impact Query
// ═══════════════════════════════════════════════════════════════════════════════

export function runImpactQuery(nodeId: string, graphPath?: string): void {
  try {
    const graphData = loadGraph(graphPath);
    const graph = new GIDGraph(graphData);
    const engine = new QueryEngine(graph);

    const result = engine.getImpact(nodeId);
    printImpactResult(result);
  } catch (err) {
    handleError(err);
  }
}

function printImpactResult(result: ImpactResult): void {
  console.log();
  console.log(chalk.bold(`Impact Analysis for ${chalk.cyan(result.node)}`));
  console.log(chalk.dim('═'.repeat(50)));
  console.log();

  // Node type
  console.log(`Type: ${chalk.yellow(result.nodeType)}`);
  console.log();

  // Direct dependents
  console.log(chalk.bold('Direct dependents') + chalk.dim(` (${result.directDependents.length}):`));
  if (result.directDependents.length === 0) {
    console.log(chalk.dim('  (none)'));
  } else {
    for (const [i, dep] of result.directDependents.entries()) {
      const prefix = i === result.directDependents.length - 1 ? '└──' : '├──';
      console.log(`  ${prefix} ${dep}`);
    }
  }
  console.log();

  // Transitive dependents
  if (result.transitiveDependents.length > 0) {
    console.log(chalk.bold('Transitive dependents') + chalk.dim(` (${result.transitiveDependents.length}):`));
    for (const [i, dep] of result.transitiveDependents.entries()) {
      const prefix = i === result.transitiveDependents.length - 1 ? '└──' : '├──';
      console.log(`  ${prefix} ${chalk.dim(dep)}`);
    }
    console.log();
  }

  // Affected features
  console.log(chalk.bold('Affected Features') + chalk.dim(` (${result.affectedFeatures.length}):`));
  if (result.affectedFeatures.length === 0) {
    console.log(chalk.dim('  (none)'));
  } else {
    for (const [i, feature] of result.affectedFeatures.entries()) {
      const prefix = i === result.affectedFeatures.length - 1 ? '└──' : '├──';
      console.log(`  ${prefix} ${chalk.magenta(feature)}`);
    }
  }
  console.log();

  // Affected tests
  if (result.affectedTests.length > 0) {
    console.log(chalk.bold('Tests to run') + chalk.dim(` (${result.affectedTests.length}):`));
    for (const [i, test] of result.affectedTests.entries()) {
      const prefix = i === result.affectedTests.length - 1 ? '└──' : '├──';
      console.log(`  ${prefix} ${chalk.green(test)}`);
    }
    console.log();
  }

  // Summary
  const totalAffected = result.directDependents.length + result.transitiveDependents.length;
  if (totalAffected > 0) {
    console.log(chalk.yellow(`⚠ Changes to ${result.node} may affect ${totalAffected} component(s)`));
  } else {
    console.log(chalk.green(`✓ No other components depend on ${result.node}`));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dependencies Query
// ═══════════════════════════════════════════════════════════════════════════════

export function runDepsQuery(nodeId: string, options: { reverse?: boolean; graphPath?: string } = {}): void {
  try {
    const graphData = loadGraph(options.graphPath);
    const graph = new GIDGraph(graphData);
    const engine = new QueryEngine(graph);

    const result = options.reverse
      ? engine.getDependents(nodeId)
      : engine.getDependencies(nodeId);

    printDependencyResult(result, options.reverse ?? false);
  } catch (err) {
    handleError(err);
  }
}

function printDependencyResult(result: DependencyResult, reverse: boolean): void {
  const direction = reverse ? 'Dependents of' : 'Dependencies of';

  console.log();
  console.log(chalk.bold(`${direction} ${chalk.cyan(result.node)}`));
  console.log(chalk.dim('═'.repeat(50)));
  console.log();

  // Direct
  console.log(chalk.bold('Direct') + chalk.dim(` (${result.direct.length}):`));
  if (result.direct.length === 0) {
    console.log(chalk.dim('  (none)'));
  } else {
    for (const [i, dep] of result.direct.entries()) {
      const prefix = i === result.direct.length - 1 ? '└──' : '├──';
      console.log(`  ${prefix} ${dep}`);
    }
  }
  console.log();

  // Transitive
  if (result.transitive.length > 0) {
    console.log(chalk.bold('Transitive') + chalk.dim(` (${result.transitive.length}):`));
    for (const [i, dep] of result.transitive.entries()) {
      const prefix = i === result.transitive.length - 1 ? '└──' : '├──';
      console.log(`  ${prefix} ${chalk.dim(dep)}`);
    }
    console.log();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Common Cause Query
// ═══════════════════════════════════════════════════════════════════════════════

export function runCommonCauseQuery(nodeA: string, nodeB: string, graphPath?: string): void {
  try {
    const graphData = loadGraph(graphPath);
    const graph = new GIDGraph(graphData);
    const engine = new QueryEngine(graph);

    const result = engine.getCommonCause(nodeA, nodeB);
    printCommonCauseResult(result);
  } catch (err) {
    handleError(err);
  }
}

function printCommonCauseResult(result: CommonCauseResult): void {
  console.log();
  console.log(chalk.bold('Common Cause Analysis'));
  console.log(chalk.dim('═'.repeat(50)));
  console.log();

  console.log(`Nodes: ${chalk.cyan(result.nodeA)} and ${chalk.cyan(result.nodeB)}`);
  console.log();

  console.log(chalk.bold('Shared dependencies') + chalk.dim(` (${result.commonDependencies.length}):`));
  if (result.commonDependencies.length === 0) {
    console.log(chalk.dim('  (none - these nodes have no common dependencies)'));
  } else {
    for (const [i, dep] of result.commonDependencies.entries()) {
      const prefix = i === result.commonDependencies.length - 1 ? '└──' : '├──';
      console.log(`  ${prefix} ${chalk.yellow(dep)}`);
    }
    console.log();
    console.log(chalk.dim('If both nodes are affected, check these common dependencies first.'));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Path Query
// ═══════════════════════════════════════════════════════════════════════════════

export function runPathQuery(from: string, to: string, graphPath?: string): void {
  try {
    const graphData = loadGraph(graphPath);
    const graph = new GIDGraph(graphData);
    const engine = new QueryEngine(graph);

    const path = engine.findPath(from, to);

    console.log();
    console.log(chalk.bold(`Dependency Path: ${chalk.cyan(from)} → ${chalk.cyan(to)}`));
    console.log(chalk.dim('═'.repeat(50)));
    console.log();

    if (path === null) {
      console.log(chalk.yellow(`No dependency path from ${from} to ${to}`));
    } else {
      console.log(chalk.bold('Path') + chalk.dim(` (${path.length - 1} hops):`));
      for (const [i, node] of path.entries()) {
        const isLast = i === path.length - 1;
        const prefix = isLast ? '└──' : '├──';
        const arrow = isLast ? '' : ' → ...';
        console.log(`  ${prefix} ${node}${arrow}`);
      }
    }
  } catch (err) {
    handleError(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Error Handling
// ═══════════════════════════════════════════════════════════════════════════════

function handleError(err: unknown): void {
  if (err instanceof GIDError) {
    console.error();
    console.error(chalk.red(`Error: ${err.message}`));

    if (err.code === 'NODE_NOT_FOUND' && err.details?.availableNodes) {
      console.error();
      console.error('Available nodes:');
      const nodes = err.details.availableNodes as string[];
      for (const node of nodes.slice(0, 10)) {
        console.error(`  - ${node}`);
      }
      if (nodes.length > 10) {
        console.error(`  ... and ${nodes.length - 10} more`);
      }
    }

    if (err.code === 'SCHEMA_ERROR' && err.details?.errors) {
      console.error();
      console.error('Validation errors:');
      const errors = err.details.errors as Array<{ path: string; message: string; suggestion?: string }>;
      for (const e of errors) {
        console.error(`  - ${e.path}: ${e.message}`);
        if (e.suggestion) {
          console.error(`    ${chalk.dim(e.suggestion)}`);
        }
      }
    }

    process.exit(1);
  }

  console.error(chalk.red('Unexpected error:'), err);
  process.exit(1);
}
