/**
 * Python Extractor
 *
 * Extracts dependency graph from Python projects using regex-based import parsing.
 *
 * Supported import patterns:
 * - import module
 * - import package.submodule
 * - from module import something
 * - from package.submodule import Class, function
 * - from . import relative
 * - from ..parent import something
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Graph, Node, Edge } from '../core/types.js';
import {
  DEFAULT_IGNORE_DIRS,
  GroupingOptions,
  groupIntoComponents,
  inferLayer,
  findFilesRecursive,
  pathToNodeId,
} from './common.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface PythonExtractOptions {
  /** Base directory to extract from */
  baseDir: string;
  /** Additional directories to scan */
  additionalDirs?: string[];
  /** Directories to exclude (merged with defaults) */
  excludeDir?: string[];
  /** Additional patterns to ignore */
  ignorePatterns?: string[];
  /** Whether to skip default ignore patterns */
  noDefaultIgnore?: boolean;
  /** Include type stub files (.pyi) */
  includeStubs?: boolean;
  /** Group files into components */
  group?: boolean;
  /** Directory depth for grouping */
  groupingDepth?: number;
}

export interface PythonExtractionResult {
  graph: Graph;
  stats: {
    filesScanned: number;
    nodesCreated: number;
    edgesCreated: number;
    language: 'python';
  };
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const PYTHON_EXTENSIONS = ['py', 'pyi'];

// Import patterns
const IMPORT_PATTERNS = {
  // import module / import package.submodule
  simpleImport: /^import\s+([\w.]+)/gm,
  // from module import x / from package.submodule import x, y, z
  fromImport: /^from\s+([\w.]+)\s+import\s+/gm,
  // from . import x / from .. import x
  relativeImport: /^from\s+(\.+)([\w.]*)\s+import\s+/gm,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Extractor
// ═══════════════════════════════════════════════════════════════════════════════

export async function extractPython(options: PythonExtractOptions): Promise<PythonExtractionResult> {
  const {
    baseDir,
    additionalDirs = [],
    excludeDir = [],
    ignorePatterns = [],
    noDefaultIgnore = false,
    includeStubs = false,
    group = false,
    groupingDepth,
  } = options;

  // Build exclude list
  const allExcludeDirs = noDefaultIgnore
    ? excludeDir
    : [...new Set([...DEFAULT_IGNORE_DIRS, ...excludeDir])];

  const allDirs = [baseDir, ...additionalDirs];

  // Verify directories exist
  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Directory not found: ${dir}`);
    }
  }

  // Determine extensions
  const extensions = includeStubs ? PYTHON_EXTENSIONS : ['py'];

  // Find all Python files
  const allFiles: string[] = [];
  for (const dir of allDirs) {
    const resolvedDir = path.resolve(dir);
    const files = findFilesRecursive(resolvedDir, extensions, allExcludeDirs);
    allFiles.push(...files);
  }

  // Filter by ignore patterns
  const filteredFiles = allFiles.filter(file => {
    const relativePath = path.relative(process.cwd(), file);
    return !ignorePatterns.some(pattern => {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(relativePath);
    });
  });

  // Build dependency graph
  const nodes: Record<string, Node> = {};
  const edges: Edge[] = [];
  const edgeSet = new Set<string>();
  const warnings: string[] = [];

  // Map file paths to module names
  const fileToModule = new Map<string, string>();
  const moduleToFile = new Map<string, string>();

  for (const file of filteredFiles) {
    const moduleName = filePathToModule(file, baseDir);
    fileToModule.set(file, moduleName);
    moduleToFile.set(moduleName, file);

    // Create node
    const nodeId = moduleName.replace(/\./g, '/');
    nodes[nodeId] = {
      type: 'File',
      description: `Python: ${path.basename(file)}`,
      path: file,
      layer: inferLayer(file),
    };
  }

  // Parse imports and create edges
  for (const file of filteredFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const moduleName = fileToModule.get(file)!;
    const fromNodeId = moduleName.replace(/\./g, '/');
    const imports = parseImports(content, file, baseDir);

    for (const imp of imports) {
      // Resolve the import to a module path
      const resolvedModule = resolveImport(imp, moduleName, moduleToFile);
      if (!resolvedModule) continue;

      // Skip external modules (not in our codebase)
      if (!moduleToFile.has(resolvedModule)) continue;

      const toNodeId = resolvedModule.replace(/\./g, '/');

      // Skip self-imports
      if (fromNodeId === toNodeId) continue;

      // Add edge
      const edgeKey = `${fromNodeId}|${toNodeId}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({
          from: fromNodeId,
          to: toNodeId,
          relation: 'depends_on',
        });
      }
    }
  }

  let graph: Graph = { nodes, edges };

  // Group into components if requested
  if (group) {
    graph = groupIntoComponents(graph, { groupingDepth });
  }

  if (filteredFiles.length === 0) {
    warnings.push('No Python files found. Check your path and file extensions.');
  }

  return {
    graph,
    stats: {
      filesScanned: filteredFiles.length,
      nodesCreated: Object.keys(graph.nodes).length,
      edgesCreated: graph.edges.length,
      language: 'python',
    },
    warnings,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Import Parsing
// ═══════════════════════════════════════════════════════════════════════════════

interface ParsedImport {
  module: string;
  isRelative: boolean;
  relativeLevels: number;
}

/**
 * Parse Python import statements from file content.
 */
function parseImports(content: string, filePath: string, baseDir: string): ParsedImport[] {
  const imports: ParsedImport[] = [];

  // Remove comments and strings to avoid false positives
  const cleanedContent = removeCommentsAndStrings(content);

  // Simple imports: import module
  let match;
  const simpleRegex = /^import\s+([\w.]+)/gm;
  while ((match = simpleRegex.exec(cleanedContent)) !== null) {
    const modulePath = match[1];
    // Skip __future__ imports
    if (modulePath.startsWith('__future__')) continue;

    imports.push({
      module: modulePath,
      isRelative: false,
      relativeLevels: 0,
    });
  }

  // From imports: from module import x
  const fromRegex = /^from\s+([\w.]+)\s+import\s+/gm;
  while ((match = fromRegex.exec(cleanedContent)) !== null) {
    const modulePath = match[1];
    // Skip __future__ imports
    if (modulePath.startsWith('__future__')) continue;

    imports.push({
      module: modulePath,
      isRelative: false,
      relativeLevels: 0,
    });
  }

  // Relative imports: from . import x / from ..module import x
  const relativeRegex = /^from\s+(\.+)([\w.]*)\s+import\s+/gm;
  while ((match = relativeRegex.exec(cleanedContent)) !== null) {
    const dots = match[1];
    const modulePath = match[2] || '';

    imports.push({
      module: modulePath,
      isRelative: true,
      relativeLevels: dots.length,
    });
  }

  return imports;
}

/**
 * Remove comments and strings from Python code.
 */
function removeCommentsAndStrings(content: string): string {
  // Remove triple-quoted strings
  let cleaned = content.replace(/'''[\s\S]*?'''/g, '');
  cleaned = cleaned.replace(/"""[\s\S]*?"""/g, '');
  // Remove single-quoted strings
  cleaned = cleaned.replace(/'[^'\n]*'/g, '');
  cleaned = cleaned.replace(/"[^"\n]*"/g, '');
  // Remove comments
  cleaned = cleaned.replace(/#.*/g, '');
  return cleaned;
}

/**
 * Convert file path to Python module name.
 * e.g., /project/src/utils/helper.py -> src.utils.helper
 */
function filePathToModule(filePath: string, baseDir: string): string {
  const relativePath = path.relative(baseDir, filePath);
  // Remove extension and convert path separators to dots
  let modulePath = relativePath
    .replace(/\.(py|pyi)$/, '')
    .replace(/[/\\]/g, '.');

  // Handle __init__.py -> package name
  if (modulePath.endsWith('.__init__')) {
    modulePath = modulePath.slice(0, -9); // Remove '.__init__'
  }

  return modulePath;
}

/**
 * Resolve an import to a module path.
 */
function resolveImport(
  imp: ParsedImport,
  currentModule: string,
  moduleToFile: Map<string, string>
): string | null {
  if (!imp.isRelative) {
    // Absolute import - return as-is
    // Try to find the most specific match
    let module = imp.module;
    while (module) {
      if (moduleToFile.has(module)) {
        return module;
      }
      // Try parent package
      const lastDot = module.lastIndexOf('.');
      if (lastDot === -1) break;
      module = module.slice(0, lastDot);
    }
    return imp.module;
  }

  // Relative import
  const currentParts = currentModule.split('.');
  // Go up 'relativeLevels' directories (minus 1, since . means current package)
  const upLevels = imp.relativeLevels - 1;
  const baseParts = currentParts.slice(0, currentParts.length - 1 - upLevels);

  if (imp.module) {
    baseParts.push(...imp.module.split('.'));
  }

  return baseParts.join('.');
}
