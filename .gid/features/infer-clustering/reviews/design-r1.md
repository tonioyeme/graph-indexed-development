# Design Review: infer-clustering — R1

**Reviewer**: RustClaw  
**Date**: 2026-04-08  
**Depth**: standard (Phase 0-5)

## Summary

Solid design — clean separation, pure API, good test coverage plan. 5 findings (0 critical, 2 important, 2 minor, 1 nit).

---

## FINDING-1 [important] — Edge weight accumulation undefined for multi-edges

§3.1 `build_network()`: When two files have multiple edges (e.g. file A has both `calls` and `imports` edges to file B), the design doesn't specify whether weights are accumulated (add to existing edge) or last-write-wins.

Infomap Network likely keeps a single edge per (from, to) pair. If `add_edge` is called twice for the same pair, behavior depends on infomap-rs implementation.

**Fix**: Explicitly accumulate weights. Build a `HashMap<(usize, usize), f64>` first, then add each pair once to the Network. Document this in §3.1.

## FINDING-2 [important] — `detect_code_modules()` migration breaks existing behavior

§8 says refactor `detect_code_modules()` to call the new `build_network()` with "uniform weights (1.0 for all coupling relations)". But current `detect_code_modules()` uses coupling_relations `["calls", "imports", "depends_on", "inherits", "implements"]` — note `depends_on` is included. 

The new `relation_weight()` maps `depends_on` → 0.0 (falls into `_ => 0.0`). So after migration, `depends_on` edges would be dropped entirely. That changes behavior.

**Fix**: Either (a) add `depends_on` to the weight map (perhaps at 0.4), or (b) the migration helper passes a custom weight function that maps all coupling relations to 1.0. Option (b) is cleaner for backward compat.

## FINDING-3 [minor] — Hierarchical node ID format not specified for deep nesting

§3.4 says node ID is `"infer:component:{parent}.{child}"` for hierarchical. But for 3+ levels (sub-sub-community), the format is ambiguous — is it `infer:component:0.1.3`? This should be explicitly stated.

**Fix**: Add a note: "For N-level hierarchy, IDs are `infer:component:{L0}.{L1}...{LN}`".

## FINDING-4 [minor] — `auto_name()` takes `member_ids: &[String]` but needs file paths

§3.5: `auto_name()` receives node IDs (e.g. `"file:src/auth/login.rs"`), not raw file paths. The implementation comment says "strip `file:` prefix" — but not all file node IDs start with `file:`. Some may use `file_path` metadata. The function signature should accept file paths directly, not node IDs.

**Fix**: Change to `auto_name(file_paths: &[&str])` and let the caller resolve node IDs → file paths.

## FINDING-5 [nit] — §3.2 is config, not a "component"

ClusterConfig is a data struct, not a processing component. It's fine to keep in §3 for reference but the section title could be "§3.2 Configuration Types" to avoid confusion with the actual processing components.

---

## GOAL Coverage

| GOAL | Covered? | Section |
|------|----------|---------|
| 1.1 Network building | ✅ | §3.1 |
| 1.2 Community→component | ✅ | §3.3, §3.4 |
| 1.3 Hierarchical | ✅ | §3.3 |
| 1.4 Configurable | ✅ | §3.2, §6 |
| 1.5 Quality metrics | ✅ | §3.3 ClusterMetrics |
| GUARD-1 | ✅ | §5 (immutable ref) |

All 5 GOALs + GUARD-1 covered. ✅
