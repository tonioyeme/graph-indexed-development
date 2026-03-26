/**
 * GID Schema Validation using Zod
 *
 * Supports dynamic relation types:
 * - Code-level relations: preset (implements, depends_on, calls, etc.)
 * - Semantic-level relations: dynamic, discovered from documents
 */

import { z } from 'zod';
import { CODE_RELATIONS, SEMANTIC_RELATIONS_PRESET } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Preset Relations (for suggestions and defaults)
// ═══════════════════════════════════════════════════════════════════════════════

export const PRESET_CODE_RELATIONS = [...CODE_RELATIONS];
export const PRESET_SEMANTIC_RELATIONS = [...SEMANTIC_RELATIONS_PRESET];
export const ALL_PRESET_RELATIONS = [...PRESET_CODE_RELATIONS, ...PRESET_SEMANTIC_RELATIONS];

// ═══════════════════════════════════════════════════════════════════════════════
// Node Schema
// ═══════════════════════════════════════════════════════════════════════════════

const NodeTypeSchema = z.enum([
  'Feature',
  'Component',
  'Interface',
  'Data',
  'File',
  'Test',
  'Decision',
]);

const NodeStatusSchema = z.enum(['draft', 'in_progress', 'active', 'deprecated']);

const FeaturePrioritySchema = z.enum(['core', 'supporting', 'generic']);

const ComponentLayerSchema = z.enum(['interface', 'application', 'domain', 'infrastructure']);

export const NodeSchema = z
  .object({
    type: NodeTypeSchema,
    description: z.string().optional(),
    status: NodeStatusSchema.optional(),
    priority: FeaturePrioritySchema.optional(),
    layer: ComponentLayerSchema.optional(),
    path: z.string().optional(),
  })
  .passthrough();

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Schema - Dynamic Relations
// ═══════════════════════════════════════════════════════════════════════════════

// Relation is now any non-empty string (validated against meta.schema dynamically)
const EdgeRelationSchema = z.string().min(1, 'Relation cannot be empty');

export const EdgeSchema = z
  .object({
    from: z.string().min(1, 'Edge "from" cannot be empty'),
    to: z.string().min(1, 'Edge "to" cannot be empty'),
    relation: EdgeRelationSchema,
    coupling: z.enum(['tight', 'loose']).optional(),
    optional: z.boolean().optional(),
    description: z.string().optional(),
  })
  .passthrough();

// ═══════════════════════════════════════════════════════════════════════════════
// Meta Schema - Dynamic Relation Registry
// ═══════════════════════════════════════════════════════════════════════════════

const DiscoveredRelationSchema = z.object({
  relation: z.string().min(1),
  category: z.enum(['code', 'semantic']),
  source: z.string().optional(),
  pattern: z.string().optional(),
  added_by: z.enum(['gid_extract', 'gid_design', 'gid_complete', 'user_request']).optional(),
  description: z.string().optional(),
});

const MetaSchemaSchema = z.object({
  relations: z.object({
    code: z.array(z.string()).optional(),
    semantic: z.array(z.string()).optional(),
  }).optional(),
  discovered: z.array(DiscoveredRelationSchema).optional(),
});

const GraphMetaSchema = z.object({
  version: z.string().optional(),
  domain: z.string().optional(),
  schema: MetaSchemaSchema.optional(),
}).passthrough();

// ═══════════════════════════════════════════════════════════════════════════════
// Integrity Rule Schema
// ═══════════════════════════════════════════════════════════════════════════════

const IntegrityRuleSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  check: z.string().optional(),
  threshold: z.number().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Full Graph Schema
// ═══════════════════════════════════════════════════════════════════════════════

export const GraphSchema = z.object({
  meta: GraphMetaSchema.optional(),
  nodes: z.record(z.string(), NodeSchema),
  edges: z.array(EdgeSchema),
  integrity_rules: z.array(IntegrityRuleSchema).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Dynamic Relation Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get all valid relations for a graph (preset + custom from meta.schema)
 */
export function getValidRelations(graphData?: z.infer<typeof GraphSchema>): {
  code: string[];
  semantic: string[];
  all: string[];
} {
  const code = [...PRESET_CODE_RELATIONS];
  const semantic = [...PRESET_SEMANTIC_RELATIONS];

  // Add custom relations from meta.schema if present
  if (graphData?.meta?.schema?.relations) {
    const customCode = graphData.meta.schema.relations.code ?? [];
    const customSemantic = graphData.meta.schema.relations.semantic ?? [];

    for (const r of customCode) {
      if (!code.includes(r)) code.push(r);
    }
    for (const r of customSemantic) {
      if (!semantic.includes(r)) semantic.push(r);
    }
  }

  // Also include discovered relations
  if (graphData?.meta?.schema?.discovered) {
    for (const d of graphData.meta.schema.discovered) {
      if (d.category === 'code' && !code.includes(d.relation)) {
        code.push(d.relation);
      } else if (d.category === 'semantic' && !semantic.includes(d.relation)) {
        semantic.push(d.relation);
      }
    }
  }

  return {
    code,
    semantic,
    all: [...code, ...semantic],
  };
}

/**
 * Check if a relation is valid for the given graph
 */
export function isValidRelation(relation: string, graphData?: z.infer<typeof GraphSchema>): boolean {
  const { all } = getValidRelations(graphData);
  return all.includes(relation);
}

/**
 * Categorize a relation as code or semantic
 */
export function getRelationCategory(relation: string, graphData?: z.infer<typeof GraphSchema>): 'code' | 'semantic' | 'unknown' {
  const { code, semantic } = getValidRelations(graphData);
  if (code.includes(relation)) return 'code';
  if (semantic.includes(relation)) return 'semantic';
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validation Result Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface SchemaValidationError {
  path: string;
  message: string;
  suggestion?: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validation Functions
// ═══════════════════════════════════════════════════════════════════════════════

export function validateSchema(data: unknown): SchemaValidationResult {
  const result = GraphSchema.safeParse(data);

  if (!result.success) {
    return {
      valid: false,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        suggestion: getSuggestionForZodError(issue),
      })),
    };
  }

  return { valid: true, errors: [] };
}

export function validateSemantics(data: z.infer<typeof GraphSchema>): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  const nodeIds = new Set(Object.keys(data.nodes));
  const validRelations = getValidRelations(data);

  for (const [index, edge] of data.edges.entries()) {
    // Validate node references
    if (!nodeIds.has(edge.from)) {
      errors.push({
        path: `edges[${index}].from`,
        message: `Node "${edge.from}" not found`,
        suggestion: findSimilarNode(edge.from, nodeIds),
      });
    }
    if (!nodeIds.has(edge.to)) {
      errors.push({
        path: `edges[${index}].to`,
        message: `Node "${edge.to}" not found`,
        suggestion: findSimilarNode(edge.to, nodeIds),
      });
    }

    // Validate relation (warning for unknown, not error - allows discovery)
    if (!validRelations.all.includes(edge.relation)) {
      // Check for similar relations (typo detection)
      const similarRelation = findSimilarRelation(edge.relation, validRelations.all);
      errors.push({
        path: `edges[${index}].relation`,
        message: `Unknown relation "${edge.relation}" - consider adding to meta.schema.relations`,
        suggestion: similarRelation
          ? `Did you mean "${similarRelation}"? Or add to meta.schema.relations.semantic`
          : `Add "${edge.relation}" to meta.schema.relations.semantic to register it`,
      });
    }
  }

  return {
    valid: errors.filter(e => !e.path.includes('.relation')).length === 0, // Relations are warnings, not errors
    errors,
  };
}

/**
 * Find similar relation name (typo detection)
 */
function findSimilarRelation(target: string, relations: string[]): string | undefined {
  const targetLower = target.toLowerCase();

  for (const rel of relations) {
    const relLower = rel.toLowerCase();
    // Check substring match
    if (relLower.includes(targetLower) || targetLower.includes(relLower)) {
      return rel;
    }
    // Check Levenshtein distance
    if (levenshteinDistance(targetLower, relLower) <= 2) {
      return rel;
    }
  }

  return undefined;
}

export function validateGraph(data: unknown): SchemaValidationResult {
  const schemaResult = validateSchema(data);
  if (!schemaResult.valid) {
    return schemaResult;
  }

  const semanticResult = validateSemantics(data as z.infer<typeof GraphSchema>);
  return semanticResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

function getSuggestionForZodError(issue: z.ZodIssue): string | undefined {
  if (issue.code === 'invalid_enum_value') {
    const options = (issue as z.ZodInvalidEnumValueIssue).options;
    return `Valid options: ${options.join(', ')}`;
  }
  if (issue.code === 'invalid_type') {
    return `Expected ${issue.expected}, got ${issue.received}`;
  }
  return undefined;
}

function findSimilarNode(target: string, nodeIds: Set<string>): string | undefined {
  const targetLower = target.toLowerCase();
  const matches: string[] = [];

  for (const id of nodeIds) {
    const idLower = id.toLowerCase();
    if (idLower.includes(targetLower) || targetLower.includes(idLower)) {
      matches.push(id);
    }
    if (levenshteinDistance(targetLower, idLower) <= 2) {
      matches.push(id);
    }
  }

  if (matches.length > 0) {
    const unique = [...new Set(matches)];
    return `Did you mean: ${unique.slice(0, 3).join(', ')}?`;
  }

  return undefined;
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
