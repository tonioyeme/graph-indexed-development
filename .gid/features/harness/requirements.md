# Task Harness — Requirements

## Status: ✅ Complete

## Goals
- Execute tasks from graph in dependency order (topological sort)
- Parallel execution of independent tasks
- Sub-agent delegation for each task
- Dynamic re-planning when tasks fail
- Test verification after each task
- Execution state persistence for crash recovery
- Telemetry logging (execution-log.jsonl)
- Git worktree isolation per task branch
- Channel notifications on task completion/failure

## Design
See `docs/DESIGN-task-harness.md` for full architecture.

## Modules
- `harness/scheduler.rs` — topological ordering + parallelism
- `harness/executor.rs` — task execution with agent delegation
- `harness/replanner.rs` — dynamic re-planning on failure
- `harness/verifier.rs` — test execution + quality checks
- `harness/context.rs` — working memory + file tracking
- `harness/planner.rs` — initial task ordering from graph
- `harness/topology.rs` — dependency DAG analysis
- `harness/config.rs` — YAML configuration schema
- `harness/execution_state.rs` — persistence + recovery
- `harness/telemetry.rs` — execution logging + metrics
- `harness/log_reader.rs` — execution-log.jsonl parsing
- `harness/notifier.rs` — channel notifications
- `harness/worktree.rs` — git branch isolation
- `harness/types.rs` — shared types
