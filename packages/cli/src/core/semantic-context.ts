/**
 * Semantic Context Gatherer
 *
 * Gathers rich semantic context from project documentation and code structure
 * for AI-powered semantic analysis.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface DocumentContent {
  path: string;
  name: string;
  content: string;
  type: 'readme' | 'architecture' | 'docs' | 'changelog' | 'other';
}

export interface CodeIdentifier {
  name: string;
  kind: 'file' | 'class' | 'function' | 'interface' | 'type' | 'const';
  path?: string;
  signature?: string;
}

export interface SemanticContext {
  // Project documentation
  docs: DocumentContent[];

  // Code identifiers (names only, not full source)
  identifiers: CodeIdentifier[];

  // Current graph structure summary
  graphSummary: {
    nodeCount: number;
    edgeCount: number;
    nodesByType: Record<string, number>;
    nodesByLayer: Record<string, number>;
    features: string[];
    components: string[];
  };

  // File structure
  files: Array<{
    id: string;
    path?: string;
    type: string;
    layer?: string;
    exports?: string[];
    signatures?: Array<{ name: string; signature: string }>;
    patterns?: string[];
  }>;

  // Dependencies
  edges: Array<{
    from: string;
    to: string;
    relation: string;
  }>;
}

export interface GatherOptions {
  projectRoot?: string;
  maxDocSize?: number; // Max size per doc in chars (default 10000)
  includeChangelog?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Document Scanning
// ═══════════════════════════════════════════════════════════════════════════════

const MARKDOWN_PATTERNS = [
  { pattern: 'README.md', type: 'readme' as const },
  { pattern: 'readme.md', type: 'readme' as const },
  { pattern: 'ARCHITECTURE.md', type: 'architecture' as const },
  { pattern: 'DESIGN.md', type: 'architecture' as const },
  { pattern: 'DESIGN-DOC.md', type: 'architecture' as const },
  { pattern: 'CHANGELOG.md', type: 'changelog' as const },
];

function scanMarkdownFiles(projectRoot: string, options: GatherOptions): DocumentContent[] {
  const docs: DocumentContent[] = [];
  const maxSize = options.maxDocSize ?? 10000;

  // Check root-level markdown files
  for (const { pattern, type } of MARKDOWN_PATTERNS) {
    if (type === 'changelog' && !options.includeChangelog) continue;

    const filePath = path.join(projectRoot, pattern);
    if (fs.existsSync(filePath)) {
      try {
        let content = fs.readFileSync(filePath, 'utf-8');
        if (content.length > maxSize) {
          content = content.slice(0, maxSize) + '\n\n... (truncated)';
        }
        docs.push({
          path: filePath,
          name: pattern,
          content,
          type,
        });
      } catch {
        // Ignore read errors
      }
    }
  }

  // Scan docs/ directory if exists
  const docsDir = path.join(projectRoot, 'docs');
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    try {
      const files = fs.readdirSync(docsDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(docsDir, file);
        try {
          let content = fs.readFileSync(filePath, 'utf-8');
          if (content.length > maxSize) {
            content = content.slice(0, maxSize) + '\n\n... (truncated)';
          }
          docs.push({
            path: filePath,
            name: `docs/${file}`,
            content,
            type: 'docs',
          });
        } catch {
          // Ignore read errors
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  return docs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Code Identifier Extraction
// ═══════════════════════════════════════════════════════════════════════════════

interface GraphNode {
  type?: string;
  path?: string;
  layer?: string;
  exports?: string[];
  signatures?: Array<{ name: string; signature: string; kind?: string }>;
  patterns?: Array<{ pattern: string }>;
  classes?: Array<{ name: string }>;
  functions?: Array<{ name: string; signature?: string }>;
}

interface GraphData {
  nodes: Record<string, GraphNode>;
  edges: Array<{ from: string; to: string; relation: string }>;
}

function extractIdentifiers(graphData: GraphData): CodeIdentifier[] {
  const identifiers: CodeIdentifier[] = [];

  for (const [nodeId, node] of Object.entries(graphData.nodes)) {
    // Add file/component as identifier
    identifiers.push({
      name: nodeId,
      kind: 'file',
      path: node.path,
    });

    // Add exports as identifiers
    if (node.exports) {
      for (const exp of node.exports) {
        identifiers.push({
          name: exp,
          kind: 'function', // Could be function, class, or const
          path: node.path,
        });
      }
    }

    // Add signatures as identifiers with type info
    if (node.signatures) {
      for (const sig of node.signatures) {
        identifiers.push({
          name: sig.name,
          kind: (sig.kind as CodeIdentifier['kind']) || 'function',
          path: node.path,
          signature: sig.signature,
        });
      }
    }

    // Add classes
    if (node.classes) {
      for (const cls of node.classes) {
        identifiers.push({
          name: cls.name,
          kind: 'class',
          path: node.path,
        });
      }
    }

    // Add functions
    if (node.functions) {
      for (const fn of node.functions) {
        identifiers.push({
          name: fn.name,
          kind: 'function',
          path: node.path,
          signature: fn.signature,
        });
      }
    }
  }

  return identifiers;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Graph Summary
// ═══════════════════════════════════════════════════════════════════════════════

function buildGraphSummary(graphData: GraphData) {
  const nodesByType: Record<string, number> = {};
  const nodesByLayer: Record<string, number> = {};
  const features: string[] = [];
  const components: string[] = [];

  for (const [nodeId, node] of Object.entries(graphData.nodes)) {
    // Count by type
    const type = node.type || 'Unknown';
    nodesByType[type] = (nodesByType[type] || 0) + 1;

    // Count by layer
    if (node.layer) {
      nodesByLayer[node.layer] = (nodesByLayer[node.layer] || 0) + 1;
    }

    // Collect features and components
    if (node.type === 'Feature') {
      features.push(nodeId);
    } else if (node.type === 'Component') {
      components.push(nodeId);
    }
  }

  return {
    nodeCount: Object.keys(graphData.nodes).length,
    edgeCount: graphData.edges.length,
    nodesByType,
    nodesByLayer,
    features,
    components,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Gatherer Function
// ═══════════════════════════════════════════════════════════════════════════════

export function gatherSemanticContext(
  graphData: GraphData,
  options: GatherOptions = {}
): SemanticContext {
  const projectRoot = options.projectRoot || process.cwd();

  // Scan documentation
  const docs = scanMarkdownFiles(projectRoot, options);

  // Extract code identifiers
  const identifiers = extractIdentifiers(graphData);

  // Build graph summary
  const graphSummary = buildGraphSummary(graphData);

  // Build file list with relevant info
  const files = Object.entries(graphData.nodes).map(([id, node]) => ({
    id,
    path: node.path,
    type: node.type || 'File',
    layer: node.layer,
    exports: node.exports,
    signatures: node.signatures?.map(s => ({ name: s.name, signature: s.signature })),
    patterns: node.patterns?.map(p => p.pattern),
  }));

  // Collect edges
  const edges = graphData.edges.map(e => ({
    from: e.from,
    to: e.to,
    relation: e.relation,
  }));

  return {
    docs,
    identifiers,
    graphSummary,
    files,
    edges,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt Builder
// ═══════════════════════════════════════════════════════════════════════════════

export function buildSemanticPrompt(context: SemanticContext): string {
  let prompt = `You are analyzing a software project to understand its semantic structure.

## Project Documentation

`;

  // Add documentation
  if (context.docs.length === 0) {
    prompt += `No documentation found.\n\n`;
  } else {
    for (const doc of context.docs) {
      prompt += `### ${doc.name}\n\n${doc.content}\n\n`;
    }
  }

  // Add code structure
  prompt += `## Code Structure

### Graph Summary
- Total nodes: ${context.graphSummary.nodeCount}
- Total edges: ${context.graphSummary.edgeCount}
- Types: ${Object.entries(context.graphSummary.nodesByType).map(([k, v]) => `${k}(${v})`).join(', ')}
- Layers: ${Object.entries(context.graphSummary.nodesByLayer).map(([k, v]) => `${k}(${v})`).join(', ') || 'none assigned'}
- Existing features: ${context.graphSummary.features.join(', ') || 'none'}

### Files and Components
`;

  for (const file of context.files) {
    prompt += `\n**${file.id}** (${file.type}${file.layer ? `, ${file.layer}` : ''})`;
    if (file.exports && file.exports.length > 0) {
      prompt += `\n  Exports: ${file.exports.slice(0, 10).join(', ')}${file.exports.length > 10 ? '...' : ''}`;
    }
    if (file.signatures && file.signatures.length > 0) {
      prompt += `\n  Signatures:`;
      for (const sig of file.signatures.slice(0, 5)) {
        prompt += `\n    - ${sig.name}: ${sig.signature}`;
      }
      if (file.signatures.length > 5) {
        prompt += `\n    ... and ${file.signatures.length - 5} more`;
      }
    }
    if (file.patterns && file.patterns.length > 0) {
      prompt += `\n  Patterns: ${file.patterns.join(', ')}`;
    }
  }

  // Add key identifiers
  prompt += `\n\n### Key Identifiers\n`;
  const classes = context.identifiers.filter(i => i.kind === 'class');
  const functions = context.identifiers.filter(i => i.kind === 'function' && i.signature);

  if (classes.length > 0) {
    prompt += `\nClasses: ${classes.map(c => c.name).join(', ')}`;
  }
  if (functions.length > 0) {
    prompt += `\nKey functions: ${functions.slice(0, 20).map(f => f.name).join(', ')}${functions.length > 20 ? '...' : ''}`;
  }

  // Add analysis request
  prompt += `

## Task

Based on the documentation and code structure above, provide semantic analysis:

1. **Features**: What user-perceivable features does this project provide? List each with:
   - name: Feature identifier (PascalCase, e.g., "GraphQuerying")
   - description: One sentence describing the feature
   - components: Which files/components implement this feature

2. **Layers**: For each file/component without a layer, suggest the appropriate layer:
   - interface: User-facing (CLI commands, API routes, UI components)
   - application: Business logic, orchestration, services
   - domain: Core logic, entities, types
   - infrastructure: External integrations, file I/O, database

3. **Descriptions**: For components lacking descriptions, suggest one-sentence descriptions.

IMPORTANT about Features:
- Features are USER-PERCEIVABLE capabilities, NOT code classes
- Use human-readable names like "Graph Querying" or "Code Extraction" (NOT "GraphQuerying")
- Features describe WHAT the system does for users, not HOW it's implemented
- Example: "Impact Analysis" (feature) vs "QueryEngine" (code class)

Respond in JSON format:
\`\`\`json
{
  "features": [
    { "name": "Human Readable Name", "description": "...", "components": ["nodeId1", "nodeId2"] }
  ],
  "layerAssignments": [
    { "nodeId": "...", "layer": "interface|application|domain|infrastructure", "reason": "..." }
  ],
  "descriptions": [
    { "nodeId": "...", "description": "..." }
  ]
}
\`\`\``;

  return prompt;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Parse AI Response
// ═══════════════════════════════════════════════════════════════════════════════

export interface SemanticProposal {
  features: Array<{
    name: string;
    description: string;
    components: string[];
  }>;
  layerAssignments: Array<{
    nodeId: string;
    layer: string;
    reason: string;
  }>;
  descriptions: Array<{
    nodeId: string;
    description: string;
  }>;
}

export function parseSemanticResponse(response: string): SemanticProposal | null {
  // Extract JSON from response (may be wrapped in markdown code blocks)
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : response;

  try {
    const parsed = JSON.parse(jsonStr.trim());
    return {
      features: parsed.features || [],
      layerAssignments: parsed.layerAssignments || [],
      descriptions: parsed.descriptions || [],
    };
  } catch {
    // Try to find JSON object in the response
    const objectMatch = response.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        return {
          features: parsed.features || [],
          layerAssignments: parsed.layerAssignments || [],
          descriptions: parsed.descriptions || [],
        };
      } catch {
        return null;
      }
    }
    return null;
  }
}
