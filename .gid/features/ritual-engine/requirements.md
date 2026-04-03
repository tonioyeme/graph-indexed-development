# Ritual Engine — Requirements

## Status: ✅ Complete (engine framework + ToolScope)

## Goals
- Multi-phase pipeline: idea → research → design → graph → tasks → code → verify
- State machine with run/approve/skip/cancel operations
- Approval gates per phase (required/auto/mixed)
- Failure handling strategies (retry/escalate/skip/abort)
- Crash recovery via persisted state
- Template system for reusable workflows
- ToolScope: per-phase capability boundaries enforced at environment level

## Design
See `docs/DESIGN-ritual.md` for full architecture (§3.1-3.7).

## Modules
- `ritual/engine.rs` — RitualEngine state machine
- `ritual/definition.rs` — RitualDefinition YAML schema
- `ritual/approval.rs` — ApprovalGate per-phase gates
- `ritual/artifact.rs` — ArtifactManager output verification
- `ritual/template.rs` — TemplateRegistry for reusable workflows
- `ritual/scope.rs` — ToolScope per-phase capability boundaries
- `ritual/executor.rs` — PhaseExecutor trait + stub implementations

## What's NOT done (see ritual-executors feature)
- SkillExecutor: actually calling LLM (currently stub)
- HarnessExecutor: actually running task harness (currently stub)
- GidCommandExecutor: wiring to gid CLI (currently stub)
