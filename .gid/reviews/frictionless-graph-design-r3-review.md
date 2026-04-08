# Review R3: Frictionless Graph Design

**Reviewed by:** RustClaw  
**Date:** 2026-04-07  
**Review depth:** full (all 29 checks)  
**Code verification:** All function references verified via search_files + read_file  

---

## 🔴 Critical (blocks implementation)

### ✅ FINDING-1: [Check #29] §5 `gid watch` — `notify` crate not present, `RecommendedWatcher` API unverified

**Status:** Applied

**Changes made:**
- Added explicit version: `notify = "6"` in §5.2
- Added macOS note about fsevent vs kqueue (fsevent works, kqueue leaks FDs)
- Added `--debounce <ms>` flag specification
- Added note about `.gidignore` pattern support

### ✅ FINDING-2: [Check #29] §5.3 CLI flags `--incremental` and `--quiet` don't exist

**Status:** Applied

**Changes made:**
- Replaced `gid extract src/ --incremental --quiet` with `gid extract src/` in §5.3
- Updated explanatory text to reflect that incremental is default behavior (no `--force` means incremental)
- Added note about using `--json` for quiet output or redirecting stderr

---

## 🟡 Important (should fix before implementation)

### ✅ FINDING-3: [Check #3] `slugify()` — dead definition, no existing implementation

**Status:** Applied

**Changes made:**
- Marked `slugify()` as **new function to implement** in §1.1
- Added edge case specification: leading/trailing dashes stripped, consecutive dashes collapsed, non-ASCII transliterated or stripped, empty input returns "unnamed"

### ✅ FINDING-4: [Check #14] `graph::Edge.relation` is `String`, not `EdgeRelation` enum

**Status:** Applied

**Changes made:**
- Added clarifying note in §2.2 after `merge_feature()` pseudocode that `Graph::Edge.relation` is `String` (project layer)
- Noted that `add_edge_dedup()` compares string equality via `relation_str()`, not `EdgeRelation` enum variants
- This prevents implementers from trying to `use EdgeRelation` in graph.rs code

### ✅ FINDING-5: [Check #6] `merge_feature()` — edge ownership ambiguity

**Status:** Applied

**Changes made:**
- Added **implementation note** in §2.2 after `merge_feature()` pseudocode warning that implementers must use `remove_node()` (not `nodes.retain()`) to remove old feature tasks
- Clarified that `remove_node()` cascades to clean up associated edges, while direct `nodes.retain()` would leave dangling edges causing data corruption

### ✅ FINDING-6: [Check #7] `resolve_node()` — missing fallback behavior specification

**Status:** Applied

**Changes made:**
- Added explicit **zero-match behavior** section in §3.2 after `resolve_node()` function
- Specified that function returns empty `Vec<&Node>` when no matches found
- Defined caller behavior: CLI prints "No node found matching '{query}'." with suggestions from closest fuzzy matches (edit distance ≤ 3 or prefix matches); agent tools return `{"matches": []}`

### ✅ FINDING-7: [Check #15] Configuration vs hardcoding — `gid watch` debounce and patterns

**Status:** Applied

**Changes made:**
- Updated §5.2 to specify `--debounce <ms>` flag with default: 1000ms
- Added note that `.gidignore` patterns should be respected by the watcher
- Configuration section now documents debounce configurability and ignore pattern support

### ✅ FINDING-8: [Check #18] §4 `gid about` — no trade-off discussion for output format

**Status:** Applied

**Changes made:**
- Added **output format trade-offs** section in §4.2 after implementation note
- Documented: (1) `--json` produces machine-readable equivalent, (2) relationships truncated at 20 per category with `... and N more` suffix, (3) source preview truncated at 30 lines with `... (N more lines)`

---

## 🟢 Minor (can fix during implementation)

### ✅ FINDING-9: [Check #4] Naming inconsistency — `merge_feature` vs `merge_project_layer` vs `merge_code_layer`

**Status:** Applied

**Changes made:**
- Added **naming note** in §2.2 after `merge_feature()` pseudocode suggesting final implementation could use `merge_feature_nodes()` to match `merge_*_layer()` pattern
- Design retains `merge_feature()` name for brevity and consistency across references

### ✅ FINDING-10: [Check #25] Testability — `gid watch` is hard to unit test

**Status:** Applied

**Changes made:**
- Added **testability** note in §5.2 after `watch_and_sync()` pseudocode
- Specified that watch loop should call testable `handle_change(path, graph) -> Result<Graph>` function
- Noted the watcher should be a thin shell around core logic to enable unit testing without flaky filesystem timing tests

### ✅ FINDING-11: [Check #20] §1 `add_feature` — pseudocode vs design level

**Status:** Applied

**Changes made:**
- Added **design decisions acknowledgment** note in §1.1 after collision handling section
- Explicitly called out that exact ID format, edge relation strings, and metadata keys are design decisions established in this document
- Noted these conventions could be adjusted during implementation but consistency is critical

### ✅ FINDING-12: [Check #2] §3.2 `resolve_node()` — priority cascade reference numbers

**Status:** Applied

**Changes made:**
- Added **explicit numbered priority list** in prose before the code block in §3.2
- Listed all 7 priority levels with clear numbering: 1. Exact ID match, 2. Exact title match (case-insensitive), 3. ID segment match (structural separators), 4. ID segment match (word separators), 5. File path match, 6. Substring match on title, 7. Substring match on ID

---

## ✅ Passed Checks

- **Check #0 (Document size):** ✅ 5 components (§1-§5), well under 8 limit
- **Check #1 (Types fully defined):** ✅ All new types have complete field definitions
- **Check #5 (State machine):** N/A — no state machine in this design
- **Check #8 (String operations):** ✅ `slugify()` operates on known input, no user-facing slicing
- **Check #9 (Integer overflow):** ✅ No counter increments without bounds
- **Check #10 (Option/None):** ✅ `resolve_node()` returns Vec, callers handle empty
- **Check #11 (Match exhaustiveness):** ✅ No catch-all branches in new code
- **Check #12 (Ordering sensitivity):** ✅ `resolve_node()` priority cascade is explicitly ordered
- **Check #13 (Separation of concerns):** ✅ Library functions in graph.rs/refactor.rs, CLI in main.rs
- **Check #16 (API surface):** ✅ Minimal new public API (`merge_feature`, `resolve_node`, `add_edge_dedup`, `slugify`)
- **Check #17 (Goals/non-goals):** ✅ Clear goals stated, non-goals implicit but reasonable
- **Check #19 (Cross-cutting):** ✅ Error handling specified per function
- **Check #21 (Ambiguous prose):** ✅ Pseudocode is specific enough to implement unambiguously
- **Check #22 (Missing helpers):** ✅ All referenced functions either exist or are defined in the design
- **Check #23 (Dependency assumptions):** Only `notify` — flagged in FINDING-1
- **Check #24 (Migration path):** ✅ Design is additive, no existing code removed
- **Check #26 (Existing functionality):** ✅ `merge_feature` is genuinely new (existing `merge_project_layer` is destructive)
- **Check #27 (API compatibility):** ✅ New functions, no breaking changes
- **Check #28 (Feature flag/rollout):** N/A — CLI commands, not feature-flagged

---

## Summary

| Severity | Count | Applied |
|---|---|---|
| 🔴 Critical | 2 | ✅ 2/2 |
| 🟡 Important | 6 | ✅ 6/6 |
| 🟢 Minor | 4 | ✅ 4/4 |

**All findings applied:** All 12 findings have been incorporated into the design document using targeted edits.

**Critical issues resolved:** 
- FINDING-1: `notify = "6"` specified, macOS fsevent note added, debounce/ignore pattern configuration documented
- FINDING-2: Removed nonexistent `--incremental --quiet` flags, documented actual default incremental behavior

**Data corruption bug fixed:**
- FINDING-5: Added implementation note warning against using `nodes.retain()` directly — must use `remove_node()` to cascade edge cleanup

**Review completion date:** 2026-04-07  
**Application date:** 2026-04-07
