/**
 * GID Schema Validation using Zod
 *
 * Validates graph.yml structure and provides helpful error messages.
 */

import { z } from 'zod';

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
  .passthrough(); // Allow additional properties

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Schema
// ═══════════════════════════════════════════════════════════════════════════════

const EdgeRelationSchema = z.enum([
  'implements',
  'depends_on',
  'calls',
  'reads',
  'writes',
  'tested_by',
  'defined_in',
  'decided_by',
]);

export const EdgeSchema = z
  .object({
    from: z.string().min(1, 'Edge "from" cannot be empty'),
    to: z.string().min(1, 'Edge "to" cannot be empty'),
    relation: EdgeRelationSchema,
    coupling: z.enum(['tight', 'loose']).optional(),
    optional: z.boolean().optional(),
  })
  .passthrough();

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
  nodes: z.record(z.string(), NodeSchema),
  edges: z.array(EdgeSchema),
  integrity_rules: z.array(IntegrityRuleSchema).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Validation Result Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface ValidationError {
  path: string;
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validation Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate graph structure using Zod schema
 */
export function validateSchema(data: unknown): ValidationResult {
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

/**
 * Validate semantic correctness (edge references, etc.)
 */
export function validateSemantics(data: z.infer<typeof GraphSchema>): ValidationResult {
  const errors: ValidationError[] = [];
  const nodeIds = new Set(Object.keys(data.nodes));

  // Check that all edge references exist
  for (const [index, edge] of data.edges.entries()) {
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
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Full validation: schema + semantics
 */
export function validateGraph(data: unknown): ValidationResult {
  // First validate schema
  const schemaResult = validateSchema(data);
  if (!schemaResult.valid) {
    return schemaResult;
  }

  // Then validate semantics
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
    // Simple similarity: contains or starts with
    if (idLower.includes(targetLower) || targetLower.includes(idLower)) {
      matches.push(id);
    }
    // Levenshtein distance check for typos (simplified)
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
