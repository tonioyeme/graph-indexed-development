# Code Intelligence — Requirements

## Status: ✅ Complete

## Goals
- Extract code structure (classes, functions, imports, calls) from source files
- Support Rust, TypeScript, Python, JavaScript via tree-sitter
- Merge code graph with task graph into unified view
- Working memory: track changed files → affected graph nodes
- Complexity analysis: cyclomatic + cognitive metrics per file

## Modules
- `parser.rs` — tree-sitter based entity extraction
- `code_graph.rs` — CodeGraph construction from parsed entities
- `unified.rs` — merge CodeGraph + TaskGraph
- `working_mem.rs` — files_changed → affected nodes context
- `complexity.rs` — complexity metrics
- `semantify.rs` — upgrade file-level to semantic-level graph
