# Requirements Review: gid infer — R1
**Date**: 2026-04-08
**Reviewer**: RustClaw
**Document**: `.gid/features/infer/requirements.md`
**Verdict**: ✅ Approved with 2 amendments applied

## Summary
22 GOAL + 4 GUARD, five dimensions (clustering, LLM labeling, graph output, CLI, API). Well-structured, verifiable criteria throughout. OpenClaw did solid work.

**0 critical, 2 important (applied), 3 minor (→ design), 2 nit (→ design)**

## Findings

### FINDING-1 [important] — APPLIED ✅
**GOAL-1.1 edge weight mapping lacked concrete values.**
"calls/imports 权重 > structural edges" was ambiguous.
→ Fixed: Added 4-tier weight table: calls=1.0, imports=0.8, type_reference=0.5, structural=0.2.

### FINDING-2 [important] — APPLIED ✅
**GOAL-2.2 component↔feature cardinality was undefined.**
Only specified "one feature can span multiple components" but not the reverse.
→ Fixed: Added "一个 component 也可属于多个 feature（多对多关系），但 typical case 是一对多".

### FINDING-3 [minor] → DESIGN
**GOAL-3.2 vs GOAL-1.2 edge direction inconsistency.**
component → code uses `contains`, code → component uses `belongs_to`. Same relationship, two names.
→ Design should standardize: use `contains` (top-down) consistently, derive `belongs_to` as reverse query.

### FINDING-4 [minor] → DESIGN
**GOAL-5.1 API signature: `&Graph` vs `&mut Graph`.**
API takes `&Graph` (immutable) but GOAL-3.1 says "追加到现有图中".
→ Design should clarify: API returns `InferResult` (new nodes/edges), caller merges. `&Graph` is correct.

### FINDING-5 [minor] → DESIGN
**GOAL-4.3 `--level feature` behavior when no components exist.**
→ Design should specify: auto-run component inference first if missing.

### FINDING-6 [nit] → DESIGN
**GUARD-4 50k token cap may be low for 500+ file projects.**
→ Design should make this configurable with dynamic default based on project size.

### FINDING-7 [nit] → DESIGN
**No performance requirements.**
→ Design should specify per-repo time budget for batch/GidHub scenarios.
