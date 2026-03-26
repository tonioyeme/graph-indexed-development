/**
 * GID YAML Parser
 *
 * Load and save graph.yml files with validation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { Graph, GIDError } from './types.js';
import { validateGraph, ValidationResult } from './schema.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_GRAPH_DIR = '.gid';
export const DEFAULT_GRAPH_FILE = 'graph.yml';

// ═══════════════════════════════════════════════════════════════════════════════
// Load Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find graph.yml in current directory or .gid directory
 */
export function findGraphFile(startDir: string = process.cwd()): string | null {
  // Check .gid/graph.yml first
  const gidPath = path.join(startDir, DEFAULT_GRAPH_DIR, DEFAULT_GRAPH_FILE);
  if (fs.existsSync(gidPath)) {
    return gidPath;
  }

  // Check root graph.yml
  const rootPath = path.join(startDir, DEFAULT_GRAPH_FILE);
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }

  return null;
}

/**
 * Load and parse graph.yml file
 */
export function loadGraph(filePath?: string): Graph {
  // Find file if not specified
  const graphPath = filePath ?? findGraphFile();

  if (!graphPath) {
    throw new GIDError(
      'No graph.yml found. Run "gid init" to create one.',
      'FILE_NOT_FOUND'
    );
  }

  if (!fs.existsSync(graphPath)) {
    throw new GIDError(
      `File not found: ${graphPath}`,
      'FILE_NOT_FOUND',
      { path: graphPath }
    );
  }

  // Read file
  let content: string;
  try {
    content = fs.readFileSync(graphPath, 'utf-8');
  } catch (err) {
    throw new GIDError(
      `Failed to read file: ${graphPath}`,
      'FILE_NOT_FOUND',
      { path: graphPath, error: String(err) }
    );
  }

  // Parse YAML
  let data: unknown;
  try {
    data = yaml.load(content);
  } catch (err) {
    const yamlError = err as yaml.YAMLException;
    throw new GIDError(
      `YAML syntax error: ${yamlError.message}`,
      'PARSE_ERROR',
      {
        line: yamlError.mark?.line,
        column: yamlError.mark?.column,
        snippet: yamlError.mark?.snippet,
      }
    );
  }

  // Validate
  const validation = validateGraph(data);
  if (!validation.valid) {
    throw new GIDError(
      `Invalid graph.yml: ${validation.errors[0].message}`,
      'SCHEMA_ERROR',
      { errors: validation.errors }
    );
  }

  return data as Graph;
}

/**
 * Load graph with detailed validation result
 */
export function loadGraphWithValidation(filePath?: string): {
  graph: Graph | null;
  validation: ValidationResult;
  path: string | null;
} {
  const graphPath = filePath ?? findGraphFile();

  if (!graphPath) {
    return {
      graph: null,
      validation: {
        valid: false,
        errors: [{ path: '', message: 'No graph.yml found' }],
      },
      path: null,
    };
  }

  try {
    const content = fs.readFileSync(graphPath, 'utf-8');
    const data = yaml.load(content);
    const validation = validateGraph(data);

    return {
      graph: validation.valid ? (data as Graph) : null,
      validation,
      path: graphPath,
    };
  } catch (err) {
    if (err instanceof GIDError) {
      return {
        graph: null,
        validation: {
          valid: false,
          errors: [{ path: '', message: err.message }],
        },
        path: graphPath,
      };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Save Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Save graph to YAML file
 */
export function saveGraph(graph: Graph, filePath?: string): string {
  const graphPath = filePath ?? path.join(process.cwd(), DEFAULT_GRAPH_DIR, DEFAULT_GRAPH_FILE);
  const dir = path.dirname(graphPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Convert to YAML with nice formatting
  const content = yaml.dump(graph, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  fs.writeFileSync(graphPath, content, 'utf-8');
  return graphPath;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Template Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new graph from template
 */
export function createGraphFromTemplate(): Graph {
  return {
    nodes: {
      'Example-Feature': {
        type: 'Feature',
        description: 'An example feature to get you started',
        priority: 'core',
      },
      'ExampleService': {
        type: 'Component',
        description: 'An example component that implements the feature',
        layer: 'application',
      },
    },
    edges: [
      {
        from: 'ExampleService',
        to: 'Example-Feature',
        relation: 'implements',
      },
    ],
  };
}

/**
 * Initialize a new graph.yml in the current directory
 */
export function initGraph(targetDir: string = process.cwd()): string {
  const gidDir = path.join(targetDir, DEFAULT_GRAPH_DIR);
  const graphPath = path.join(gidDir, DEFAULT_GRAPH_FILE);

  // Check if already exists
  if (fs.existsSync(graphPath)) {
    throw new GIDError(
      `graph.yml already exists at ${graphPath}`,
      'FILE_NOT_FOUND', // Using this code for "already exists" case
      { path: graphPath }
    );
  }

  // Create template graph
  const graph = createGraphFromTemplate();

  // Add header comment
  const header = `# GID Graph Definition
# This file defines the dependency graph for your project.
# Learn more: https://github.com/tonioyeme/graph-indexed-development

`;

  const yamlContent = yaml.dump(graph, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  // Ensure directory exists
  if (!fs.existsSync(gidDir)) {
    fs.mkdirSync(gidDir, { recursive: true });
  }

  fs.writeFileSync(graphPath, header + yamlContent, 'utf-8');
  return graphPath;
}
