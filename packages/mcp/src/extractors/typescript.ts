/**
 * TypeScript/JavaScript Extractor
 *
 * Extracts dependency graph from TypeScript/JavaScript projects using madge.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import madge from 'madge';
import { Graph, Node, Edge } from '../core/types.js';
import { enrichFile, EnrichmentResult, DetectedPattern } from '../analyzers/index.js';
import {
  DEFAULT_IGNORE_DIRS,
  GroupingOptions,
  groupIntoComponents,
  inferLayer,
  detectOptimalDepth,
  toPascalCase,
  findFilesRecursive,
  escapeRegExp,
  globToRegex,
  pathToNodeId,
} from './common.js';

// Re-export for backwards compatibility
export { DEFAULT_IGNORE_DIRS, GroupingOptions, groupIntoComponents };

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface ExtractOptions {
  /** Base directory to extract from */
  baseDir: string;
  /** Additional directories to scan (for multi-directory support) */
  additionalDirs?: string[];
  /** File extensions to include (default: ts, tsx, js, jsx) */
  extensions?: string[];
  /** Directories to exclude (merged with defaults) */
  excludeDir?: string[];
  /** Additional patterns to ignore */
  ignorePatterns?: string[];
  /** TypeScript config file path */
  tsConfig?: string;
  /** Webpack config file path */
  webpackConfig?: string;
  /** Whether to include node_modules */
  includeNodeModules?: boolean;
  /** Whether to skip default ignore patterns */
  noDefaultIgnore?: boolean;
  /** Verify extraction completeness */
  verify?: boolean;
  /** Maximum dependency depth (0 = unlimited) */
  depth?: number;
  /** Include file stats (loc, exports) */
  withStats?: boolean;
  /** Exclude barrel/index files that only re-export */
  noBarrels?: boolean;
  /** Include function/class signatures in nodes */
  withSignatures?: boolean;
  /** Include detected patterns in nodes */
  withPatterns?: boolean;
  /** Shorthand for withStats + withSignatures + withPatterns */
  enrich?: boolean;
}

export interface FileStats {
  loc: number;
  exports: string[];
  isBarrel: boolean;
}

export interface VerificationResult {
  sourceFiles: number;
  extractedFiles: number;
  coverage: number;
  missingFiles: string[];
  unresolvedImports: Array<{ file: string; import: string; reason: string }>;
}

export interface NodeEnrichment {
  /** Number of functions in file */
  functionCount?: number;
  /** Number of classes in file */
  classCount?: number;
  /** Number of exports */
  exportCount?: number;
  /** Detected patterns */
  patterns?: DetectedPattern[];
  /** Suggested layer based on patterns */
  suggestedLayer?: 'interface' | 'application' | 'domain' | 'infrastructure';
}

export interface ExtractionResult {
  graph: Graph;
  stats: {
    filesScanned: number;
    componentsFound: number;
    dependenciesFound: number;
    circularDeps: string[][];
    /** File-level stats when --with-stats is used */
    fileStats?: Record<string, FileStats>;
    /** Count of enriched nodes */
    enrichedNodes?: number;
  };
  warnings: string[];
  /** Verification results when --verify is used */
  verification?: VerificationResult;
}

export interface PreviewResult {
  directories: string[];
  files: string[];
  excludedDirsFound: string[];
  extensions: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Preview (Dry Run)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Preview what would be extracted without actually running madge.
 * This is a fast operation that just scans for files matching the criteria.
 */
export async function previewExtraction(options: ExtractOptions): Promise<PreviewResult> {
  const {
    baseDir,
    additionalDirs = [],
    extensions = ['ts', 'tsx', 'js', 'jsx'],
    excludeDir = [],
    noDefaultIgnore = false,
  } = options;

  // Build exclude list: defaults + user-specified
  const allExcludeDirs = noDefaultIgnore
    ? excludeDir
    : [...new Set([...DEFAULT_IGNORE_DIRS, ...excludeDir])];

  // Build all directories to scan
  const allDirs = [baseDir, ...additionalDirs];

  // Verify all directories exist
  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Directory not found: ${dir}`);
    }
  }

  // Find files matching criteria
  const files: string[] = [];
  const excludedDirsFound: string[] = [];

  for (const dir of allDirs) {
    const resolvedDir = path.resolve(dir);
    const dirPrefix = allDirs.length > 1 ? path.relative(process.cwd(), resolvedDir) : '';

    // Check which excluded dirs exist
    for (const excludeD of allExcludeDirs) {
      const excludePath = path.join(resolvedDir, excludeD);
      if (fs.existsSync(excludePath) && !excludedDirsFound.includes(excludeD)) {
        excludedDirsFound.push(excludeD);
      }
    }

    // Recursively find files
    const foundFiles = findFilesRecursive(resolvedDir, extensions, allExcludeDirs);
    for (const file of foundFiles) {
      const relativePath = path.relative(resolvedDir, file);
      files.push(dirPrefix ? path.join(dirPrefix, relativePath) : relativePath);
    }
  }

  return {
    directories: allDirs.map((d) => path.resolve(d)),
    files: files.sort(),
    excludedDirsFound,
    extensions,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// File Analysis Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get stats for a file: lines of code, exports, and whether it's a barrel file
 */
function getFileStats(filePath: string): FileStats {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Count non-empty, non-comment lines
    const loc = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 &&
             !trimmed.startsWith('//') &&
             !trimmed.startsWith('/*') &&
             !trimmed.startsWith('*');
    }).length;

    // Find exports
    const exports: string[] = [];
    const exportRegex = /export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g;
    const exportDefaultRegex = /export\s+default\s+(?:function|class)?\s*(\w+)?/g;
    const namedExportRegex = /export\s*\{\s*([^}]+)\s*\}/g;
    const reExportRegex = /export\s+(?:\*|\{[^}]+\})\s+from\s+['"]/g;

    let match;
    while ((match = exportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }
    while ((match = exportDefaultRegex.exec(content)) !== null) {
      exports.push(match[1] || 'default');
    }
    while ((match = namedExportRegex.exec(content)) !== null) {
      const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim());
      exports.push(...names.filter(n => n));
    }

    // Detect if it's a barrel file (mostly re-exports)
    const reExportMatches = content.match(reExportRegex) || [];
    const totalExportStatements = (content.match(/export\s+/g) || []).length;
    const isBarrel = totalExportStatements > 0 &&
                     reExportMatches.length / totalExportStatements > 0.7 &&
                     loc < 50; // Barrel files are usually small

    return { loc, exports: [...new Set(exports)], isBarrel };
  } catch {
    return { loc: 0, exports: [], isBarrel: false };
  }
}

/**
 * Check if a file is a barrel/index file that only re-exports
 */
function isBarrelFile(filePath: string): boolean {
  const filename = path.basename(filePath);
  if (!filename.match(/^index\.(ts|tsx|js|jsx)$/)) {
    return false;
  }
  return getFileStats(filePath).isBarrel;
}

/**
 * Limit dependency tree to a certain depth
 */
function limitDepth(depTree: Record<string, string[]>, maxDepth: number): Record<string, string[]> {
  if (maxDepth <= 0) return depTree;

  // Find root files (files that are not dependencies of others)
  const allDeps = new Set<string>();
  for (const deps of Object.values(depTree)) {
    deps.forEach(d => allDeps.add(d));
  }
  const roots = Object.keys(depTree).filter(f => !allDeps.has(f));

  // BFS to find files within depth
  const included = new Set<string>();
  let currentLevel = roots.length > 0 ? roots : Object.keys(depTree).slice(0, 1);
  let currentDepth = 0;

  while (currentLevel.length > 0 && currentDepth < maxDepth) {
    const nextLevel: string[] = [];
    for (const file of currentLevel) {
      if (included.has(file)) continue;
      included.add(file);
      const deps = depTree[file] || [];
      nextLevel.push(...deps.filter(d => !included.has(d)));
    }
    currentLevel = nextLevel;
    currentDepth++;
  }

  // Filter dep tree to only included files
  const result: Record<string, string[]> = {};
  for (const [file, deps] of Object.entries(depTree)) {
    if (included.has(file)) {
      result[file] = deps.filter(d => included.has(d));
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extractor
// ═══════════════════════════════════════════════════════════════════════════════

export async function extractTypeScript(options: ExtractOptions): Promise<ExtractionResult> {
  const {
    baseDir,
    additionalDirs = [],
    extensions = ['ts', 'tsx', 'js', 'jsx'],
    excludeDir = [],
    ignorePatterns = [],
    tsConfig,
    webpackConfig,
    includeNodeModules = false,
    noDefaultIgnore = false,
    verify = false,
    depth = 0,
    withStats = false,
    noBarrels = false,
    withSignatures = false,
    withPatterns = false,
    enrich = false,
  } = options;

  // Enrich is shorthand for stats + signatures + patterns
  const shouldEnrichSignatures = enrich || withSignatures;
  const shouldEnrichPatterns = enrich || withPatterns;
  const shouldIncludeStats = enrich || withStats;

  // Build exclude list: defaults + user-specified
  const allExcludeDirs = noDefaultIgnore
    ? excludeDir
    : [...new Set([...DEFAULT_IGNORE_DIRS, ...excludeDir])];

  // Build all directories to scan
  const allDirs = [baseDir, ...additionalDirs];

  // Verify all directories exist
  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Directory not found: ${dir}`);
    }
  }

  // Find tsconfig if not specified (check base dir first, then current working directory)
  let resolvedTsConfig = tsConfig;
  if (!resolvedTsConfig) {
    const baseTsConfig = path.join(baseDir, 'tsconfig.json');
    const cwdTsConfig = path.join(process.cwd(), 'tsconfig.json');
    if (fs.existsSync(baseTsConfig)) {
      resolvedTsConfig = baseTsConfig;
    } else if (fs.existsSync(cwdTsConfig)) {
      resolvedTsConfig = cwdTsConfig;
    }
  }

  // Build exclusion regex patterns
  const excludePatterns: RegExp[] = [
    // Directory exclusions
    ...allExcludeDirs.map((d) => new RegExp(`(^|/)${escapeRegExp(d)}(/|$)`)),
    // File pattern exclusions (convert glob to regex)
    ...ignorePatterns.map((p) => globToRegex(p)),
  ];

  // Merge dependency trees from all directories
  let mergedDepTree: Record<string, string[]> = {};
  let allCircularDeps: string[][] = [];
  const warnings: string[] = [];

  for (const dir of allDirs) {
    const resolvedDir = path.resolve(dir);

    // Run madge on each directory
    const result = await madge(resolvedDir, {
      fileExtensions: extensions,
      excludeRegExp: excludePatterns,
      tsConfig: resolvedTsConfig,
      webpackConfig,
      includeNpm: includeNodeModules,
    });

    // Get dependency tree
    const depTree = result.obj();
    const circularDeps = result.circular();

    // Prefix paths with directory name for multi-dir support
    if (allDirs.length > 1) {
      const dirPrefix = path.relative(process.cwd(), resolvedDir);
      for (const [file, deps] of Object.entries(depTree)) {
        const prefixedFile = path.join(dirPrefix, file);
        const prefixedDeps = deps.map((d) => path.join(dirPrefix, d));
        mergedDepTree[prefixedFile] = prefixedDeps;
      }
      // Also prefix circular deps
      allCircularDeps.push(...circularDeps.map((cycle) =>
        cycle.map((f) => path.join(dirPrefix, f))
      ));
    } else {
      mergedDepTree = { ...mergedDepTree, ...depTree };
      allCircularDeps.push(...circularDeps);
    }
  }

  // Filter out barrel files if requested
  let filteredDepTree = mergedDepTree;
  const barrelFiles: string[] = [];

  if (noBarrels) {
    filteredDepTree = {};
    for (const [filePath, deps] of Object.entries(mergedDepTree)) {
      const fullPath = path.resolve(allDirs.length > 1 ? process.cwd() : baseDir, filePath);
      if (isBarrelFile(fullPath)) {
        barrelFiles.push(filePath);
        continue;
      }
      // Also filter out barrel files from dependencies
      filteredDepTree[filePath] = deps.filter(dep => {
        const depFullPath = path.resolve(allDirs.length > 1 ? process.cwd() : baseDir, dep);
        return !isBarrelFile(depFullPath);
      });
    }
    if (barrelFiles.length > 0) {
      warnings.push(`Excluded ${barrelFiles.length} barrel/index file(s)`);
    }
  }

  // Apply depth limit if specified
  if (depth > 0) {
    filteredDepTree = limitDepth(filteredDepTree, depth);
  }

  // Convert to GID graph
  const graph = convertToGraph(filteredDepTree, allDirs.length > 1 ? process.cwd() : baseDir);

  // Collect file stats if requested
  let fileStats: Record<string, FileStats> | undefined;
  let enrichedNodes = 0;

  if (shouldIncludeStats) {
    fileStats = {};
    for (const nodeId of Object.keys(graph.nodes)) {
      const node = graph.nodes[nodeId];
      if (node.path && typeof node.path === 'string') {
        const stats = getFileStats(node.path);
        fileStats[nodeId] = stats;
        // Add stats to node
        (node as Record<string, unknown>).loc = stats.loc;
        (node as Record<string, unknown>).exports = stats.exports;
      }
    }
  }

  // Enrich nodes with signatures and patterns
  if (shouldEnrichSignatures || shouldEnrichPatterns) {
    for (const nodeId of Object.keys(graph.nodes)) {
      const node = graph.nodes[nodeId];
      if (node.path && typeof node.path === 'string') {
        try {
          const enrichment = enrichFile(node.path);

          if (shouldEnrichSignatures) {
            // Add signature counts
            (node as Record<string, unknown>).functionCount = enrichment.signatures.functions.length;
            (node as Record<string, unknown>).classCount = enrichment.signatures.classes.length;
            (node as Record<string, unknown>).exportCount = enrichment.signatures.exports.length;
          }

          if (shouldEnrichPatterns) {
            // Add detected patterns if any
            if (enrichment.patterns.length > 0) {
              (node as Record<string, unknown>).patterns = enrichment.patterns.map(p => p.pattern);
              (node as Record<string, unknown>).patternConfidence = enrichment.patterns.reduce(
                (acc, p) => ({ ...acc, [p.pattern]: p.confidence }),
                {}
              );
            }

            // Always set layer from path inference (independent of patterns)
            if (enrichment.suggestedLayer) {
              node.layer = enrichment.suggestedLayer;
            }

            // Upgrade to Component if suggested (from patterns or class detection)
            if (enrichment.suggestedType === 'Component') {
              node.type = 'Component';
            }
          }

          enrichedNodes++;
        } catch {
          // Ignore errors enriching individual files
        }
      }
    }
  }

  // Calculate stats
  const stats: ExtractionResult['stats'] = {
    filesScanned: Object.keys(mergedDepTree).length,
    componentsFound: Object.keys(graph.nodes).length,
    dependenciesFound: graph.edges.length,
    circularDeps: allCircularDeps,
    fileStats,
    enrichedNodes: enrichedNodes > 0 ? enrichedNodes : undefined,
  };

  // Generate warnings
  if (allCircularDeps.length > 0) {
    warnings.push(`Found ${allCircularDeps.length} circular dependency chain(s)`);
  }

  if (stats.filesScanned === 0) {
    warnings.push('No files found. Check your path and file extensions.');
  }

  // Warn about ignored directories that exist
  const ignoredDirsFound = allExcludeDirs.filter((d) =>
    allDirs.some((dir) => fs.existsSync(path.join(dir, d)))
  );
  if (ignoredDirsFound.length > 0) {
    warnings.push(`Excluded directories: ${ignoredDirsFound.join(', ')}`);
  }

  // Verification if requested
  let verification: VerificationResult | undefined;
  if (verify) {
    // Get all source files
    const allSourceFiles: string[] = [];
    for (const dir of allDirs) {
      const files = findFilesRecursive(path.resolve(dir), extensions, allExcludeDirs);
      allSourceFiles.push(...files);
    }

    const extractedFiles = Object.keys(filteredDepTree);
    const extractedSet = new Set(extractedFiles.map(f =>
      path.resolve(allDirs.length > 1 ? process.cwd() : baseDir, f)
    ));

    const missingFiles = allSourceFiles.filter(f => !extractedSet.has(f));
    const coverage = allSourceFiles.length > 0
      ? Math.round((extractedFiles.length / allSourceFiles.length) * 100)
      : 100;

    verification = {
      sourceFiles: allSourceFiles.length,
      extractedFiles: extractedFiles.length,
      coverage,
      missingFiles: missingFiles.map(f => path.relative(process.cwd(), f)),
      unresolvedImports: [], // TODO: detect unresolved imports from madge
    };
  }

  return { graph, stats, warnings, verification };
}


// ═══════════════════════════════════════════════════════════════════════════════
// Conversion
// ═══════════════════════════════════════════════════════════════════════════════

function convertToGraph(depTree: Record<string, string[]>, baseDir: string): Graph {
  const nodes: Record<string, Node> = {};
  const edges: Edge[] = [];

  // Create nodes for all files
  for (const filePath of Object.keys(depTree)) {
    const nodeId = tsPathToNodeId(filePath);

    nodes[nodeId] = {
      type: 'File',
      description: `File: ${filePath}`,
      path: path.join(baseDir, filePath),
    };
  }

  // Create dependency edges
  for (const [filePath, deps] of Object.entries(depTree)) {
    const fromId = tsPathToNodeId(filePath);

    for (const dep of deps) {
      const toId = tsPathToNodeId(dep);

      // Make sure target node exists
      if (!nodes[toId]) {
        nodes[toId] = {
          type: 'File',
          description: `File: ${dep}`,
          path: path.join(baseDir, dep),
        };
      }

      edges.push({
        from: fromId,
        to: toId,
        relation: 'depends_on',
      });
    }
  }

  return { nodes, edges };
}

/** TypeScript/JavaScript extensions */
const TS_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

/**
 * Convert file path to a valid node ID (TypeScript-specific)
 */
function tsPathToNodeId(filePath: string): string {
  return pathToNodeId(filePath, TS_EXTENSIONS);
}

