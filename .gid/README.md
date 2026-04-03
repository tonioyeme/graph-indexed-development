# .gid/ — Project Knowledge Graph

This directory contains the GID knowledge graph for gid-rs itself.

## Structure

```
.gid/
├── graph.yml              # Main task graph (nodes + edges)
├── rituals/               # Ritual workflow templates (project-specific)
├── features/              # Feature-specific workspaces
│   ├── core/
│   │   └── requirements.md
│   ├── code-intel/
│   │   └── requirements.md
│   ├── harness/
│   │   └── requirements.md
│   ├── ritual-engine/
│   │   └── requirements.md
│   ├── ritual-executors/
│   │   ├── requirements.md
│   │   └── design.md
│   ├── ritual-cli-run/
│   │   └── requirements.md
│   ├── ritual-notifier/
│   │   └── requirements.md
│   ├── mcp-server/
│   │   └── requirements.md
│   └── gidterm-integration/
│       └── requirements.md
└── README.md              # This file
```

## Feature Status

### ✅ Complete
- **core** — Graph data model, CRUD, queries, history
- **code-intel** — Code parsing, unified graph, complexity analysis
- **harness** — Task execution, scheduler, replanner, verification
- **ritual-engine** — State machine, approval gates, templates, ToolScope

### 🔴 TODO
- **ritual-executors** (P0) — Implement SkillExecutor, HarnessExecutor, GidCommandExecutor
- **ritual-cli-run** (P0) — `gid ritual run` CLI command
- **ritual-notifier** (P1) — Channel notifications for ritual events
- **mcp-server** (P3) — MCP protocol server mode
- **gidterm-integration** (P3) — Integrate gidterm with gid-core

## Ritual Workflow

When you `gid ritual init --template feature`, the ritual creates:
- `.gid/features/<feature-name>/idea.md` (capture-idea phase)
- `.gid/features/<feature-name>/research.md` (research phase)
- `.gid/features/<feature-name>/requirements.md` (requirements phase)
- `.gid/features/<feature-name>/design.md` (design phase)

Then `gid design --parse` converts design.md → graph.yml nodes.

## Graph Management

- `gid tasks` — list all tasks
- `gid task update <id> --status done` — mark complete
- `gid query deps <id>` — show dependencies
- `gid query impact <id>` — show what depends on this
- `gid visual` — generate mermaid diagram

## Global Templates

User-level ritual templates are in `~/.gid/rituals/`:
- `full-dev-cycle.yml` — Idea → research → design → graph → code → verify
- `quick-impl.yml` — Design → code → verify (skip research)
- `bugfix.yml` — Reproduce → root cause → fix → verify
