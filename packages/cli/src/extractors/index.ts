/**
 * Extractors Module
 *
 * Multi-language dependency graph extraction.
 * Provides auto-detection of project language and appropriate extractor dispatch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Graph } from '../core/types.js';

// Re-export all extractors
export * from './common.js';
export * from './typescript.js';
export * from './python.js';
export * from './rust.js';
export * from './java.js';

// Import extractors for dispatch
import { extractTypeScript, ExtractOptions as TSExtractOptions, ExtractionResult as TSExtractionResult } from './typescript.js';
import { extractPython, PythonExtractOptions, PythonExtractionResult } from './python.js';
import { extractRust, RustExtractOptions, RustExtractionResult } from './rust.js';
import { extractJava, JavaExtractOptions, JavaExtractionResult } from './java.js';
import { groupIntoComponents, GroupingOptions } from './common.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'rust' | 'java';

export interface DetectedLanguage {
  language: SupportedLanguage;
  confidence: number;
  indicators: string[];
}

export interface AutoExtractOptions {
  /** Base directory to extract from */
  baseDir: string;
  /** Additional directories to scan */
  additionalDirs?: string[];
  /** Directories to exclude */
  excludeDir?: string[];
  /** Patterns to ignore */
  ignorePatterns?: string[];
  /** Force specific language (skip auto-detection) */
  language?: SupportedLanguage;
  /** Include test files */
  includeTests?: boolean;
  /** Group files into components */
  group?: boolean;
  /** Directory depth for grouping */
  groupingDepth?: number;
  /** Additional TypeScript-specific options */
  typescript?: Partial<TSExtractOptions>;
}

export interface AutoExtractionResult {
  graph: Graph;
  language: SupportedLanguage;
  stats: {
    filesScanned: number;
    nodesCreated: number;
    edgesCreated: number;
  };
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Language Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Language detection markers.
 */
const LANGUAGE_MARKERS: Record<SupportedLanguage, { files: string[]; extensions: string[] }> = {
  typescript: {
    files: ['tsconfig.json', 'tsconfig.*.json'],
    extensions: ['ts', 'tsx'],
  },
  javascript: {
    files: ['package.json', 'jsconfig.json'],
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
  },
  python: {
    files: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock'],
    extensions: ['py', 'pyi'],
  },
  rust: {
    files: ['Cargo.toml', 'Cargo.lock'],
    extensions: ['rs'],
  },
  java: {
    files: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    extensions: ['java'],
  },
};

/**
 * Detect the primary language of a project.
 * Returns detected languages sorted by confidence.
 */
export function detectLanguages(baseDir: string): DetectedLanguage[] {
  const detected: DetectedLanguage[] = [];

  for (const [lang, markers] of Object.entries(LANGUAGE_MARKERS)) {
    const indicators: string[] = [];
    let confidence = 0;

    // Check for marker files
    for (const file of markers.files) {
      // Handle glob patterns like tsconfig.*.json
      if (file.includes('*')) {
        const pattern = file.replace(/\./g, '\\.').replace(/\*/g, '.*');
        const regex = new RegExp(`^${pattern}$`);
        try {
          const files = fs.readdirSync(baseDir);
          const match = files.find(f => regex.test(f));
          if (match) {
            indicators.push(`Found ${match}`);
            confidence += 40;
          }
        } catch {
          // Ignore
        }
      } else {
        const filePath = path.join(baseDir, file);
        if (fs.existsSync(filePath)) {
          indicators.push(`Found ${file}`);
          confidence += 40;
        }
      }
    }

    // Check for source files with language extensions
    const hasSourceFiles = checkForExtensions(baseDir, markers.extensions);
    if (hasSourceFiles.count > 0) {
      indicators.push(`Found ${hasSourceFiles.count} .${markers.extensions[0]} files`);
      confidence += Math.min(30, hasSourceFiles.count * 5);
    }

    if (confidence > 0) {
      detected.push({
        language: lang as SupportedLanguage,
        confidence: Math.min(100, confidence),
        indicators,
      });
    }
  }

  // Sort by confidence
  return detected.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Check if a directory contains files with given extensions.
 */
function checkForExtensions(dir: string, extensions: string[]): { count: number } {
  let count = 0;
  const maxCheck = 20; // Don't scan entire directory, just check if any exist

  function scan(currentDir: string, depth: number): void {
    if (depth > 3 || count >= maxCheck) return;

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (count >= maxCheck) return;

        if (entry.isDirectory()) {
          // Skip common non-source directories
          if (['node_modules', 'target', 'build', 'dist', '.git', '__pycache__', 'venv', '.venv'].includes(entry.name)) {
            continue;
          }
          scan(path.join(currentDir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).slice(1);
          if (extensions.includes(ext)) {
            count++;
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  scan(dir, 0);
  return { count };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Auto Extract
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Automatically detect project language and extract dependencies.
 */
export async function autoExtract(options: AutoExtractOptions): Promise<AutoExtractionResult> {
  const {
    baseDir,
    additionalDirs = [],
    excludeDir = [],
    ignorePatterns = [],
    language: forcedLanguage,
    includeTests = false,
    group = false,
    groupingDepth,
    typescript: tsOptions = {},
  } = options;

  // Detect or use forced language
  let language: SupportedLanguage;
  if (forcedLanguage) {
    language = forcedLanguage;
  } else {
    const detected = detectLanguages(baseDir);
    if (detected.length === 0) {
      throw new Error(`Could not detect project language in ${baseDir}. Use --language to specify.`);
    }
    language = detected[0].language;
  }

  // Dispatch to appropriate extractor
  let graph: Graph;
  let stats: { filesScanned: number; nodesCreated: number; edgesCreated: number };
  let warnings: string[] = [];

  switch (language) {
    case 'typescript':
    case 'javascript': {
      const result = await extractTypeScript({
        baseDir,
        additionalDirs,
        excludeDir,
        ignorePatterns,
        ...tsOptions,
      });
      graph = result.graph;
      stats = {
        filesScanned: result.stats.filesScanned,
        nodesCreated: result.stats.componentsFound,
        edgesCreated: result.stats.dependenciesFound,
      };
      warnings = result.warnings;
      break;
    }

    case 'python': {
      const result = await extractPython({
        baseDir,
        additionalDirs,
        excludeDir,
        ignorePatterns,
        group: false, // We'll group after if requested
      });
      graph = result.graph;
      stats = {
        filesScanned: result.stats.filesScanned,
        nodesCreated: result.stats.nodesCreated,
        edgesCreated: result.stats.edgesCreated,
      };
      warnings = result.warnings;
      break;
    }

    case 'rust': {
      const result = await extractRust({
        baseDir,
        additionalDirs,
        excludeDir,
        ignorePatterns,
        includeTests,
        group: false, // We'll group after if requested
      });
      graph = result.graph;
      stats = {
        filesScanned: result.stats.filesScanned,
        nodesCreated: result.stats.nodesCreated,
        edgesCreated: result.stats.edgesCreated,
      };
      warnings = result.warnings;
      break;
    }

    case 'java': {
      const result = await extractJava({
        baseDir,
        additionalDirs,
        excludeDir,
        ignorePatterns,
        includeTests,
        group: false, // We'll group after if requested
      });
      graph = result.graph;
      stats = {
        filesScanned: result.stats.filesScanned,
        nodesCreated: result.stats.nodesCreated,
        edgesCreated: result.stats.edgesCreated,
      };
      warnings = result.warnings;
      break;
    }

    default:
      throw new Error(`Unsupported language: ${language}`);
  }

  // Apply grouping if requested (for non-TypeScript, TS handles it internally)
  if (group && language !== 'typescript' && language !== 'javascript') {
    const originalNodes = Object.keys(graph.nodes).length;
    graph = groupIntoComponents(graph, { groupingDepth });
    stats.nodesCreated = Object.keys(graph.nodes).length;
    stats.edgesCreated = graph.edges.length;
    if (originalNodes !== stats.nodesCreated) {
      warnings.push(`Grouped ${originalNodes} files into ${stats.nodesCreated} components`);
    }
  }

  return {
    graph,
    language,
    stats,
    warnings,
  };
}

/**
 * Get supported languages.
 */
export function getSupportedLanguages(): SupportedLanguage[] {
  return ['typescript', 'javascript', 'python', 'rust', 'java'];
}
