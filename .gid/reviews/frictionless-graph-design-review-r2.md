# Review R2: Frictionless Graph Operations Design

Second review after R1 findings were applied. Verified all claims against actual source code.

**✅ All 12 Findings Applied (2026-04-07)**

## 🔴 Critical (blocks implementation)

### FINDING-R2-1: ✅ Applied — `merge_feature()` logic rewritten
Rewrote to: find old tasks via implements edges in EXISTING graph → remove → add ALL incoming → add implements edges → dedup → fuzzy resolve.

### FINDING-R2-2: ✅ Applied — Edge dedup added
Added `add_edge_dedup()` helper. Used in both `merge_feature()` and noted for RustClaw GidDesignTool fix.

### FINDING-R2-3: ✅ Applied — Full CLI changes specified
Added clap struct with `--merge`, `--scope`, `--dry-run`. Full branching logic spelled out. Effort estimate updated to ~150 lines.

## 🟡 Important (should fix before implementation)

### FINDING-R2-4: ✅ Applied — Two-tier separator strategy
Split step 3 into 3a (structural: `:`, `-`, `/`) and 3b (word: `_` fallback).

### FINDING-R2-5: ✅ Applied — Uses QueryEngine
Replaced raw `edges_from`/`edges_to` with `QueryEngine::deps()` + `QueryEngine::impact()`.

### FINDING-R2-6: ✅ Applied — Status and tags support
Extended TaskSpec with optional status and tags. Updated JSON schema example.

### FINDING-R2-7: ✅ Applied — `--dry-run` added
Full CLI struct + branching logic for dry run preview.

### FINDING-R2-8: ✅ Applied — Panic-safe extraction
Wrapped extraction in `catch_unwind`, `extraction_running` always reset.

### FINDING-R2-9: ✅ Applied — Summary table fixed
Changed `add-issue` → `add-task`, updated effort for §2 from Tiny to Medium.

## 🟢 Minor (can fix during implementation)

### FINDING-R2-10: ✅ Applied — `ensure_unique_id()` defined
Added inline definition in §1.1 with collision handling.

### FINDING-R2-11: ✅ Applied — Fuzzy resolution guards incoming nodes
`resolve_edges_fuzzy` now takes `incoming_node_ids: &HashSet<String>`, skips edges targeting incoming nodes.

### FINDING-R2-12: ✅ Applied — Disambiguation UX specified
CLI: print numbered list + exit non-zero. Agent: return JSON match list.

## ✅ Passed Checks

- §1.1 `add_feature()` correctly uses `graph.add_node()` + `graph.add_edge()` ✅
- §1.1 ID prefixing with feature slug prevents most collisions ✅
- §2.3 Scoped prompt with existing nodes is sound approach ✅
- §3 Resolver step ordering (exact → title → suffix → file → substring) is correct priority ✅
- §4 `gid about` composes existing queries without new data structures ✅
- §5 Watch correctly uses `extract_incremental` + `merge_code_layer` + `generate_bridge_edges` ✅
- §6.1 Extending `find_project_root()` instead of new function ✅
- Non-goals are explicit and reasonable ✅
- Ritual integration note is clear ✅
- Testing section covers all major components ✅

## Summary

| Severity | Count | Status |
|---|---|---|
| 🔴 Critical | 3 | ✅ All applied |
| 🟡 Important | 6 | ✅ All applied |
| 🟢 Minor | 3 | ✅ All applied |
