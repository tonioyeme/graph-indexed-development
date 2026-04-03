# gidterm Integration — Requirements

## Status: 🔴 TODO (P3)

## Problem
gidterm (the TUI terminal controller) exists but doesn't use gid-core.
It has its own graph logic instead of delegating to gid.

## Goals

### GIDTERM-1: Replace internal graph with gid-core
- gidterm uses gid-core crate as dependency
- Graph operations call `TaskGraph` instead of internal logic
- YAML persistence handled by gid-core

### GIDTERM-2: Multi-project workspace mode
- gidterm supports switching between project graphs
- Each project has its own `.gid/graph.yml`
- TUI shows current project context

### GIDTERM-3: Visual graph mode
- TUI renders graph structure (not just task list)
- Shows dependencies as edges
- Color-coded by status (todo/progress/done/blocked)

## Dependencies
- core (done)
- gidterm exists but needs refactor to use gid-core

## Acceptance Criteria
- gidterm reads/writes `.gid/graph.yml` via gid-core
- Multi-project mode works
- Visual graph view is usable
