# MCP Server — Requirements

## Status: 🔴 TODO (P3)

## Problem
gid-core has all the functionality (graph, code intel, harness, ritual) but it's only accessible via CLI.
Claude Desktop, Cline, and other MCP clients can't use it.

## Goals

### MCP-1: Server mode
- `gid mcp` starts a stdio-based MCP server
- Implements MCP protocol (list_tools, call_tool, list_resources)
- Stays resident, responds to requests from client

### MCP-2: Tool exposure
Expose gid operations as MCP tools:
- `gid_read` — read graph nodes/edges
- `gid_add` — add nodes/edges
- `gid_query_deps` — dependency analysis
- `gid_query_impact` — impact analysis
- `gid_tasks` — list tasks by status
- `gid_task_update` — update task status
- `gid_design` — parse DESIGN.md → graph
- `gid_extract` — extract code graph
- `gid_visual` — generate mermaid viz
- `gid_ritual_init` — create ritual from template
- `gid_ritual_run` — execute ritual

### MCP-3: Resource exposure
- `graph://` — current graph as resource
- `task://<id>` — individual task
- `ritual://state` — ritual state

## Dependencies
- All features must be complete for full MCP coverage
- MCP protocol SDK (use existing MCP crate or implement minimal)

## Acceptance Criteria
- Claude Desktop can use gid as a tool
- `gid mcp` responds to MCP protocol requests
- Can manage graph/tasks/rituals entirely through MCP
