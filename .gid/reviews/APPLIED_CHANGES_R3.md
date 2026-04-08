# Applied Changes: R3 Review Findings

**Date:** 2026-04-07  
**Review:** frictionless-graph-design-r3-review.md  
**Target:** .gid/features/frictionless-graph/design.md  

---

## Applied Changes

### ✅ FINDING-1 (Critical): §5 `gid watch` — notify crate version + macOS notes
**Section:** §5.2  
**Change:** 
- Specified `notify = "6"` explicitly (was "needs to be added")
- Added macOS note: Use `fsevent` backend rather than `kqueue` (kqueue leaks FDs, fsevent works)
- Changed debounce from hardcoded to configurable via `--debounce <ms>` flag (default: 1000ms)
- Added note that `.gidignore` patterns should be respected by watcher

### ✅ FINDING-2 (Critical): §5.3 CLI flags `--incremental` and `--quiet` don't exist
**Section:** §5.3 Git Hook Alternative  
**Change:**
- Replaced `gid extract src/ --incremental --quiet` with `gid extract src/`
- Updated explanatory text: incremental is **default behavior** (no `--force` means incremental)
- Added examples for quiet output: `--json` mode or redirect stderr

### ✅ FINDING-3 (Important): `slugify()` — mark as new function, add edge case spec
**Section:** §1.1  
**Change:**
- Marked `slugify()` as **new function to implement** (was implied to exist)
- Added edge case specification:
  - Leading/trailing dashes stripped
  - Consecutive dashes collapsed to single dash
  - Non-ASCII transliterated (e.g., "café" → "cafe") or stripped
  - Empty input returns "unnamed"

### ✅ FINDING-4 (Important): `graph::Edge.relation` is `String`, not `EdgeRelation` enum
**Section:** §2.2  
**Change:**
- Added **type system clarification** note after `merge_feature()` pseudocode
- Clarified that `Graph::Edge.relation` is `String` (project layer)
- Noted that `add_edge_dedup()` compares string equality via `relation_str()`, not `EdgeRelation` enum variants
- Prevents implementers from trying to `use EdgeRelation` in graph.rs code

### ✅ FINDING-5 (Important): `merge_feature()` — dangling edges from direct `retain`
**Section:** §2.2  
**Change:**
- Added **implementation note** after `merge_feature()` pseudocode
- Warning: Always use `remove_node()` (not `nodes.retain()`) to remove old feature tasks
- Clarified that `remove_node()` cascades to clean up associated edges
- Direct `nodes.retain()` would leave dangling edges, causing data corruption

### ✅ FINDING-6 (Important): `resolve_node()` — zero-match behavior
**Section:** §3.2  
**Change:**
- Added explicit **zero-match behavior** section after `resolve_node()` function
- Function returns empty `Vec<&Node>` when no matches found
- CLI behavior: Print "No node found matching '{query}'." with suggestions from closest fuzzy matches (edit distance ≤ 3 or prefix matches)
- Agent tool behavior: Return `{"matches": []}`

### ✅ FINDING-7 (Important): `gid watch` — configurable debounce and patterns
**Section:** §5.2  
**Change:**
- Updated debounce from hardcoded 500ms to configurable via `--debounce <ms>` flag (default: 1000ms)
- Added **Configuration** section documenting debounce and ignore pattern support
- Added note that `.gidignore` patterns should be respected by the watcher

### ✅ FINDING-8 (Important): §4 `gid about` — output format trade-offs
**Section:** §4.2  
**Change:**
- Added **output format trade-offs** section after implementation note:
  1. `--json` produces machine-readable equivalent
  2. Relationships truncated at 20 per category with `... and N more` suffix
  3. Source preview truncated at 30 lines with `... (N more lines)` suffix

### ✅ FINDING-9 (Minor): Naming `merge_feature` → `merge_feature_nodes`
**Section:** §2.2  
**Change:**
- Added **naming note** suggesting final implementation could use `merge_feature_nodes()` to match `merge_*_layer()` pattern
- Design retains `merge_feature()` for brevity and consistency across references

### ✅ FINDING-10 (Minor): `gid watch` testability
**Section:** §5.2  
**Change:**
- Added **testability** note after `watch_and_sync()` pseudocode
- Specified watch loop should call testable `handle_change(path, graph) -> Result<Graph>` function
- Watcher should be thin shell around core logic to enable unit testing without flaky filesystem timing tests

### ✅ FINDING-11 (Minor): §1 `add_feature` — design decisions acknowledgment
**Section:** §1.1  
**Change:**
- Added **design decisions acknowledgment** note after collision handling section
- Explicitly called out that exact ID format, edge relation strings, and metadata keys are design decisions
- Noted these could be adjusted during implementation but consistency is critical

### ✅ FINDING-12 (Minor): §3.2 `resolve_node()` — numbered priority list
**Section:** §3.2  
**Change:**
- Added **explicit numbered priority list** in prose before code block:
  1. Exact ID match
  2. Exact title match (case-insensitive)
  3. ID segment match — structural separators (`:`, `-`, `/`)
  4. ID segment match — word separators (`_`)
  5. File path match
  6. Substring match on title
  7. Substring match on ID

---

## Summary

**Applied:** 12/12 findings  
**Critical:** 2/2  
**Important:** 6/6  
**Minor:** 4/4  

**Method:** All changes applied using targeted `edit_file` operations (surgical edits preserving document structure)  
**Files modified:** 2
- `/Users/potato/clawd/projects/gid-rs/.gid/features/frictionless-graph/design.md` (design document)
- `/Users/potato/clawd/projects/gid-rs/.gid/reviews/frictionless-graph-design-r3-review.md` (review status updates)

**Data corruption bug fixed:** FINDING-5 — added critical implementation note preventing dangling edges in `merge_feature()`

**No breaking changes:** All additions are clarifications, specifications, or documentation improvements. No existing design decisions were reversed.
