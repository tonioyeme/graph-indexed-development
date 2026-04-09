# Design Review: infer-labeling — R1

**Reviewer**: RustClaw  
**Date**: 2026-04-08  
**Depth**: standard (Phase 0-5)

## Summary

Clean LLM integration design with good degradation strategy. 6 findings (1 critical, 2 important, 2 minor, 1 nit).

---

## FINDING-1 [critical] — JSON parse failure has no structured retry/repair

§3.2 and §3.3: LLM returns JSON, and the fallback for parse failure is `use auto_name` / `return empty vec`. But LLM JSON output is notoriously flaky — trailing commas, markdown code fences around JSON, missing closing brackets. 

The design has zero retry or repair logic. A single malformed response loses ALL labeling for that batch (naming) or ALL features (inference). This is not "graceful degradation" — it's "silent total failure" for the most common LLM error mode.

**Fix**: Add a `parse_json_response()` helper that:
1. Strips markdown code fences (` ```json ... ``` `)
2. Tries `serde_json::from_str` 
3. On failure: tries basic repair (trim trailing commas, close brackets)
4. On persistent failure: retry once with explicit "respond in valid JSON only" prompt
5. THEN fall back to defaults

This is a well-known pattern in `design.rs` already — `parse_features_response()` and `parse_components_response()` likely handle this. Reuse that parsing logic.

## FINDING-2 [important] — `ContextAssembler` reads file content but design says graph only

§3.1: `file_briefs` says "first doc comment or module doc, max 200 chars per file". This requires reading actual file content from disk. But the function signature is `assemble_contexts(graph, cluster_result)` — only graph data, no disk I/O.

File content is NOT stored in graph nodes (graph stores paths, types, signatures — not full file content). So either:
- (a) `file_briefs` is impossible with current signature, or
- (b) need to add `project_root: &Path` parameter for disk reads

**Fix**: Add `project_root: Option<&Path>` to `assemble_contexts()`. When provided, read first line of doc comments from files. When None (GidHub headless mode), skip briefs.

## FINDING-3 [important] — Token budget tracks estimates, not actuals

§5 GUARD-4: `TokenBudget` calls `can_afford(estimated)` before LLM calls and `record(actual)` after. But the `actual` token count requires the LLM response to include usage metadata. 

The `LlmClient::complete()` trait returns `Result<String>` — just text, no usage stats. So `actual` is unknowable without changing the trait.

**Fix**: Either (a) change `LlmClient::complete()` to return `(String, Option<Usage>)`, or (b) use estimated tokens for both budget check AND recording (simpler, less accurate but safe since estimates should be conservative). Option (b) is recommended — don't change the trait interface just for this.

## FINDING-4 [minor] — Feature prompt says "3-10 features" but no validation enforces range

§3.3.1: Prompt says "3-10 features". §4 step 3 says "Validate: 3-10 features". But no code shows what happens when LLM returns 1 feature or 15 features. 

**Fix**: Add validation: if <3 features, accept as-is (small project). If >10 features, take top 10 by component count. Log a warning either way.

## FINDING-5 [minor] — N:M feature→component makes `infer_feature_deps` non-trivial

§3.4: When a component belongs to multiple features, a cross-component edge can create dependencies between features that share that component. Example: component C belongs to features F1 and F2. Any edge from C to another component D (in F3) creates deps F1→F3 AND F2→F3. But also F1→F2 could be inferred since they share C — which is wrong (shared membership ≠ dependency).

**Fix**: In §3.4, add explicit rule: "Only count edges where source and target components belong to DIFFERENT features. If both endpoints' components share a feature, that edge does NOT count toward that feature's dependency." Already somewhat implied by "source != target" check, but should be explicit about the N:M case.

## FINDING-6 [nit] — `naming_config` variable used in §3.5 but not defined

In `label()` body: `name_components(&comp_contexts, &proj_context, llm, &naming_config)` — `naming_config` is not constructed from `config: &LabelingConfig`. Should be `&NamingConfig { batch_size: config.naming_batch_size, max_tokens: ... }`.

---

## GOAL Coverage

| GOAL | Covered? | Section |
|------|----------|---------|
| 2.1 Component naming | ✅ | §3.2 |
| 2.2 Feature inference | ✅ | §3.3 |
| 2.3 Feature dependencies | ✅ | §3.4 |
| 2.4 README augmentation | ✅ | §3.1 |
| 2.5 No-LLM mode | ✅ | §3.5 label(llm=None) |
| GUARD-3 | ✅ | §5 (3-level fallback) |
| GUARD-4 | ⚠️ | §5 (tracking inaccurate, FINDING-3) |

All 5 GOALs covered. GUARD-4 needs fix per FINDING-3.
