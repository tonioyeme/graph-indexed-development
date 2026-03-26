/**
 * GID Refactor Command
 *
 * Preview or apply graph changes to codebase (rename, move, delete nodes).
 */

import { loadGraph, saveGraph, findGraphFile } from '../core/parser.js';
import { createStateManager } from '../core/state.js';
import * as path from 'node:path';
import * as readline from 'node:readline';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface RefactorOptions {
  newName?: string;
  newLayer?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  graphPath?: string;
}

interface Change {
  type: string;
  description: string;
  before?: string;
  after?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Interactive Prompt
// ═══════════════════════════════════════════════════════════════════════════════

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Display Functions
// ═══════════════════════════════════════════════════════════════════════════════

function formatNodePreview(
  nodeId: string,
  node: Record<string, unknown>,
  inEdges: Array<{ from: string; to: string; relation: string }>,
  outEdges: Array<{ from: string; to: string; relation: string }>
): string {
  const lines: string[] = [];

  lines.push(`\n📍 Node: ${nodeId}`);
  lines.push(`   Type: ${node.type || 'unknown'}`);
  if (node.layer) lines.push(`   Layer: ${node.layer}`);
  if (node.description) lines.push(`   Description: ${node.description}`);
  if (node.path) lines.push(`   Path: ${node.path}`);
  if (node.status) lines.push(`   Status: ${node.status}`);

  if (inEdges.length > 0) {
    lines.push(`\n   📥 Incoming edges (${inEdges.length}):`);
    for (const edge of inEdges.slice(0, 10)) {
      lines.push(`      ${edge.from} --[${edge.relation}]--> ${nodeId}`);
    }
    if (inEdges.length > 10) {
      lines.push(`      ... and ${inEdges.length - 10} more`);
    }
  }

  if (outEdges.length > 0) {
    lines.push(`\n   📤 Outgoing edges (${outEdges.length}):`);
    for (const edge of outEdges.slice(0, 10)) {
      lines.push(`      ${nodeId} --[${edge.relation}]--> ${edge.to}`);
    }
    if (outEdges.length > 10) {
      lines.push(`      ... and ${outEdges.length - 10} more`);
    }
  }

  return lines.join('\n');
}

function formatChanges(changes: Change[], dryRun: boolean): string {
  const lines: string[] = [];

  lines.push(`\n📋 Changes${dryRun ? ' (preview)' : ''}:`);

  for (const change of changes) {
    const icon = change.type.includes('delete') ? '🗑️' : change.type.includes('rename') ? '✏️' : '🔄';
    lines.push(`   ${icon} ${change.description}`);
    if (change.before && change.after) {
      lines.push(`      ${change.before} → ${change.after}`);
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Operations
// ═══════════════════════════════════════════════════════════════════════════════

function previewNode(
  graphData: { nodes: Record<string, Record<string, unknown>>; edges: Array<{ from: string; to: string; relation: string }> },
  nodeId: string,
  options: RefactorOptions
): void {
  const node = graphData.nodes[nodeId];
  if (!node) {
    console.error(`❌ Node not found: ${nodeId}`);
    process.exit(1);
  }

  const inEdges = graphData.edges.filter((e) => e.to === nodeId);
  const outEdges = graphData.edges.filter((e) => e.from === nodeId);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          nodeId,
          node,
          incomingEdges: inEdges.length,
          outgoingEdges: outEdges.length,
          edges: { incoming: inEdges, outgoing: outEdges },
        },
        null,
        2
      )
    );
  } else {
    console.log(formatNodePreview(nodeId, node, inEdges, outEdges));
  }
}

async function renameNode(
  graphData: { nodes: Record<string, Record<string, unknown>>; edges: Array<{ from: string; to: string; relation: string }> },
  graphPath: string,
  nodeId: string,
  options: RefactorOptions
): Promise<void> {
  if (!options.newName) {
    console.error('❌ --new-name is required for rename operation');
    process.exit(1);
  }

  const node = graphData.nodes[nodeId];
  if (!node) {
    console.error(`❌ Node not found: ${nodeId}`);
    process.exit(1);
  }

  if (graphData.nodes[options.newName]) {
    console.error(`❌ Node already exists: ${options.newName}`);
    process.exit(1);
  }

  const changes: Change[] = [];

  changes.push({
    type: 'rename_node',
    description: `Rename node`,
    before: nodeId,
    after: options.newName,
  });

  // Find affected edges
  for (const edge of graphData.edges) {
    if (edge.from === nodeId) {
      changes.push({
        type: 'update_edge_from',
        description: `Update edge source`,
        before: `${edge.from} → ${edge.to}`,
        after: `${options.newName} → ${edge.to}`,
      });
    }
    if (edge.to === nodeId) {
      changes.push({
        type: 'update_edge_to',
        description: `Update edge target`,
        before: `${edge.from} → ${edge.to}`,
        after: `${edge.from} → ${options.newName}`,
      });
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: options.dryRun,
          operation: 'rename',
          nodeId,
          newName: options.newName,
          changes,
        },
        null,
        2
      )
    );
  } else {
    console.log(formatChanges(changes, options.dryRun ?? true));
  }

  // Apply changes if not dry run
  if (!options.dryRun) {
    if (!options.yes && !options.json) {
      const answer = await promptUser('\n❓ Apply these changes? [y/N] ');
      if (answer !== 'y' && answer !== 'yes') {
        console.log('❌ Aborted.');
        return;
      }
    }

    graphData.nodes[options.newName] = node;
    delete graphData.nodes[nodeId];

    for (const edge of graphData.edges) {
      if (edge.from === nodeId) edge.from = options.newName;
      if (edge.to === nodeId) edge.to = options.newName;
    }

    saveGraph(graphData, graphPath);

    // Save to history
    const gidDir = path.dirname(graphPath);
    const stateManager = createStateManager(gidDir);
    stateManager.saveHistory(graphData);

    if (!options.json) {
      console.log(`\n✅ Renamed ${nodeId} to ${options.newName}`);
    }
  } else if (!options.json) {
    console.log('\n🔄 Dry run - no changes applied. Use --no-dry-run to apply.');
  }
}

async function moveNode(
  graphData: { nodes: Record<string, Record<string, unknown>>; edges: Array<{ from: string; to: string; relation: string }> },
  graphPath: string,
  nodeId: string,
  options: RefactorOptions
): Promise<void> {
  if (!options.newLayer) {
    console.error('❌ --new-layer is required for move operation');
    process.exit(1);
  }

  const validLayers = ['interface', 'application', 'domain', 'infrastructure'];
  if (!validLayers.includes(options.newLayer)) {
    console.error(`❌ Invalid layer: ${options.newLayer}. Must be one of: ${validLayers.join(', ')}`);
    process.exit(1);
  }

  const node = graphData.nodes[nodeId];
  if (!node) {
    console.error(`❌ Node not found: ${nodeId}`);
    process.exit(1);
  }

  const changes: Change[] = [
    {
      type: 'change_layer',
      description: `Move node to ${options.newLayer} layer`,
      before: (node.layer as string) || '(none)',
      after: options.newLayer,
    },
  ];

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: options.dryRun,
          operation: 'move',
          nodeId,
          newLayer: options.newLayer,
          changes,
        },
        null,
        2
      )
    );
  } else {
    console.log(formatChanges(changes, options.dryRun ?? true));
  }

  // Apply changes if not dry run
  if (!options.dryRun) {
    if (!options.yes && !options.json) {
      const answer = await promptUser('\n❓ Apply these changes? [y/N] ');
      if (answer !== 'y' && answer !== 'yes') {
        console.log('❌ Aborted.');
        return;
      }
    }

    node.layer = options.newLayer;
    saveGraph(graphData, graphPath);

    // Save to history
    const gidDir = path.dirname(graphPath);
    const stateManager = createStateManager(gidDir);
    stateManager.saveHistory(graphData);

    if (!options.json) {
      console.log(`\n✅ Moved ${nodeId} to ${options.newLayer} layer`);
    }
  } else if (!options.json) {
    console.log('\n🔄 Dry run - no changes applied. Use --no-dry-run to apply.');
  }
}

async function deleteNode(
  graphData: { nodes: Record<string, Record<string, unknown>>; edges: Array<{ from: string; to: string; relation: string }> },
  graphPath: string,
  nodeId: string,
  options: RefactorOptions
): Promise<void> {
  const node = graphData.nodes[nodeId];
  if (!node) {
    console.error(`❌ Node not found: ${nodeId}`);
    process.exit(1);
  }

  const changes: Change[] = [
    {
      type: 'delete_node',
      description: `Delete node ${nodeId}`,
    },
  ];

  const affectedEdges = graphData.edges.filter((e) => e.from === nodeId || e.to === nodeId);
  for (const edge of affectedEdges) {
    changes.push({
      type: 'delete_edge',
      description: `Delete edge ${edge.from} --[${edge.relation}]--> ${edge.to}`,
    });
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: options.dryRun,
          operation: 'delete',
          nodeId,
          changes,
        },
        null,
        2
      )
    );
  } else {
    console.log(formatChanges(changes, options.dryRun ?? true));
  }

  // Apply changes if not dry run
  if (!options.dryRun) {
    if (!options.yes && !options.json) {
      const answer = await promptUser('\n❓ Delete this node and its edges? [y/N] ');
      if (answer !== 'y' && answer !== 'yes') {
        console.log('❌ Aborted.');
        return;
      }
    }

    delete graphData.nodes[nodeId];
    graphData.edges = graphData.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);

    saveGraph(graphData, graphPath);

    // Save to history
    const gidDir = path.dirname(graphPath);
    const stateManager = createStateManager(gidDir);
    stateManager.saveHistory(graphData);

    if (!options.json) {
      console.log(`\n✅ Deleted ${nodeId} and ${affectedEdges.length} edge(s)`);
    }
  } else if (!options.json) {
    console.log('\n🔄 Dry run - no changes applied. Use --no-dry-run to apply.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Command
// ═══════════════════════════════════════════════════════════════════════════════

export async function runRefactor(
  operation: string,
  nodeId: string,
  options: RefactorOptions
): Promise<void> {
  const graphPath = options.graphPath ?? findGraphFile();
  if (!graphPath) {
    console.error('❌ No graph.yml found. Run `gid init` or `gid extract` first.');
    process.exit(1);
  }

  const graphData = loadGraph(graphPath);

  switch (operation) {
    case 'preview':
      previewNode(graphData, nodeId, options);
      break;
    case 'rename':
      await renameNode(graphData, graphPath, nodeId, options);
      break;
    case 'move':
      await moveNode(graphData, graphPath, nodeId, options);
      break;
    case 'delete':
      await deleteNode(graphData, graphPath, nodeId, options);
      break;
    default:
      console.error(`❌ Unknown operation: ${operation}`);
      console.error('   Valid operations: preview, rename, move, delete');
      process.exit(1);
  }
}
