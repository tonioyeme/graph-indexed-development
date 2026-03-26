/**
 * QueryEngine Tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { GIDGraph, QueryEngine, Graph } from '../src/core/index.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

describe('QueryEngine', () => {
  let graph: GIDGraph;
  let engine: QueryEngine;

  beforeAll(() => {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, 'valid-graph.yml'), 'utf-8');
    const data = yaml.load(content) as Graph;
    graph = new GIDGraph(data);
    engine = new QueryEngine(graph);
  });

  describe('getImpact', () => {
    it('returns direct dependents', () => {
      const result = engine.getImpact('ComponentA');

      // ComponentB depends on ComponentA
      expect(result.directDependents).toContain('ComponentB');
    });

    it('returns transitive dependents', () => {
      const result = engine.getImpact('ComponentA');

      // ComponentC depends on ComponentB which depends on ComponentA
      // So ComponentC is a transitive dependent of ComponentA
      expect(result.transitiveDependents).toContain('ComponentC');
    });

    it('returns affected features', () => {
      const result = engine.getImpact('ComponentA');

      // ComponentA implements Feature-A
      // ComponentB (dependent) implements Feature-B
      expect(result.affectedFeatures).toContain('Feature-A');
      expect(result.affectedFeatures).toContain('Feature-B');
    });

    it('returns affected tests', () => {
      const result = engine.getImpact('ComponentA');

      // ComponentA is tested_by TestA
      expect(result.affectedTests).toContain('TestA');
    });

    it('throws for non-existent node', () => {
      expect(() => engine.getImpact('NonExistent')).toThrow();
    });
  });

  describe('getDependencies', () => {
    it('returns direct dependencies', () => {
      const result = engine.getDependencies('ComponentB');

      // ComponentB depends on ComponentA and SharedService
      expect(result.direct).toContain('ComponentA');
      expect(result.direct).toContain('SharedService');
    });

    it('returns transitive dependencies', () => {
      const result = engine.getDependencies('ComponentC');

      // ComponentC -> ComponentB -> ComponentA -> SharedService
      // Direct: ComponentB
      // Transitive: ComponentA, SharedService
      expect(result.direct).toContain('ComponentB');
      expect(result.transitive).toContain('ComponentA');
    });
  });

  describe('getDependents', () => {
    it('returns direct dependents', () => {
      const result = engine.getDependents('SharedService');

      // ComponentA, ComponentB depend on SharedService
      expect(result.direct).toContain('ComponentA');
      expect(result.direct).toContain('ComponentB');
    });

    it('returns transitive dependents', () => {
      const result = engine.getDependents('SharedService');

      // ComponentC is transitive dependent via ComponentB
      expect(result.transitive).toContain('ComponentC');
    });
  });

  describe('getCommonCause', () => {
    it('finds common dependencies', () => {
      const result = engine.getCommonCause('ComponentA', 'ComponentB');

      // Both depend on SharedService
      expect(result.commonDependencies).toContain('SharedService');
    });

    it('returns empty for nodes with no common dependencies', () => {
      const result = engine.getCommonCause('Feature-A', 'Feature-B');

      // Features don't have dependencies in this graph
      expect(result.commonDependencies).toHaveLength(0);
    });
  });

  describe('findPath', () => {
    it('finds path between dependent nodes', () => {
      const path = engine.findPath('ComponentC', 'SharedService');

      // ComponentC -> ComponentB -> SharedService (or ComponentC -> ComponentB -> ComponentA -> SharedService)
      expect(path).not.toBeNull();
      expect(path![0]).toBe('ComponentC');
      expect(path![path!.length - 1]).toBe('SharedService');
    });

    it('returns null when no path exists', () => {
      const path = engine.findPath('SharedService', 'ComponentC');

      // SharedService doesn't depend on anything
      expect(path).toBeNull();
    });
  });

  describe('getHighCouplingNodes', () => {
    it('finds nodes with many dependents', () => {
      const result = engine.getHighCouplingNodes(2);

      // SharedService has 2+ dependents
      const sharedService = result.find(r => r.nodeId === 'SharedService');
      expect(sharedService).toBeDefined();
      expect(sharedService!.dependentCount).toBeGreaterThanOrEqual(2);
    });
  });
});
