# Design Review: infer-integration — R1

**Reviewer**: RustClaw  
**Date**: 2026-04-08  
**Depth**: standard (Phase 0-5)

## Summary

Integration layer design is solid — clean merge logic, good CLI/API surface. 5 findings (0 critical, 2 important, 2 minor, 1 nit).

---

## FINDING-1 [important] — `merge_into_graph()` node update vs insert behavior undefined

§3.1: When a component node already exists in the graph (e.g. re-running infer on updated code), the design says "upsert" but doesn't specify merge semantics. Questions:
- Does re-infer overwrite the existing component's `description`? (LLM may give different text each run)
- Are `contains` edges replaced entirely, or diff'd?
- What about manually added metadata on existing component nodes — is it preserved or blown away?

**Fix**: Specify explicitly: (a) metadata fields from infer (description, metrics) are overwritten; (b) user-added metadata keys are preserved (merge, not replace); (c) edges are diff'd — remove old `contains` edges for this component, add new ones. This prevents losing manual annotations.

## FINDING-2 [important] — `gid infer` runs all 3 phases unconditionally

§3.3 CLI: `gid infer [--dry-run] [--no-llm]` runs clustering→labeling→integration as one pipeline. But there's no way to re-run just one phase. Use case: LLM labeling was poor, want to re-label without re-clustering (expensive Infomap run on large graph).

**Fix**: Add `--phase clustering|labeling|integration` flag. Each phase reads from the previous phase's output (ClusterResult, LabelingResult). Default: all phases. This also helps debugging.

## FINDING-3 [minor] — `InferReport` stats may not align with actual graph changes

§3.2: Report counts `components_created`, `features_created`, etc. But these are computed from ClusterResult/LabelingResult, not from what `merge_into_graph()` actually did. If merge hits an error midway (e.g. SQLite constraint violation), the report would show more items than actually persisted.

**Fix**: Have `merge_into_graph()` return actual counts (inserted/updated/skipped), and use those in the report instead of pre-computed counts.

## FINDING-4 [minor] — `--format json` output schema not specified

§3.3: `gid infer --dry-run --format json` outputs JSON preview. The schema (field names, nesting) is not documented. For programmatic consumers (CI scripts, gidterm), a stable schema matters.

**Fix**: Add a brief JSON schema example in §3.3 or reference the `InferReport` struct fields.

## FINDING-5 [nit] — §3.4 API surface duplicates merge logic

`infer_and_merge(graph, config, llm)` and `merge_into_graph(graph, result)` overlap. The former calls the latter internally. Since both are public API, callers might be confused about which to use.

**Fix**: Make `infer_and_merge` the primary public API. Keep `merge_into_graph` as `pub(crate)` — only exposed for testing and phase-by-phase usage.

---

## GOAL Coverage

| GOAL | Covered? | Section |
|------|----------|---------|
| 3.1 Graph merge | ✅ | §3.1 |
| 3.2 CLI `gid infer` | ✅ | §3.3 |
| 3.3 Dry-run | ✅ | §3.3 --dry-run |
| 3.4 Reporting | ✅ | §3.2 |
| 3.5 Incremental | ⚠️ | §3.1 mentions "upsert" but semantics unclear (FINDING-1) |
| GUARD-2 | ✅ | §5 (transaction rollback) |

All 5 GOALs addressed. GUARD-2 covered. ✅
