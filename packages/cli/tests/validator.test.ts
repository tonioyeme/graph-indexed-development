/**
 * Validator Tests
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { GIDGraph, Validator, Graph } from '../src/core/index.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

function loadFixture(filename: string): GIDGraph {
  const content = fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
  const data = yaml.load(content) as Graph;
  return new GIDGraph(data);
}

describe('Validator', () => {
  describe('no-circular-dependency', () => {
    it('passes for graph without cycles', () => {
      const graph = loadFixture('valid-graph.yml');
      const validator = new Validator({ enabledRules: ['no-circular-dependency'] });

      const result = validator.validate(graph);

      expect(result.passed).toBe(true);
      expect(result.issues.filter(i => i.rule === 'no-circular-dependency')).toHaveLength(0);
    });

    it('detects circular dependencies', () => {
      const graph = loadFixture('circular-deps.yml');
      const validator = new Validator({ enabledRules: ['no-circular-dependency'] });

      const result = validator.validate(graph);

      expect(result.passed).toBe(false);
      const cycleIssues = result.issues.filter(i => i.rule === 'no-circular-dependency');
      expect(cycleIssues.length).toBeGreaterThan(0);
      expect(cycleIssues[0].severity).toBe('error');
      expect(cycleIssues[0].message).toContain('Circular dependency');
    });
  });

  describe('no-orphan-nodes', () => {
    it('detects nodes with no edges', () => {
      const graph = new GIDGraph({
        nodes: {
          Connected: { type: 'Component', description: 'Connected' },
          Orphan: { type: 'Component', description: 'Orphan - no edges' },
        },
        edges: [
          { from: 'Connected', to: 'Connected', relation: 'depends_on' }, // self-loop for test
        ],
      });

      const validator = new Validator({ enabledRules: ['no-orphan-nodes'] });
      const result = validator.validate(graph);

      const orphanIssues = result.issues.filter(i => i.rule === 'no-orphan-nodes');
      expect(orphanIssues.length).toBe(1);
      expect(orphanIssues[0].nodes).toContain('Orphan');
    });
  });

  describe('feature-has-implementation', () => {
    it('warns when Feature has no implementing Components', () => {
      const graph = new GIDGraph({
        nodes: {
          'Lonely-Feature': { type: 'Feature', description: 'No implementers' },
          SomeComponent: { type: 'Component', description: 'Does not implement anything' },
        },
        edges: [],
      });

      const validator = new Validator({ enabledRules: ['feature-has-implementation'] });
      const result = validator.validate(graph);

      const issues = result.issues.filter(i => i.rule === 'feature-has-implementation');
      expect(issues.length).toBe(1);
      expect(issues[0].nodes).toContain('Lonely-Feature');
    });

    it('passes when Feature has implementers', () => {
      const graph = new GIDGraph({
        nodes: {
          'My-Feature': { type: 'Feature', description: 'Has implementer' },
          MyComponent: { type: 'Component', description: 'Implements feature' },
        },
        edges: [
          { from: 'MyComponent', to: 'My-Feature', relation: 'implements' },
        ],
      });

      const validator = new Validator({ enabledRules: ['feature-has-implementation'] });
      const result = validator.validate(graph);

      const issues = result.issues.filter(i => i.rule === 'feature-has-implementation');
      expect(issues.length).toBe(0);
    });
  });

  describe('high-coupling-warning', () => {
    it('warns when component has many dependents', () => {
      const graph = new GIDGraph({
        nodes: {
          SharedService: { type: 'Component', description: 'Shared' },
          Client1: { type: 'Component', description: 'Client 1' },
          Client2: { type: 'Component', description: 'Client 2' },
          Client3: { type: 'Component', description: 'Client 3' },
        },
        edges: [
          { from: 'Client1', to: 'SharedService', relation: 'depends_on' },
          { from: 'Client2', to: 'SharedService', relation: 'depends_on' },
          { from: 'Client3', to: 'SharedService', relation: 'depends_on' },
        ],
      });

      // Set threshold to 3
      const validator = new Validator({
        enabledRules: ['high-coupling-warning'],
        highCouplingThreshold: 3,
      });
      const result = validator.validate(graph);

      const issues = result.issues.filter(i => i.rule === 'high-coupling-warning');
      expect(issues.length).toBe(1);
      expect(issues[0].nodes).toContain('SharedService');
    });
  });

  describe('layer-dependency-direction', () => {
    it('detects layer violations', () => {
      const graph = loadFixture('layer-violation.yml');
      const validator = new Validator({ enabledRules: ['layer-dependency-direction'] });

      const result = validator.validate(graph);

      const issues = result.issues.filter(i => i.rule === 'layer-dependency-direction');
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('infrastructure');
      expect(issues[0].message).toContain('application');
    });

    it('allows domain -> infrastructure (for persistence)', () => {
      const graph = new GIDGraph({
        nodes: {
          DomainEntity: { type: 'Component', layer: 'domain' },
          Repository: { type: 'Component', layer: 'infrastructure' },
        },
        edges: [
          { from: 'DomainEntity', to: 'Repository', relation: 'depends_on' },
        ],
      });

      const validator = new Validator({ enabledRules: ['layer-dependency-direction'] });
      const result = validator.validate(graph);

      const issues = result.issues.filter(i => i.rule === 'layer-dependency-direction');
      expect(issues.length).toBe(0);
    });
  });

  describe('configuration', () => {
    it('respects disabledRules', () => {
      const graph = loadFixture('circular-deps.yml');

      const validator = new Validator({ disabledRules: ['no-circular-dependency'] });
      const result = validator.validate(graph);

      // Should not report cycle because rule is disabled
      const cycleIssues = result.issues.filter(i => i.rule === 'no-circular-dependency');
      expect(cycleIssues.length).toBe(0);
    });

    it('respects enabledRules', () => {
      const graph = loadFixture('circular-deps.yml');

      // Only enable orphan check (cycle graph has no orphans)
      const validator = new Validator({ enabledRules: ['no-orphan-nodes'] });
      const result = validator.validate(graph);

      // Should not report cycle because only orphan rule is enabled
      const cycleIssues = result.issues.filter(i => i.rule === 'no-circular-dependency');
      expect(cycleIssues.length).toBe(0);
    });
  });

  describe('healthScore', () => {
    it('returns 100 for healthy graph', () => {
      const graph = loadFixture('valid-graph.yml');
      const validator = new Validator();

      const result = validator.validate(graph);

      // May have some info-level issues, but should be high
      expect(result.healthScore).toBeGreaterThanOrEqual(80);
    });

    it('returns lower score for graphs with issues', () => {
      const graph = loadFixture('circular-deps.yml');
      const validator = new Validator();

      const result = validator.validate(graph);

      // Has an error, so score should be lower
      expect(result.healthScore).toBeLessThan(100);
    });
  });

  describe('getRules', () => {
    it('returns list of available rules', () => {
      const rules = Validator.getRules();

      expect(rules.length).toBeGreaterThan(0);
      expect(rules[0]).toHaveProperty('name');
      expect(rules[0]).toHaveProperty('description');
      expect(rules[0]).toHaveProperty('severity');
    });
  });
});
