/**
 * Rust Extractor
 *
 * Extracts dependency graph from Rust projects using regex-based parsing.
 *
 * Supported patterns:
 * - use crate::module::Item;
 * - use super::parent::Thing;
 * - use self::submodule::Other;
 * - mod submodule;
 * - pub mod public_module;
 * - use std::collections::HashMap; (external crates tracked but not nodes)
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

export interface RustExtractOptions {
  /** Base directory to extract from (usually Cargo.toml location) */
  baseDir: string;
  /** Additional directories to scan */
  additionalDirs?: string[];
  /** Directories to exclude (merged with defaults) */
  excludeDir?: string[];
  /** Additional patterns to ignore */
  ignorePatterns?: string[];
  /** Whether to skip default ignore patterns */
  noDefaultIgnore?: boolean;
  /** Include test files */
  includeTests?: boolean;
  /** Group files into components */
  group?: boolean;
  /** Directory depth for grouping */
  groupingDepth?: number;
}

export interface RustExtractionResult {
  graph: Graph;
  stats: {
    filesScanned: number;
    nodesCreated: number;
    edgesCreated: number;
    language: 'rust';
    externalCrates: string[];
  };
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const RUST_EXTENSIONS = ['rs'];

// ═══════════════════════════════════════════════════════════════════════════════
// Extractor
// ═══════════════════════════════════════════════════════════════════════════════

export async function extractRust(options: RustExtractOptions): Promise<RustExtractionResult> {
  const {
    baseDir,
    additionalDirs = [],
    excludeDir = [],
    ignorePatterns = [],
    noDefaultIgnore = false,
    includeTests = false,
    group = false,
    groupingDepth,
  } = options;

  // Build exclude list (Rust-specific: exclude target/)
  const rustExcludes = ['target'];
  const allExcludeDirs = noDefaultIgnore
    ? excludeDir
    : [...new Set([...DEFAULT_IGNORE_DIRS, ...rustExcludes, ...excludeDir])];

  const allDirs = [baseDir, ...additionalDirs];

  // Verify directories exist
  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Directory not found: ${dir}`);
    }
  }

  // Find the src directory (Rust convention)
  let srcDir = baseDir;
  const potentialSrc = path.join(baseDir, 'src');
  if (fs.existsSync(potentialSrc)) {
    srcDir = potentialSrc;
  }

  // Find all Rust files
  const allFiles: string[] = [];
  const searchDirs = srcDir !== baseDir ? [srcDir, ...additionalDirs] : allDirs;
  for (const dir of searchDirs) {
    const resolvedDir = path.resolve(dir);
    const files = findFilesRecursive(resolvedDir, RUST_EXTENSIONS, allExcludeDirs);
    allFiles.push(...files);
  }

  // Filter test files if not included
  let filteredFiles = allFiles;
  if (!includeTests) {
    filteredFiles = allFiles.filter(file => {
      const relativePath = path.relative(baseDir, file);
      return !relativePath.includes('/tests/') &&
             !file.endsWith('_test.rs') &&
             !file.endsWith('.test.rs');
    });
  }

  // Filter by ignore patterns
  filteredFiles = filteredFiles.filter(file => {
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
  const externalCrates = new Set<string>();
  const warnings: string[] = [];

  // Map file paths to module paths
  const fileToModule = new Map<string, string>();
  const moduleToFile = new Map<string, string>();

  for (const file of filteredFiles) {
    const modulePath = filePathToModulePath(file, srcDir);
    fileToModule.set(file, modulePath);
    moduleToFile.set(modulePath, file);

    // Create node
    const nodeId = modulePath;
    nodes[nodeId] = {
      type: 'File',
      description: `Rust: ${path.basename(file)}`,
      path: file,
      layer: inferLayer(file),
    };
  }

  // Parse imports and create edges
  for (const file of filteredFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const modulePath = fileToModule.get(file)!;
    const fromNodeId = modulePath;

    const imports = parseRustImports(content, modulePath);

    for (const imp of imports) {
      if (imp.isExternal) {
        externalCrates.add(imp.crateName || imp.module.split('::')[0]);
        continue;
      }

      // Resolve module path
      const resolvedPath = resolveRustImport(imp, modulePath, moduleToFile);
      if (!resolvedPath) continue;

      const toNodeId = resolvedPath;

      // Skip self-imports
      if (fromNodeId === toNodeId) continue;

      // Skip if target doesn't exist in our codebase
      if (!nodes[toNodeId]) continue;

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

    // Also parse mod declarations
    const modDeclarations = parseModDeclarations(content);
    for (const modName of modDeclarations) {
      // mod foo; -> look for foo.rs or foo/mod.rs
      const possiblePaths = [
        `${modulePath}/${modName}`,  // foo.rs in same dir
        `${modulePath.split('/').slice(0, -1).join('/')}/${modName}`, // sibling
      ];

      for (const possiblePath of possiblePaths) {
        if (nodes[possiblePath]) {
          const edgeKey = `${fromNodeId}|${possiblePath}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edges.push({
              from: fromNodeId,
              to: possiblePath,
              relation: 'depends_on',
            });
          }
          break;
        }
      }
    }
  }

  let graph: Graph = { nodes, edges };

  // Group into components if requested
  if (group) {
    graph = groupIntoComponents(graph, { groupingDepth });
  }

  if (filteredFiles.length === 0) {
    warnings.push('No Rust files found. Check your path.');
  }

  return {
    graph,
    stats: {
      filesScanned: filteredFiles.length,
      nodesCreated: Object.keys(graph.nodes).length,
      edgesCreated: graph.edges.length,
      language: 'rust',
      externalCrates: Array.from(externalCrates),
    },
    warnings,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Import Parsing
// ═══════════════════════════════════════════════════════════════════════════════

interface ParsedRustImport {
  module: string;
  isExternal: boolean;
  isCrate: boolean;
  isSuper: boolean;
  isSelf: boolean;
  crateName?: string;
}

/**
 * Parse Rust use statements from file content.
 */
function parseRustImports(content: string, currentModule: string): ParsedRustImport[] {
  const imports: ParsedRustImport[] = [];

  // Remove comments
  const cleanedContent = removeRustComments(content);

  // Match use statements
  // use crate::foo::bar;
  // use super::foo;
  // use self::foo;
  // use std::collections::HashMap;
  // use foo::bar; (external crate)
  const useRegex = /\buse\s+((?:crate|super|self|[\w]+)(?:::\w+)*)/g;

  let match;
  while ((match = useRegex.exec(cleanedContent)) !== null) {
    const usePath = match[1];

    if (usePath.startsWith('crate::')) {
      imports.push({
        module: usePath.slice(7), // Remove 'crate::'
        isExternal: false,
        isCrate: true,
        isSuper: false,
        isSelf: false,
      });
    } else if (usePath.startsWith('super::')) {
      imports.push({
        module: usePath.slice(7), // Remove 'super::'
        isExternal: false,
        isCrate: false,
        isSuper: true,
        isSelf: false,
      });
    } else if (usePath.startsWith('self::')) {
      imports.push({
        module: usePath.slice(6), // Remove 'self::'
        isExternal: false,
        isCrate: false,
        isSuper: false,
        isSelf: true,
      });
    } else {
      // External crate or std
      const crateName = usePath.split('::')[0];
      imports.push({
        module: usePath,
        isExternal: true,
        isCrate: false,
        isSuper: false,
        isSelf: false,
        crateName,
      });
    }
  }

  return imports;
}

/**
 * Parse mod declarations.
 */
function parseModDeclarations(content: string): string[] {
  const mods: string[] = [];
  const cleanedContent = removeRustComments(content);

  // Match: mod foo; or pub mod foo;
  const modRegex = /\b(?:pub\s+)?mod\s+(\w+)\s*;/g;

  let match;
  while ((match = modRegex.exec(cleanedContent)) !== null) {
    mods.push(match[1]);
  }

  return mods;
}

/**
 * Remove Rust comments from code.
 */
function removeRustComments(content: string): string {
  // Remove block comments
  let cleaned = content.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments
  cleaned = cleaned.replace(/\/\/.*/g, '');
  return cleaned;
}

/**
 * Convert file path to Rust module path.
 * e.g., /project/src/utils/helper.rs -> utils/helper
 */
function filePathToModulePath(filePath: string, srcDir: string): string {
  const relativePath = path.relative(srcDir, filePath);
  // Remove extension and convert to module path
  let modulePath = relativePath
    .replace(/\.rs$/, '')
    .replace(/[\\]/g, '/');

  // Handle mod.rs -> parent module name
  if (modulePath.endsWith('/mod')) {
    modulePath = modulePath.slice(0, -4);
  }

  // Handle lib.rs and main.rs -> crate root
  if (modulePath === 'lib' || modulePath === 'main') {
    modulePath = 'crate';
  }

  return modulePath;
}

/**
 * Resolve a Rust import to a module path.
 */
function resolveRustImport(
  imp: ParsedRustImport,
  currentModule: string,
  moduleToFile: Map<string, string>
): string | null {
  if (imp.isExternal) {
    return null;
  }

  let targetModule: string;

  if (imp.isCrate) {
    // use crate::foo::bar -> foo/bar
    targetModule = imp.module.replace(/::/g, '/');
  } else if (imp.isSuper) {
    // use super::foo -> go up one level, then to foo
    const parts = currentModule.split('/');
    parts.pop(); // Remove current module name
    if (imp.module) {
      parts.push(...imp.module.split('::'));
    }
    targetModule = parts.join('/');
  } else if (imp.isSelf) {
    // use self::foo -> current module's submodule
    const parts = currentModule.split('/');
    parts.push(...imp.module.split('::'));
    targetModule = parts.join('/');
  } else {
    return null;
  }

  // Try to find the module
  if (moduleToFile.has(targetModule)) {
    return targetModule;
  }

  // Try without the last segment (might be an item, not a module)
  const parentModule = targetModule.split('/').slice(0, -1).join('/');
  if (moduleToFile.has(parentModule)) {
    return parentModule;
  }

  return targetModule;
}
