# gid-rs — Rust GID CLI & Library

## Vision
Unified Rust implementation of GID (Graph-Indexed Development):
- **CLI** (`gid`) — fast native binary, replaces the TypeScript CLI
- **Library crate** (`gid-core`) — reusable by RustClaw, gidterm, swebench, any Rust project
- Consolidates improvements scattered across swebench, rustclaw, gidterm into one place

## Why Rust?
- GID is used by Rust agents (RustClaw, swebench-agent, gidterm) — native integration, no Node overhead
- ~200ms Node startup vs <1ms native call
- potato's stack is converging on Rust for agent infra

## Architecture

```
gid-rs/
├── crates/
│   ├── gid-core/          # Library: graph types, YAML I/O, query engine
│   │   ├── graph.rs       # TaskGraph, CodeGraph, nodes, edges
│   │   ├── query.rs       # impact, deps, common-cause, path
│   │   ├── parser.rs      # YAML load/save (compatible with existing .gid/graph.yml)
│   │   ├── validator.rs   # advise, integrity checks
│   │   ├── code_graph.rs  # Code dependency extraction (from swebench)
│   │   ├── unified.rs     # Code→Task graph merge (from swebench)
│   │   └── working_mem.rs # GID context for changed files (from swebench)
│   └── gid-cli/           # Binary: CLI commands
│       └── main.rs
├── Cargo.toml             # Workspace
└── .gid/graph.yml         # Dogfooding: this project's own graph
```

## Features (by priority)

### P0: Core (replaces GID MCP + CLI basics)
- Graph CRUD: init, read, add/remove nodes, add/remove edges
- Task management: tasks, task_update, complete
- YAML persistence (backward compatible with existing .gid/graph.yml)
- Query: impact, deps, common-cause, path

### P1: Code Intelligence (from swebench)
- CodeGraph: extract dependencies from source code
- Unified graph: merge code nodes + task nodes
- Working memory context: files_changed → affected nodes
- File analysis: signatures, patterns, summaries

### P2: AI-Assisted (from GID MCP)
- design: AI-generated graph from requirements
- advise: validate + suggest improvements
- semantify: upgrade file-level to semantic graph
- refactor: preview/apply graph changes

### P3: Integration
- RustClaw native integration (replace current gid.rs)
- gidterm uses gid-core as dependency
- MCP server mode (gid-core as backend for MCP)
- CLI completions, rich output

## Source Mapping

| Feature | Source | Files | Lines |
|---------|--------|-------|-------|
| CodeGraph | swebench | repo_map.rs | 3337 |
| TaskGraph | swebench | task_graph.rs + knowledge.rs | 477 |
| UnifiedGraph | swebench | unified_graph.rs | 157 |
| WorkingMemory | swebench | working_memory.rs | 605 |
| ViewGraph | swebench | view_graph.rs | 197 |
| Graph CRUD | rustclaw | gid.rs | 938 |
| Query Engine | GID MCP (TS) | index.ts | ~500 |
| Validator/Advise | GID MCP (TS) | index.ts | ~300 |
| Design/Semantify | GID MCP (TS) | index.ts | ~400 |
| Extract | GID CLI (TS) | extractors/ | ~1000 |

## Compatibility
- MUST read/write existing .gid/graph.yml format
- MUST support same query semantics as GID MCP tools
- CLI command names align with GID MCP tool names where possible
