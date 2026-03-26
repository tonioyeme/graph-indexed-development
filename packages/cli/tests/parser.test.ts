/**
 * Parser Tests
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { validateGraph, validateSchema, validateSemantics } from '../src/core/schema.js';
import { Graph } from '../src/core/types.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

describe('Schema Validation', () => {
  describe('validateSchema', () => {
    it('accepts valid graph', () => {
      const content = fs.readFileSync(path.join(FIXTURES_DIR, 'valid-graph.yml'), 'utf-8');
      const data = yaml.load(content);

      const result = validateSchema(data);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects invalid node type', () => {
      const data = {
        nodes: {
          Test: {
            type: 'InvalidType',  // Invalid!
            description: 'test'
          }
        },
        edges: []
      };

      const result = validateSchema(data);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects missing required fields', () => {
      const data = {
        nodes: {
          Test: {
            // Missing 'type' field
            description: 'test'
          }
        },
        edges: []
      };

      const result = validateSchema(data);

      expect(result.valid).toBe(false);
    });

    it('rejects invalid edge relation', () => {
      const data = {
        nodes: {
          A: { type: 'Component' },
          B: { type: 'Component' }
        },
        edges: [
          { from: 'A', to: 'B', relation: 'invalid_relation' }
        ]
      };

      const result = validateSchema(data);

      expect(result.valid).toBe(false);
    });
  });

  describe('validateSemantics', () => {
    it('detects missing node references', () => {
      const content = fs.readFileSync(path.join(FIXTURES_DIR, 'invalid-reference.yml'), 'utf-8');
      const data = yaml.load(content) as Graph;

      // First validate schema (should pass)
      const schemaResult = validateSchema(data);
      expect(schemaResult.valid).toBe(true);

      // Then validate semantics (should fail)
      const semanticResult = validateSemantics(data);

      expect(semanticResult.valid).toBe(false);
      expect(semanticResult.errors.length).toBeGreaterThan(0);
      expect(semanticResult.errors[0].message).toContain('NonExistentNode');
    });
  });

  describe('validateGraph (full validation)', () => {
    it('validates both schema and semantics', () => {
      const content = fs.readFileSync(path.join(FIXTURES_DIR, 'valid-graph.yml'), 'utf-8');
      const data = yaml.load(content);

      const result = validateGraph(data);

      expect(result.valid).toBe(true);
    });

    it('fails on invalid reference', () => {
      const content = fs.readFileSync(path.join(FIXTURES_DIR, 'invalid-reference.yml'), 'utf-8');
      const data = yaml.load(content);

      const result = validateGraph(data);

      expect(result.valid).toBe(false);
    });
  });
});

describe('Node Types', () => {
  it('accepts all valid node types', () => {
    const validTypes = ['Feature', 'Component', 'Interface', 'Data', 'File', 'Test', 'Decision'];

    for (const type of validTypes) {
      const data = {
        nodes: {
          Test: { type, description: 'test' }
        },
        edges: []
      };

      const result = validateSchema(data);
      expect(result.valid).toBe(true);
    }
  });
});

describe('Edge Relations', () => {
  it('accepts all valid edge relations', () => {
    const validRelations = [
      'implements', 'depends_on', 'calls', 'reads',
      'writes', 'tested_by', 'defined_in', 'decided_by'
    ];

    for (const relation of validRelations) {
      const data = {
        nodes: {
          A: { type: 'Component' },
          B: { type: 'Component' }
        },
        edges: [
          { from: 'A', to: 'B', relation }
        ]
      };

      const result = validateSchema(data);
      expect(result.valid).toBe(true);
    }
  });
});
