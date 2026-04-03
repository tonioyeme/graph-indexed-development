# Ritual Executors — Requirements

## Status: 🔴 TODO (P0)

## Problem
The ritual engine framework is complete but all phase executors are stubs.
`engine.run()` calls executors, they return `Ok(success)` without doing anything.
The ritual state machine works but produces no actual artifacts.

## Goals

### EXEC-1: SkillExecutor (P0)
- Create an LLM session with the skill's system prompt
- Run under the current phase's ToolScope constraints
- Collect artifacts produced during the session
- Support model override per phase
- Handle skill prompts from `.gid/features/<feature>/` context

### EXEC-2: HarnessExecutor (P0)
- Invoke the existing task harness (harness/scheduler + executor)
- Pass through harness config overrides from ritual definition
- Connect harness completion to ritual phase completion
- Forward harness telemetry to ritual execution log

### EXEC-3: GidCommandExecutor (P1)
- Execute gid CLI commands (design, extract, advise, etc.)
- Capture stdout/stderr as phase output
- Handle command-specific args from phase definition
- Verify command success via exit code

### EXEC-4: ShellExecutor (P1)
- Already partially implemented (runs shell commands)
- Need: validate commands against ToolScope.bash_policy
- Need: working directory isolation

## Dependencies
- ritual-engine (done) — engine.run() calls executors
- harness-executor (done) — HarnessExecutor delegates to this
- ritual-toolscope (done) — scope constraints during execution

## Acceptance Criteria
- `gid ritual run` with a real ritual.yml produces actual artifacts
- SkillExecutor creates files in .gid/features/ during research/design phases
- HarnessExecutor runs the task graph and produces code
- All executor outputs are tracked as phase artifacts
- Integration tests verify each executor with real (non-stub) behavior
