/**
 * Java Extractor
 *
 * Extracts dependency graph from Java projects using regex-based parsing.
 *
 * Supported patterns:
 * - import com.example.package.ClassName;
 * - import com.example.package.*;
 * - import static com.example.Utils.method;
 * - package com.example.mypackage;
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

export interface JavaExtractOptions {
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
  /** Include test files */
  includeTests?: boolean;
  /** Group files into components */
  group?: boolean;
  /** Directory depth for grouping */
  groupingDepth?: number;
}

export interface JavaExtractionResult {
  graph: Graph;
  stats: {
    filesScanned: number;
    nodesCreated: number;
    edgesCreated: number;
    language: 'java';
    packages: string[];
  };
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const JAVA_EXTENSIONS = ['java'];

// Common Java standard library packages to skip
const JAVA_STD_PACKAGES = [
  'java.',
  'javax.',
  'sun.',
  'com.sun.',
  'jdk.',
  'org.w3c.',
  'org.xml.',
  'org.omg.',
  'org.ietf.',
];

// ═══════════════════════════════════════════════════════════════════════════════
// Extractor
// ═══════════════════════════════════════════════════════════════════════════════

export async function extractJava(options: JavaExtractOptions): Promise<JavaExtractionResult> {
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

  // Build exclude list (Java-specific: exclude build directories)
  const javaExcludes = ['target', 'build', '.gradle', '.mvn', 'out'];
  const allExcludeDirs = noDefaultIgnore
    ? excludeDir
    : [...new Set([...DEFAULT_IGNORE_DIRS, ...javaExcludes, ...excludeDir])];

  const allDirs = [baseDir, ...additionalDirs];

  // Verify directories exist
  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Directory not found: ${dir}`);
    }
  }

  // Find source directories (Maven/Gradle convention)
  const srcDirs: string[] = [];
  for (const dir of allDirs) {
    const mavenSrc = path.join(dir, 'src', 'main', 'java');
    const gradleSrc = path.join(dir, 'src', 'main', 'java');
    const simpleSrc = path.join(dir, 'src');

    if (fs.existsSync(mavenSrc)) {
      srcDirs.push(mavenSrc);
      if (includeTests) {
        const testSrc = path.join(dir, 'src', 'test', 'java');
        if (fs.existsSync(testSrc)) srcDirs.push(testSrc);
      }
    } else if (fs.existsSync(simpleSrc)) {
      srcDirs.push(simpleSrc);
    } else {
      srcDirs.push(dir);
    }
  }

  // Find all Java files
  const allFiles: string[] = [];
  for (const dir of srcDirs) {
    const resolvedDir = path.resolve(dir);
    const files = findFilesRecursive(resolvedDir, JAVA_EXTENSIONS, allExcludeDirs);
    allFiles.push(...files);
  }

  // Filter test files if not included
  let filteredFiles = allFiles;
  if (!includeTests) {
    filteredFiles = allFiles.filter(file => {
      const relativePath = path.relative(baseDir, file);
      return !relativePath.includes('/test/') &&
             !relativePath.includes('/tests/') &&
             !file.endsWith('Test.java') &&
             !file.endsWith('Tests.java') &&
             !file.endsWith('TestCase.java');
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
  const allPackages = new Set<string>();
  const warnings: string[] = [];

  // First pass: gather all classes and their packages
  const classToFile = new Map<string, string>();
  const fileToClass = new Map<string, string>();
  const packageClasses = new Map<string, string[]>();

  for (const file of filteredFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const parsed = parseJavaFile(content, file);

    if (parsed.packageName) {
      allPackages.add(parsed.packageName);
    }

    const fullClassName = parsed.packageName
      ? `${parsed.packageName}.${parsed.className}`
      : parsed.className;

    classToFile.set(fullClassName, file);
    fileToClass.set(file, fullClassName);

    // Track classes per package
    if (parsed.packageName) {
      if (!packageClasses.has(parsed.packageName)) {
        packageClasses.set(parsed.packageName, []);
      }
      packageClasses.get(parsed.packageName)!.push(fullClassName);
    }

    // Create node
    const nodeId = fullClassName.replace(/\./g, '/');
    nodes[nodeId] = {
      type: 'File',
      description: `Java: ${parsed.className}`,
      path: file,
      layer: inferLayer(file),
    };
  }

  // Second pass: parse imports and create edges
  for (const file of filteredFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const fullClassName = fileToClass.get(file)!;
    const fromNodeId = fullClassName.replace(/\./g, '/');

    const imports = parseJavaImports(content);

    for (const imp of imports) {
      // Skip Java standard library
      if (JAVA_STD_PACKAGES.some(pkg => imp.startsWith(pkg))) {
        continue;
      }

      // Handle wildcard imports
      if (imp.endsWith('.*')) {
        const packageName = imp.slice(0, -2);
        const classesInPackage = packageClasses.get(packageName) || [];
        for (const targetClass of classesInPackage) {
          if (targetClass === fullClassName) continue;

          const toNodeId = targetClass.replace(/\./g, '/');
          const edgeKey = `${fromNodeId}|${toNodeId}`;
          if (!edgeSet.has(edgeKey) && nodes[toNodeId]) {
            edgeSet.add(edgeKey);
            edges.push({
              from: fromNodeId,
              to: toNodeId,
              relation: 'depends_on',
            });
          }
        }
        continue;
      }

      // Regular import
      if (!classToFile.has(imp)) continue;

      const toNodeId = imp.replace(/\./g, '/');

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
    warnings.push('No Java files found. Check your path.');
  }

  return {
    graph,
    stats: {
      filesScanned: filteredFiles.length,
      nodesCreated: Object.keys(graph.nodes).length,
      edgesCreated: graph.edges.length,
      language: 'java',
      packages: Array.from(allPackages),
    },
    warnings,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Parsing
// ═══════════════════════════════════════════════════════════════════════════════

interface ParsedJavaFile {
  packageName: string | null;
  className: string;
  imports: string[];
}

/**
 * Parse Java file for package, class name, and imports.
 */
function parseJavaFile(content: string, filePath: string): ParsedJavaFile {
  const cleanedContent = removeJavaComments(content);

  // Parse package
  const packageMatch = cleanedContent.match(/^\s*package\s+([\w.]+)\s*;/m);
  const packageName = packageMatch ? packageMatch[1] : null;

  // Get class name from file name (Java convention: ClassName.java)
  const className = path.basename(filePath, '.java');

  // Parse imports
  const imports = parseJavaImports(cleanedContent);

  return { packageName, className, imports };
}

/**
 * Parse Java import statements.
 */
function parseJavaImports(content: string): string[] {
  const imports: string[] = [];
  const cleanedContent = removeJavaComments(content);

  // Match: import com.example.ClassName;
  // Match: import com.example.*;
  // Match: import static com.example.Utils.method;
  const importRegex = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

  let match;
  while ((match = importRegex.exec(cleanedContent)) !== null) {
    let importPath = match[1];

    // For static imports, remove the method/field name to get the class
    if (content.includes('import static')) {
      // import static com.example.Utils.method -> com.example.Utils
      const parts = importPath.split('.');
      if (parts.length > 1 && !importPath.endsWith('.*')) {
        // Check if last part starts with lowercase (likely a method/field)
        const lastPart = parts[parts.length - 1];
        if (lastPart[0] === lastPart[0].toLowerCase()) {
          importPath = parts.slice(0, -1).join('.');
        }
      }
    }

    imports.push(importPath);
  }

  return imports;
}

/**
 * Remove Java comments from code.
 */
function removeJavaComments(content: string): string {
  // Remove block comments
  let cleaned = content.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments
  cleaned = cleaned.replace(/\/\/.*/g, '');
  return cleaned;
}
