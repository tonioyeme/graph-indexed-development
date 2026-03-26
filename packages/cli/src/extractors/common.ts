/**
 * Common Extractor Utilities
 *
 * Shared logic for all language extractors:
 * - Layer inference from file paths
 * - Pattern detection
 * - Component grouping
 */

import { Graph, Node, Edge } from '../core/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface GroupingOptions {
  /** Minimum files to form a component group (default: 1) */
  minGroupSize?: number;
  /** Directory depth for grouping (default: auto-detect) */
  groupingDepth?: number;
  /** Keep file nodes alongside components (for reference) */
  keepFileNodes?: boolean;
}

export interface DetectedPattern {
  pattern: string;
  confidence: number;
  indicators: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer Inference
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Layer inference rules based on path patterns.
 * These patterns work across all languages since they check file paths.
 */
const LAYER_PATTERNS: Array<{
  layer: 'interface' | 'application' | 'domain' | 'infrastructure';
  patterns: string[];
}> = [
  {
    layer: 'interface',
    patterns: [
      'component', 'page', 'view', 'ui', 'web', 'routes', 'api',
      'controller', 'handler', 'endpoint', 'resource', 'presentation',
      'views', 'templates', 'screens', 'widgets'
    ]
  },
  {
    layer: 'application',
    patterns: [
      'service', 'usecase', 'use-case', 'use_case', 'application',
      'workflow', 'orchestrator', 'facade', 'interactor', 'command',
      'query', 'manager', 'processor'
    ]
  },
  {
    layer: 'domain',
    patterns: [
      'model', 'entity', 'domain', 'core', 'business',
      'aggregate', 'value', 'specification', 'policy', 'rule'
    ]
  },
  {
    layer: 'infrastructure',
    patterns: [
      'repo', 'repository', 'db', 'database', 'client', 'infra',
      'infrastructure', 'persistence', 'external', 'adapter', 'gateway',
      'provider', 'driver', 'integration', 'messaging', 'cache'
    ]
  }
];

/**
 * Infer architectural layer from file path.
 * Works for any programming language.
 */
export function inferLayer(filePath: string): 'interface' | 'application' | 'domain' | 'infrastructure' {
  const pathLower = filePath.toLowerCase();

  for (const { layer, patterns } of LAYER_PATTERNS) {
    if (patterns.some(p => pathLower.includes(p))) {
      return layer;
    }
  }

  return 'application'; // Default
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pattern Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pattern detection rules based on path/filename.
 * Language-agnostic patterns that work across all languages.
 */
const PATTERN_RULES: Array<{
  pattern: string;
  pathPatterns: string[];
  confidence: number;
}> = [
  { pattern: 'service', pathPatterns: ['service', 'svc'], confidence: 0.8 },
  { pattern: 'controller', pathPatterns: ['controller', 'handler', 'endpoint'], confidence: 0.8 },
  { pattern: 'repository', pathPatterns: ['repo', 'repository', 'dao', 'store'], confidence: 0.8 },
  { pattern: 'model', pathPatterns: ['model', 'entity', 'schema', 'dto'], confidence: 0.7 },
  { pattern: 'util', pathPatterns: ['util', 'helper', 'common', 'shared'], confidence: 0.6 },
  { pattern: 'config', pathPatterns: ['config', 'settings', 'constants'], confidence: 0.7 },
  { pattern: 'test', pathPatterns: ['test', 'spec', '__tests__'], confidence: 0.9 },
  { pattern: 'middleware', pathPatterns: ['middleware', 'interceptor', 'filter'], confidence: 0.8 },
  { pattern: 'factory', pathPatterns: ['factory', 'builder', 'creator'], confidence: 0.7 },
];

/**
 * Detect architectural patterns from file path.
 * Returns patterns sorted by confidence.
 */
export function detectPatterns(filePath: string): DetectedPattern[] {
  const pathLower = filePath.toLowerCase();
  const detected: DetectedPattern[] = [];

  for (const { pattern, pathPatterns, confidence } of PATTERN_RULES) {
    const matchedIndicators = pathPatterns.filter(p => pathLower.includes(p));
    if (matchedIndicators.length > 0) {
      detected.push({
        pattern,
        confidence,
        indicators: matchedIndicators.map(p => `path contains '${p}'`)
      });
    }
  }

  return detected.sort((a, b) => b.confidence - a.confidence);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Component Grouping
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Group files into components based on directory structure.
 * Auto-detects grouping by analyzing directory patterns - no hardcoded names.
 *
 * Examples:
 * - src/ai/client.ts, src/ai/designer.ts → Ai component
 * - src/core/graph.ts, src/core/types.ts → Core component
 * - tests/parser.test.ts → Tests component
 */
export function groupIntoComponents(
  graph: Graph,
  options: GroupingOptions = {}
): Graph {
  const {
    minGroupSize = 1,
    groupingDepth,
    keepFileNodes = false
  } = options;

  const nodes: Record<string, Node> = {};
  const edges: Edge[] = [];
  const nodeIds = Object.keys(graph.nodes);

  if (nodeIds.length === 0) {
    return { nodes, edges };
  }

  // Auto-detect optimal grouping depth if not specified
  const depth = groupingDepth ?? detectOptimalDepth(nodeIds);

  // Group files by directory at the detected depth
  const groups = new Map<string, string[]>();

  for (const nodeId of nodeIds) {
    const groupKey = getGroupKey(nodeId, depth);

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(nodeId);
  }

  // Create component nodes for groups
  const fileToComponent = new Map<string, string>();

  for (const [groupKey, files] of groups) {
    if (files.length >= minGroupSize) {
      // Create a component node
      const componentId = groupKeyToComponentId(groupKey);

      // Collect file info for description
      const fileNames = files.map(f => {
        const parts = f.split('/');
        return parts[parts.length - 1];
      }).join(', ');
      const truncatedFiles = fileNames.length > 100
        ? fileNames.slice(0, 100) + '...'
        : fileNames;

      // Store child file data for expand/collapse in visualization
      const children = files.map(file => ({
        id: file,
        ...graph.nodes[file],
      }));

      // Store internal edges between children for expand view
      const childSet = new Set(files);
      const childEdges = graph.edges
        .filter(e => childSet.has(e.from) && childSet.has(e.to))
        .map(e => ({ from: e.from, to: e.to, relation: e.relation }));

      // Store external edges (from children to outside) for expand view
      const childExternalEdges = graph.edges
        .filter(e => (childSet.has(e.from) && !childSet.has(e.to)) ||
                     (!childSet.has(e.from) && childSet.has(e.to)))
        .map(e => ({ from: e.from, to: e.to, relation: e.relation }));

      nodes[componentId] = {
        type: 'Component',
        description: `${files.length} files: ${truncatedFiles}`,
        layer: inferLayer(groupKey),
        children, // Store children for expand/collapse
        childEdges, // Store internal edges for expand view
        childExternalEdges, // Store edges to outside for expand view
      };

      for (const file of files) {
        fileToComponent.set(file, componentId);

        // Optionally keep file nodes with reference to component
        if (keepFileNodes) {
          const fileNode = { ...graph.nodes[file] };
          (fileNode as Record<string, unknown>).component = componentId;
          nodes[file] = fileNode;
        }
      }
    } else {
      // Keep as individual file nodes (upgraded to Component if single meaningful file)
      for (const file of files) {
        const originalNode = graph.nodes[file];
        // Single files with classes/exports become Components
        const hasSubstance = originalNode.path && (
          (originalNode as Record<string, unknown>).classCount as number > 0 ||
          ((originalNode as Record<string, unknown>).exportCount as number) > 2
        );

        if (hasSubstance) {
          nodes[file] = {
            ...originalNode,
            type: 'Component',
            layer: inferLayer(file),
          };
        } else {
          nodes[file] = originalNode;
        }
        fileToComponent.set(file, file);
      }
    }
  }

  // Convert edges to component-level
  const edgeSet = new Set<string>();

  for (const edge of graph.edges) {
    const fromComp = fileToComponent.get(edge.from) ?? edge.from;
    const toComp = fileToComponent.get(edge.to) ?? edge.to;

    // Skip self-references within component
    if (fromComp === toComp) continue;

    const edgeKey = `${fromComp}|${toComp}`;
    if (!edgeSet.has(edgeKey)) {
      edgeSet.add(edgeKey);
      edges.push({
        from: fromComp,
        to: toComp,
        relation: 'depends_on',
      });
    }
  }

  return { nodes, edges };
}

/**
 * Auto-detect optimal grouping depth by analyzing directory structure.
 * Returns the depth that creates meaningful component groups.
 */
export function detectOptimalDepth(nodeIds: string[]): number {
  if (nodeIds.length === 0) return 1;

  // Count files at each depth level
  const depthCounts = new Map<number, Map<string, number>>();

  for (const nodeId of nodeIds) {
    const parts = nodeId.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const key = parts.slice(0, depth).join('/');

      if (!depthCounts.has(depth)) {
        depthCounts.set(depth, new Map());
      }
      const counts = depthCounts.get(depth)!;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  // Find depth with best grouping (not too few, not too many groups)
  // Ideal: 3-15 groups with 2+ files each
  let bestDepth = 1;
  let bestScore = 0;

  for (const [depth, counts] of depthCounts) {
    const groups = Array.from(counts.values());
    const numGroups = groups.length;
    const avgSize = groups.reduce((a, b) => a + b, 0) / numGroups;
    const multiFileGroups = groups.filter(c => c >= 2).length;

    // Score based on:
    // - Having 3-15 groups (not too fragmented, not too monolithic)
    // - Groups having multiple files
    // - Reasonable average group size
    const groupScore = numGroups >= 3 && numGroups <= 15 ? 10 : (numGroups < 3 ? 5 : 3);
    const multiFileScore = multiFileGroups * 2;
    const sizeScore = avgSize >= 2 && avgSize <= 10 ? 5 : 2;

    const score = groupScore + multiFileScore + sizeScore;

    if (score > bestScore) {
      bestScore = score;
      bestDepth = depth;
    }
  }

  return bestDepth;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the group key for a node at the specified depth.
 */
function getGroupKey(nodeId: string, depth: number): string {
  const parts = nodeId.split('/');

  // If file is at root or shallow, use parent directory
  if (parts.length <= depth) {
    return parts.slice(0, -1).join('/') || parts[0];
  }

  return parts.slice(0, depth).join('/');
}

/**
 * Convert group key to component ID.
 */
function groupKeyToComponentId(groupKey: string): string {
  const parts = groupKey.split('/');
  // Take last meaningful part and PascalCase it
  const name = parts[parts.length - 1] || parts[0] || 'Root';
  return toPascalCase(name);
}

/**
 * Convert string to PascalCase.
 */
export function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// File Discovery (shared across extractors)
// ═══════════════════════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Default directories to ignore during extraction.
 * Common across all languages.
 */
export const DEFAULT_IGNORE_DIRS = [
  // Node.js / JavaScript
  'node_modules',
  '.next',
  '.nuxt',
  '.output',
  'dist',
  'build',
  'out',
  '.cache',
  '.turbo',
  '.vercel',
  '.netlify',
  '.parcel-cache',
  '.vite',
  '.svelte-kit',
  '.angular',

  // Python
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.eggs',
  '*.egg-info',
  'venv',
  '.venv',
  'env',
  '.env',

  // Rust
  'target',

  // Java
  'target',
  '.gradle',
  '.mvn',

  // General
  '.git',
  '.svn',
  '.hg',
  'coverage',
  '.idea',
  '.vscode',
  'vendor',
  '.bundle',
];

/**
 * Recursively find files with given extensions, excluding specified directories.
 */
export function findFilesRecursive(
  dir: string,
  extensions: string[],
  excludeDirs: string[]
): string[] {
  const files: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (excludeDirs.includes(entry.name)) {
          continue;
        }
        // Recurse into subdirectory
        files.push(...findFilesRecursive(fullPath, extensions, excludeDirs));
      } else if (entry.isFile()) {
        // Check extension
        const ext = path.extname(entry.name).slice(1); // Remove leading dot
        if (extensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch (err) {
    // Ignore permission errors, etc.
  }

  return files;
}

/**
 * Escape special regex characters in a string.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a simple glob pattern to a regex.
 */
export function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@DOUBLESTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@DOUBLESTAR@@/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(escaped);
}

/**
 * Convert file path to a valid node ID.
 * Removes extension and normalizes separators.
 */
export function pathToNodeId(filePath: string, extensions: string[]): string {
  // Build regex to remove any of the extensions
  const extPattern = extensions.map(e => `\\.${e}`).join('|');
  const extRegex = new RegExp(`(${extPattern})$`);
  return filePath.replace(extRegex, '');
}
