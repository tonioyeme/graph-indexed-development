# gid ritual run — Requirements

## Status: 🔴 TODO (P0)

## Problem
`gid ritual init/status/approve/skip/cancel` exist but `gid ritual run` doesn't.
There's no way to actually execute a ritual end-to-end from the CLI.

## Goals

### RUN-1: Basic execution
- `gid ritual run` starts from current phase, runs to completion (or next approval gate)
- Reads `.gid/ritual.yml` + `.gid/ritual-state.json`
- Delegates to engine.run() which calls phase executors

### RUN-2: From template
- `gid ritual run --template feature` — init + run from a template
- `gid ritual run --template bugfix` — init + run bugfix workflow

### RUN-3: Progress output
- Show current phase name and progress
- Show tool calls and artifacts as they're produced
- Show approval requests inline (wait for user input)

### RUN-4: Resume
- `gid ritual run` with existing state resumes from last phase
- Crash recovery: picks up where it left off

## Dependencies
- ritual-skill-executor (todo) — needs working executors
- ritual-harness-executor (todo)
- ritual-gid-executor (todo)

## Acceptance Criteria
- `gid ritual run --template quick-impl` produces working code from a feature description
- Progress is visible in terminal
- Approval gates pause and wait for input
- Can Ctrl+C and resume later
