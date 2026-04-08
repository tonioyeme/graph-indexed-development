# Review: Frictionless Graph Operations Design

## 🔴 Critical (blocks implementation)

### ✅ FINDING-1: [Check #26] `merge_project_layer()` replaces ALL project nodes — not feature-scoped
The design says §2.2 `design --merge` solves incremental design by using `merge_project_layer()`. But that function **replaces the entire project layer** with the new graph:

```rust
// unify.rs:181 — drains ALL non-extract nodes
let code_nodes: Vec<Node> = existing.nodes.drain(..).filter(|n| n.source.as_deref() == Some("extract")).collect();
```

So if you have features A, B, C and generate a new design for feature D, `merge_project_layer()` **deletes A, B, C and only keeps D**. This defeats the purpose of incremental design.

The design's §2.2 pseudocode says "replaces project-layer nodes with new ones" as if that's the desired behavior — but for the use case "add a feature to an existing project," this is destructive.

**Suggested fix:** §2.2 needs a **feature-scoped merge**, not full project-layer replacement. Two options:
- Option A: New `merge_feature(graph, feature_id, new_nodes, new_edges)` — only replaces nodes that `implements` the target feature
- Option B: The approach RustClaw's `GidDesignTool` already uses — add-if-not-exists for nodes, always-add for edges (see FINDING-2)

### ✅ FINDING-2: [Check #26] RustClaw agent tool ALREADY does incremental merge — design doesn't mention it
`src/tools.rs:3940-3960` (RustClaw's `GidDesignTool` with `parse=true`) already does:
```rust
if graph.get_node(&node.id).is_none() {
    graph.add_node(node);
    added_nodes += 1;
}
```
This is **add-if-not-exists** — exactly the incremental behavior the design wants. But the design focuses on fixing the CLI `cmd_design`, without acknowledging that the agent path already works differently.

**Suggested fix:** Document the split behavior. Decide which is canonical:
- CLI `cmd_design --parse` = full replace (current)
- RustClaw `gid_design parse=true` = add-if-not-exists (current)

Then align both to the same merge strategy. The RustClaw approach is closer to correct, but it has its own bug: it never removes stale project nodes.

### ✅ FINDING-3: [Check #5] State machine gap — `add-feature` ID collision handling
§1.1 `add_feature` generates IDs via `slugify()`. Two features with tasks named "implement validation" would collide (`task-implement-validation`). No collision detection or disambiguation.

Also: `slugify()` doesn't exist in the codebase. It's referenced but never defined.

**Suggested fix:** Either:
- Prefix task IDs with feature slug: `task-user-auth-implement-validation`
- Or detect collisions and append `-2`, `-3`
- Define `slugify()` explicitly (or use an existing crate like `slug`)

## 🟡 Important (should fix before implementation)

### ✅ FINDING-4: [Check #13] `gid about` mixes concerns — query + display in one command
§4 `gid about` does resolve + deps + impact + display all in one. This is fine for CLI UX, but the **resolver** (§3) should be a separate, reusable function that other commands call. The design shows `resolve_node()` as a standalone function (good), but §4 bundles it with a specific output format.

**Suggested fix:** Clarify the layering: `resolve_node()` is a library function in `graph.rs`. `cmd_about` is a CLI command that uses it. All query commands (`impact`, `deps`, etc.) also call `resolve_node()` as a preprocessing step.

### ✅ FINDING-5: [Check #15] Hardcoded debounce in `gid watch`
§5.2 hardcodes 500ms debounce. On a Mac mini with SSD, `extract_incremental` on a large project (gid-rs has 70+ source files) could take >500ms. This means overlapping extractions.

**Suggested fix:** Make debounce configurable. Also add a guard: skip extraction if previous one is still running. Default 1000ms is safer.

### ✅ FINDING-6: [Check #14] No coupling between §2.3 scoped design prompt and §3 fuzzy resolution
§2.3 generates a scoped prompt with existing node IDs. The LLM must use exact IDs when referencing existing nodes. But LLMs are unreliable with exact ID matching — they might generate `task-jwt-validation` when the existing ID is `task-implement-jwt-validation`.

**Suggested fix:** After LLM generates scoped output, run a post-processing pass that fuzzy-matches edge targets against existing node IDs (using §3's `resolve_node()`). This closes the LLM reliability gap.

### ✅ FINDING-7: [Check #17] Missing non-goal: relationship to ritual pipeline
The design doesn't clarify how these tools interact with the ritual pipeline. If a user does `gid add-feature` manually, does that affect ritual state? Can `gid watch` conflict with ritual's own extract step?

**Suggested fix:** Add explicit non-goal or integration note: "These commands operate on graph.yml directly. Ritual state (`.gid/rituals/*.json`) is not affected. If a ritual is active and `gid watch` updates the graph, ritual should treat the graph as externally modified."

### ✅ FINDING-8: [Check #6] `resolve_node()` step 3 ambiguity
The suffix match checks for `:{query}` and `-{query}`. But many node IDs use `/` as separator (e.g., `file:src/ritual/v2_executor.rs`). Searching for "v2_executor" wouldn't match on `:` or `-`.

**Suggested fix:** Add `/` to suffix delimiters, or better: split node ID on all common separators (`:`, `-`, `/`, `_`) and check if query matches any segment.

### ✅ FINDING-9: [Check #21] Missing: how agents trigger `add-feature`
The design focuses on CLI (`gid add-feature` command) but the primary user is an **AI agent** calling tools. There's no corresponding `GidAddFeatureTool` for RustClaw. The agent would need to call `gid_add_task` N times + `gid_add_edge` M times — the same friction the design tries to fix.

**Suggested fix:** For each new CLI command, spec the corresponding RustClaw tool. §1.1 should define a `gid_add_feature` tool with a JSON schema that takes `{name, tasks: [{title, deps}]}`.

### ✅ FINDING-10: [Check #18] `gid watch` dependency on `notify` crate
Design says "already in RustClaw dependencies" for `notify`. But this feature is in **gid-core** / **gid-cli**, not RustClaw. Check if `notify` is in gid-core's Cargo.toml.

**Suggested fix:** Verify dependency. If not present, add it. Note that gid-cli already depends on several IO crates so this is low-risk.

## 🟢 Minor (can fix during implementation)

### ✅ FINDING-11: [Check #4] Naming inconsistency: `add-feature` vs `add-issue`
§1.1 uses `add-feature` (has tasks). §1.2 uses `add-issue` (single task, no feature parent). But an "issue" could also be a feature request. The distinction is really "feature with subtasks" vs "standalone task".

**Suggested fix:** Consider `add-task --standalone` instead of `add-issue`. Or keep `add-issue` but document that it's for one-off tasks of any kind, not just bugs.

### ✅ FINDING-12: [Check #20] §6.1 duplicates `find_project_root()`
`find_project_root()` already exists at line 1662 of main.rs (walks up looking for `.git`, then `Cargo.toml` etc.). The design proposes `find_gid_dir()` which looks for `.gid/`. These should be unified — `find_project_root()` should also check for `.gid/`.

**Suggested fix:** Extend existing `find_project_root()` to check `.gid/` as a marker alongside `.git` and `Cargo.toml`.

### ✅ FINDING-13: [Check #25] §5 `gid watch` testability concern
Integration test for watch requires filesystem timing (create file → wait → verify graph update). Flaky on CI.

**Suggested fix:** Extract the core logic (detect change → extract → merge) into a testable function. Test that function directly. The watch loop itself is just `notify` boilerplate.

### ✅ FINDING-14: [Check #3] Dead feature: §6.2 default node type inference
ID prefixes like `feat-` and `task-` are generated by §1.1 `add-feature`. If users use `add-feature`, they never call `add-node` manually. If they use `add-node` manually, they pick their own IDs. So inferring type from prefix only helps when users happen to follow the convention — niche value.

**Suggested fix:** Low priority, implement if free. Don't design around it.

## ✅ Passed Checks

- Check #1: All types fully defined — Node, Edge, Graph used from existing codebase ✅
- Check #2: All references resolve — merge_code_layer, extract_incremental, etc. verified in source ✅
- Check #7: Error handling — design defers to existing error handling in primitives ✅
- Check #8: No string slicing in design ✅
- Check #9: No integer overflow risk ✅
- Check #10: Option handling deferred to implementation ✅
- Check #12: Match exhaustiveness N/A — no new enums ✅
- Check #16: API surface is minimal — composes existing public API ✅
- Check #19: Cross-cutting (observability) — §6.3 compact output is sufficient ✅
- Check #24: Migration path — no breaking changes, all additive ✅
- Check #28: Feature flag — not needed, all additive ✅

## 📋 Path Summary

| Finding | Severity | Section | Fix effort |
|---|---|---|---|
| FINDING-1 | 🔴 Critical | §2.2 | Medium — need feature-scoped merge |
| FINDING-2 | 🔴 Critical | §2.2 | Small — acknowledge + align two implementations |
| FINDING-3 | 🔴 Critical | §1.1 | Small — add prefix + collision detection |
| FINDING-4 | 🟡 Important | §4 | Tiny — clarify layering in text |
| FINDING-5 | 🟡 Important | §5.2 | Small — configurable debounce + guard |
| FINDING-6 | 🟡 Important | §2.3 | Medium — add fuzzy post-processing |
| FINDING-7 | 🟡 Important | Non-goals | Tiny — add section |
| FINDING-8 | 🟡 Important | §3.2 | Small — extend separator set |
| FINDING-9 | 🟡 Important | §1.1 | Medium — spec agent tools |
| FINDING-10 | 🟡 Important | §5.2 | Tiny — verify dep |
| FINDING-11 | 🟢 Minor | §1.2 | Tiny — naming |
| FINDING-12 | 🟢 Minor | §6.1 | Small — unify functions |
| FINDING-13 | 🟢 Minor | §5 | Small — extract testable core |
| FINDING-14 | 🟢 Minor | §6.2 | N/A — deprioritize |

**Recommendation:** Fix FINDING-1 (most critical — the merge strategy) and FINDING-2 (align CLI and agent behavior) before proceeding. The rest can be addressed during implementation.
