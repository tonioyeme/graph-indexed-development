# Edge Weights Design

## Summary

Add numeric weight and metadata to GID edges, enabling weighted graph traversal, smarter impact analysis, and prioritized dependency chains. Edges currently carry `relation`, `coupling`, and `optional` — this adds quantitative strength signals derived from code analysis and usage patterns.

## Motivation

In real codebases, not all dependencies are equal:

- A function called 50 times is a stronger dependency than one called once
- A call inside a `try/except` block is weaker (error-path, not critical path)
- `self.method()` is a tighter coupling than a bare `func()` call
- An edge discovered via AST is higher confidence than one inferred from naming

Without weights, `gid_query_impact` and `gid_query_deps` treat every edge the same. This produces noisy results — every transitive dependency looks equally important. Weights let us rank and filter.

### Real-World Validation (SWE-bench)

We validated this design in the SWE-bench coding agent, where a tree-sitter-based code graph drives bug localization. Adding edge weights to causal chain traversal (BFS → weighted best-first search) improved hypothesis ranking quality — the agent finds the actual buggy code faster because high-weight paths (frequently called, critical-path code) are explored first.

Key findings:
- **Call count matters**: Functions called 50x are more likely to surface in bug reports than functions called once
- **Error-path detection matters**: Calls inside `try/except/if-error` blocks are defensive code, not primary flow
- **Confidence tiers work**: `self.method()` (0.9) vs `module.func()` (0.8) vs bare `func()` (0.5) correlates with coupling strength

## Edge Weight Model

### New Edge Fields

```typescript
export interface Edge {
  from: string;
  to: string;
  relation: EdgeRelation;
  coupling?: 'tight' | 'loose';
  optional?: boolean;
  description?: string;

  // NEW: Weight & metadata
  weight?: number;           // 0.0–1.0, composite strength (default: 0.5)
  call_count?: number;       // How many times `from` calls `to` (code edges)
  confidence?: number;       // 0.0–1.0, how certain we are this edge exists
  in_error_path?: boolean;   // Is this call inside try/except/error handling?
  source?: 'ast' | 'semantic' | 'manual' | 'inferred';  // How was this edge discovered?
}
```

### Weight Computation

For code-level edges (`calls`, `depends_on`, `implements`, etc.):

```
weight = w1 * normalize(call_count) + w2 * confidence + w3 * error_path_penalty
```

Default weights:
- `w1 = 0.4` — call frequency (more calls = stronger dependency)
- `w2 = 0.4` — confidence (AST-derived = high, inferred = low)
- `w3 = 0.2` — error path penalty (in_error_path → 0.3, else 1.0)

For semantic-level edges (`enables`, `blocks`, `requires`, etc.):
- Weight defaults to `0.5` unless manually specified
- `coupling: 'tight'` → weight boosted by 0.2
- `coupling: 'loose'` → weight reduced by 0.2

### Confidence Tiers

| Pattern | Confidence | Rationale |
|---------|-----------|-----------|
| `self.method()` | 0.9 | Intra-class, tight coupling |
| `module.func()` | 0.8 | Explicit module reference |
| `super().method()` | 0.85 | Inheritance chain |
| `from X import Y; Y()` | 0.8 | Direct import + call |
| `bare_func()` | 0.5 | Could be local, builtin, or imported |
| Name-inferred | 0.3 | Guessed from naming patterns |

### Error Path Detection

A call is `in_error_path = true` when it appears inside:
- `try/except` blocks (Python), `try/catch` (JS/TS/Java/Rust)
- `if err != nil` blocks (Go)
- Functions whose name contains `error`, `fallback`, `retry`, `recover`
- `catch` clauses or `finally` blocks

Error-path calls are real dependencies but typically defensive — they handle failures rather than drive core logic.

## Impact on Existing Tools

### `gid_query_impact` — Weighted Impact Analysis

Currently: BFS from changed node, all edges equal.

With weights: **Weighted best-first search**. High-weight edges explored first. Low-weight edges (error paths, inferred) deprioritized.

```
impactScore(node) = sum(incoming_edge_weights) * depth_decay
```

This means changing a node that's called 100 times via high-confidence edges produces a higher impact score than one called twice via inferred edges.

### `gid_query_deps` — Weighted Dependency Chains

Add optional `minWeight` filter:

```typescript
gid_query_deps({
  nodeId: "UserService",
  direction: "dependents",
  depth: 3,
  minWeight: 0.6  // Only show strong dependencies
})
```

### `gid_query_path` — Weighted Shortest Path

Currently: BFS shortest path (fewest hops).

With weights: Option for **strongest path** (highest minimum weight along path) or **weakest link** analysis.

### `gid_advise` — Weight-Aware Health Checks

New health rules:
- **Warn**: Node with >10 high-weight incoming edges (god object risk)
- **Info**: Cluster of low-confidence edges (may need verification)
- **Warn**: Critical-path node with no `tested_by` edge

## Schema Changes

### graph.yml

Edges gain optional weight fields:

```yaml
edges:
  - from: AuthController
    to: UserService
    relation: calls
    weight: 0.85
    call_count: 47
    confidence: 0.9
    in_error_path: false

  - from: ErrorHandler
    to: Logger
    relation: calls
    weight: 0.35
    call_count: 12
    confidence: 0.8
    in_error_path: true
```

### Backward Compatibility

All new fields are optional. Existing graphs work unchanged — missing weight defaults to `0.5`, missing confidence to `0.5`, missing `in_error_path` to `false`.

## Tool Changes

### `gid_extract` — Auto-Compute Weights

When extracting from code, compute weights automatically:
1. Parse AST → count call sites per edge
2. Detect error-path context for each call
3. Assign confidence based on call pattern
4. Compute composite weight

### `gid_edit_graph` — Manual Weight Setting

Allow setting weight fields when adding/updating edges:

```json
{
  "action": "add_edge",
  "edge": {
    "from": "A",
    "to": "B",
    "relation": "calls",
    "weight": 0.9,
    "confidence": 0.85
  }
}
```

### New Tool: `gid_reweight` (Optional)

Recompute all edge weights from current code analysis. Useful after major refactors.

```
gid_reweight({ graphPath: "..." })
```

## Implementation Plan

### Phase 1: Type System + Schema
- Add weight fields to `Edge` interface in `types.ts`
- Update `schema.ts` validation to accept new fields
- Update `parser.ts` to read/write weight fields
- Backward-compatible: all new fields optional with defaults

### Phase 2: Weight Computation in `gid_extract`
- Extend language extractors (TypeScript, Python, Rust, Java) to count call sites
- Add error-path detection per language
- Compute confidence based on call pattern
- Calculate composite weight

### Phase 3: Weighted Traversal in Query Tools
- `gid_query_impact`: weighted best-first search
- `gid_query_deps`: `minWeight` filter
- `gid_query_path`: strongest-path option
- `gid_advise`: weight-aware health rules

### Phase 4: Visualization
- `gid_visual`: edge thickness proportional to weight
- Color coding: high confidence (solid) vs low confidence (dashed)
- Error-path edges in a distinct style (e.g., dotted red)

## Open Questions

1. **Should weight be stored or computed on-the-fly?** Stored is faster for queries but can go stale. Recommendation: store in graph.yml, recompute with `gid_reweight`.
2. **Weight normalization across projects?** Different projects have different call-count ranges. Use per-graph normalization (max call_count in graph = 1.0).
3. **Edge deduplication**: If A calls B via 3 different paths (direct, via import, via re-export), should this be one edge with call_count=3 or three edges? Recommendation: one edge, aggregated count.
