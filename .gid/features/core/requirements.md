# Core Graph — Requirements

## Status: ✅ Complete

## Goals
- Graph data model: nodes (tasks) + edges (dependencies) with metadata
- YAML persistence compatible with existing .gid/graph.yml format
- CRUD operations: add/remove/update nodes and edges
- Query engine: impact analysis, dependency traversal, common-cause, path finding
- Task management: status filtering, cascading completion, batch operations
- History: snapshots, diff, restore
- Refactor: rename, merge, split, extract graph operations
- Ignore-list: .gidignore support for excluding files from extraction

## Modules
- `graph.rs` — Node, Edge, TaskGraph, GraphSummary types
- `query.rs` — impact, deps, common-cause, path queries
- `history.rs` — snapshot/diff/restore
- `refactor.rs` — rename/merge/split/extract
- `ignore.rs` — .gidignore pattern matching
- `validator.rs` — graph consistency checks
