/**
 * gid history command
 *
 * Manage graph version history.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';
import { createStateManager, diffGraphs } from '../core/state.js';
import { loadGraph, saveGraph } from '../core/parser.js';

// ═══════════════════════════════════════════════════════════════════════════════
// List History
// ═══════════════════════════════════════════════════════════════════════════════

export function runHistoryList(): void {
  const gidDir = path.join(process.cwd(), '.gid');
  const stateManager = createStateManager(gidDir);

  const entries = stateManager.listHistory();

  if (entries.length === 0) {
    console.log();
    console.log(chalk.yellow('No history entries found.'));
    console.log(chalk.dim('Run `gid extract` to create the first version.'));
    return;
  }

  console.log();
  console.log(chalk.bold('Graph History'));
  console.log(chalk.dim('═'.repeat(60)));
  console.log();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLatest = i === 0;
    const marker = isLatest ? chalk.green(' (latest)') : '';

    console.log(
      `  ${chalk.cyan(entry.filename)}${marker}`
    );
    console.log(
      chalk.dim(`    ${entry.timestamp} | ${entry.nodeCount} nodes, ${entry.edgeCount} edges`)
    );
    if (entry.gitCommit) {
      console.log(chalk.dim(`    git: ${entry.gitCommit}`));
    }
    console.log();
  }

  console.log(chalk.dim('Use `gid history diff <version>` to compare versions.'));
  console.log(chalk.dim('Use `gid history restore <version>` to restore a version.'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Diff History
// ═══════════════════════════════════════════════════════════════════════════════

export function runHistoryDiff(version: string): void {
  const gidDir = path.join(process.cwd(), '.gid');
  const stateManager = createStateManager(gidDir);

  // Load current graph
  let currentGraph;
  try {
    currentGraph = loadGraph();
  } catch {
    console.error(chalk.red('Error: No current graph found. Run `gid extract` first.'));
    process.exit(1);
  }

  // Load historical version
  const historicalGraph = stateManager.loadHistoryVersion(version);
  if (!historicalGraph) {
    console.error(chalk.red(`Error: Version not found: ${version}`));
    console.error(chalk.dim('Use `gid history list` to see available versions.'));
    process.exit(1);
  }

  // Compare graphs
  const diff = diffGraphs(historicalGraph, currentGraph);

  console.log();
  console.log(chalk.bold(`Comparing ${version} → current`));
  console.log(chalk.dim('═'.repeat(50)));
  console.log();

  // Added nodes
  if (diff.addedNodes.length > 0) {
    console.log(chalk.green(`+ Added nodes (${diff.addedNodes.length}):`));
    for (const node of diff.addedNodes.slice(0, 10)) {
      console.log(chalk.green(`    + ${node}`));
    }
    if (diff.addedNodes.length > 10) {
      console.log(chalk.dim(`    ... and ${diff.addedNodes.length - 10} more`));
    }
    console.log();
  }

  // Removed nodes
  if (diff.removedNodes.length > 0) {
    console.log(chalk.red(`- Removed nodes (${diff.removedNodes.length}):`));
    for (const node of diff.removedNodes.slice(0, 10)) {
      console.log(chalk.red(`    - ${node}`));
    }
    if (diff.removedNodes.length > 10) {
      console.log(chalk.dim(`    ... and ${diff.removedNodes.length - 10} more`));
    }
    console.log();
  }

  // Edge changes
  if (diff.addedEdges > 0 || diff.removedEdges > 0) {
    console.log(chalk.bold('Edge changes:'));
    if (diff.addedEdges > 0) {
      console.log(chalk.green(`    + ${diff.addedEdges} edges added`));
    }
    if (diff.removedEdges > 0) {
      console.log(chalk.red(`    - ${diff.removedEdges} edges removed`));
    }
    console.log();
  }

  // Summary
  if (diff.addedNodes.length === 0 && diff.removedNodes.length === 0 &&
      diff.addedEdges === 0 && diff.removedEdges === 0) {
    console.log(chalk.green('No differences found.'));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Restore History
// ═══════════════════════════════════════════════════════════════════════════════

export function runHistoryRestore(version: string, options: { force?: boolean } = {}): void {
  const gidDir = path.join(process.cwd(), '.gid');
  const stateManager = createStateManager(gidDir);
  const graphPath = path.join(gidDir, 'graph.yml');

  // Load historical version
  const historicalGraph = stateManager.loadHistoryVersion(version);
  if (!historicalGraph) {
    console.error(chalk.red(`Error: Version not found: ${version}`));
    console.error(chalk.dim('Use `gid history list` to see available versions.'));
    process.exit(1);
  }

  // Check if current graph exists
  if (fs.existsSync(graphPath) && !options.force) {
    console.log(chalk.yellow('Warning: This will overwrite the current graph.'));
    console.log(chalk.dim('Use --force to confirm.'));
    process.exit(1);
  }

  // Save current graph to history before restoring
  try {
    const currentGraph = loadGraph();
    stateManager.saveHistory(currentGraph);
    console.log(chalk.dim('Current graph saved to history.'));
  } catch {
    // No current graph, that's fine
  }

  // Restore the historical version
  saveGraph(historicalGraph, graphPath);

  console.log();
  console.log(chalk.green(`✓ Restored graph from ${version}`));
  console.log(chalk.dim(`  Nodes: ${Object.keys(historicalGraph.nodes || {}).length}`));
  console.log(chalk.dim(`  Edges: ${(historicalGraph.edges || []).length}`));
}
