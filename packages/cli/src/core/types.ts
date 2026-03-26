/**
 * GID Core Types
 *
 * Minimal type definitions for MVP.
 * Extended types (Decision, Risk, Constraint) will be added in future versions.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Node Types
// ═══════════════════════════════════════════════════════════════════════════════

export type NodeType =
  | 'Feature'
  | 'Component'
  | 'Interface'
  | 'Data'
  | 'File'
  | 'Test'
  | 'Decision';

export type NodeStatus = 'draft' | 'in_progress' | 'active' | 'deprecated';

export type FeaturePriority = 'core' | 'supporting' | 'generic';

export type ComponentLayer = 'interface' | 'application' | 'domain' | 'infrastructure';

export interface Node {
  type: NodeType;
  description?: string;
  status?: NodeStatus;
  // Feature-specific
  priority?: FeaturePriority;
  // Component-specific
  layer?: ComponentLayer;
  // File-specific
  path?: string;
  // Allow additional properties
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Types
// ═══════════════════════════════════════════════════════════════════════════════

export type EdgeRelation =
  | 'implements'
  | 'depends_on'
  | 'calls'
  | 'reads'
  | 'writes'
  | 'tested_by'
  | 'defined_in'
  | 'decided_by';

export interface Edge {
  from: string;
  to: string;
  relation: EdgeRelation;
  // Optional metadata
  coupling?: 'tight' | 'loose';
  optional?: boolean;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Graph Structure
// ═══════════════════════════════════════════════════════════════════════════════

export interface IntegrityRule {
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  check?: string;
  threshold?: number;
}

export interface Graph {
  nodes: Record<string, Node>;
  edges: Edge[];
  integrity_rules?: IntegrityRule[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Query Results
// ═══════════════════════════════════════════════════════════════════════════════

export interface ImpactResult {
  node: string;
  nodeType: NodeType;
  directDependents: string[];
  transitiveDependents: string[];
  affectedFeatures: string[];
  affectedTests: string[];
}

export interface DependencyResult {
  node: string;
  direct: string[];
  transitive: string[];
}

export interface CommonCauseResult {
  nodeA: string;
  nodeB: string;
  commonDependencies: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════════

export type GIDErrorCode =
  | 'PARSE_ERROR'
  | 'SCHEMA_ERROR'
  | 'NODE_NOT_FOUND'
  | 'EDGE_INVALID'
  | 'CYCLE_DETECTED'
  | 'FILE_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'AI_ERROR';

export class GIDError extends Error {
  constructor(
    message: string,
    public code: GIDErrorCode,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GIDError';
  }
}
