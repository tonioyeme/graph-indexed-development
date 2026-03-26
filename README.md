# gid-rs

Graph Indexed Development — Rust implementation.

A graph-based project management and code intelligence library for AI agents and developers.

## Crates

| Crate | Purpose | Audience |
|-------|---------|----------|
| `gid-core` | Library — all graph logic, code analysis, knowledge management | Rust projects (RustClaw, swebench, your own tools) |
| `gid-cli` | Binary — command-line interface using gid-core | Humans, non-Rust agents, shell scripts |

## Quick Start

### For Rust projects (use gid-core as a library)

Add to your `Cargo.toml`:

```toml
[dependencies]
gid-core = { path = "../gid-rs/crates/gid-core" }  # local
# gid-core = "0.1"  # from crates.io (coming soon)
```

```rust
use gid_core::{Graph, Node, Edge, NodeStatus};
use gid_core::parser::{load_graph, save_graph};

// Load a project's graph
let graph = load_graph(Path::new("my-project/.gid/graph.yml"))?;

// Query tasks
let ready = graph.ready_tasks();
let health = graph.health();
println!("{}", graph.summary_text());
```

### For CLI users (agents, humans, scripts)

```bash
# Install
cargo install --path crates/gid-cli

# Use
gid tasks                    # List tasks
gid add-task "Fix bug"       # Add a task
gid complete my-task          # Mark done
gid visual                   # ASCII graph visualization
```

---

## Knowledge Management

GID supports per-node knowledge storage — agents can record findings, cache files, and track tool usage as they explore code.

### Three types of knowledge

| Type | What it stores | Example |
|------|---------------|---------|
| **findings** | Discoveries about a node (key-value) | `"bug": "off-by-one on line 42"` |
| **file_cache** | File contents read during exploration | `"src/main.py": "def foo(): ..."` |
| **tool_history** | Operations performed on this node | `[{tool: "grep", summary: "searched callers"}]` |

### How to use knowledge (3 approaches)

#### Approach 1: Use gid-core's Graph directly (recommended)

Best for: **RustClaw, your own Rust tools, most cases.**

Node has built-in knowledge fields:

```yaml
# .gid/graph.yml
nodes:
  - id: fix-parser
    title: Fix the parser bug
    status: in_progress
    findings:
      root_cause: "race condition in tokenizer"
      severity: "high"
    file_cache:
      src/parser.rs: |
        pub fn parse(input: &str) -> Result<AST> {
            // ...file contents cached here
    tool_history:
      - tool_name: grep
        timestamp: "2026-03-25T20:00:00Z"
        summary: "searched for all callers of parse()"
```

```rust
use gid_core::{Graph, Node};

let mut graph = load_graph(path)?;
// Read findings
if let Some(node) = graph.get_node("fix-parser") {
    if let Some(cause) = node.findings.get("root_cause") {
        println!("Root cause: {}", cause);
    }
}
// Write findings
if let Some(node) = graph.get_node_mut("fix-parser") {
    node.findings.insert("root_cause".into(), "race condition".into());
}
```

#### Approach 2: Use the KnowledgeManagement trait (advanced)

Best for: **Projects with custom graph types** (e.g., swebench has its own TaskNode).

If your project defines its own node/graph types, implement the trait to get knowledge functions:

```rust
use gid_core::task_graph_knowledge::{KnowledgeGraph, KnowledgeManagement};

// Your custom graph type
struct MyTaskGraph { /* ... */ }

// Implement the required base trait
impl KnowledgeGraph for MyTaskGraph {
    fn get_knowledge_mut(&mut self, node_id: &str) -> Option<&mut KnowledgeNode> { /* ... */ }
    fn get_knowledge(&self, node_id: &str) -> Option<&KnowledgeNode> { /* ... */ }
    fn get_incoming_edges(&self, node_id: &str) -> Vec<String> { /* ... */ }
}

// Get all knowledge functions for free
impl KnowledgeManagement for MyTaskGraph {}

// Now you can use:
my_graph.store_finding("node-1", "bug", "off-by-one")?;
my_graph.cache_file("node-1", "src/main.py", &contents)?;
my_graph.record_tool_call("node-1", "grep", "searched callers")?;
let context = my_graph.get_knowledge_context("node-1");
```

#### Approach 3: Use SimpleKnowledgeGraph standalone

Best for: **Quick prototyping, or when you don't have a graph at all.**

```rust
use gid_core::SimpleKnowledgeGraph;
use gid_core::task_graph_knowledge::KnowledgeManagement;

let mut kb = SimpleKnowledgeGraph::new();
kb.add_node("my-task");
kb.store_finding("my-task", "key", "value")?;
```

### Which approach should I use?

```
Do you use gid-core's Graph type?
  ├─ Yes → Approach 1 (just use node.findings directly)
  └─ No
      ├─ Do you have your own graph type? → Approach 2 (impl the trait)
      └─ No graph at all? → Approach 3 (SimpleKnowledgeGraph)
```

---

## Extending Node with custom fields

gid-core's Node covers common needs. When you need project-specific fields:

### Option A: Use the metadata field (no code changes)

```yaml
nodes:
  - id: parse-args
    title: Fix parse_args
    metadata:
      path: "src/main.py"
      line: 42
      layer: "core"
```

```rust
let line = node.metadata["line"].as_u64();
```

Good for: occasional extra fields, prototyping.
Downside: no compile-time type checking.

### Option B: Define your own Node type (type-safe)

```rust
pub struct MyNode {
    pub id: String,
    pub title: String,
    pub path: Option<String>,    // custom
    pub line: Option<usize>,     // custom
    pub findings: HashMap<String, String>,
}
```

Good for: when you have many custom fields used frequently (like swebench).
Downside: more code to write.

---

## Code Intelligence

gid-core includes a full code graph engine with tree-sitter parsing:

```rust
use gid_core::CodeGraph;

// Extract code structure from a repo
let code_graph = CodeGraph::extract_from_dir(Path::new("my-repo/"));

// Find relevant code for a bug report
let keywords = CodeGraph::extract_keywords("parser crashes on empty input");
let relevant = code_graph.find_relevant_nodes(&keywords);

// Impact analysis — what breaks if I change this function?
let impact = code_graph.impact_analysis(&["my-repo::src/parser.rs::parse"]);

// Find related tests
let tests = code_graph.find_related_tests(&["my-repo::src/parser.rs::parse"]);
```

### Key code graph features

- **Tree-sitter parsing** (Python, with extensible Language enum)
- **Impact analysis** — trace what's affected by a change
- **Causal chain tracing** — from symptoms to root cause
- **Test discovery** — find tests related to changed code
- **Unified graph** — merge code graph + task graph into one view

---

## Architecture

```
gid-rs/
├── crates/
│   ├── gid-core/           # Library crate
│   │   └── src/
│   │       ├── lib.rs              # Public API exports
│   │       ├── graph.rs            # Task graph (Graph, Node, Edge)
│   │       ├── parser.rs           # YAML load/save
│   │       ├── code_graph.rs       # Code intelligence (tree-sitter)
│   │       ├── working_mem.rs      # Agent working memory
│   │       ├── task_graph_knowledge.rs  # Knowledge management trait
│   │       ├── complexity.rs       # Change complexity assessment
│   │       ├── unified.rs          # Code + task graph merging
│   │       ├── query.rs            # Graph queries
│   │       ├── validator.rs        # Graph validation
│   │       ├── visual.rs           # ASCII visualization
│   │       ├── history.rs          # Edit history tracking
│   │       ├── advise.rs           # Next-step advice
│   │       ├── design.rs           # Design doc → graph generation
│   │       ├── semantify.rs        # Code → semantic graph
│   │       ├── refactor.rs         # Graph refactoring
│   │       └── ignore.rs           # .gitignore-style filtering
│   └── gid-cli/            # CLI binary crate
│       └── src/main.rs
└── .gid/graph.yml           # This project's own graph
```

## Per-project graphs

Each project has its own `.gid/graph.yml`. Graphs are completely isolated:

```
~/projects/
├── rustclaw/.gid/graph.yml      # RustClaw's tasks & knowledge
├── gid-rs/.gid/graph.yml        # gid-rs's own tasks
├── autoalpha/.gid/graph.yml     # AutoAlpha's tasks
└── swebench/.gid/graph.yml      # SWE-bench tasks
```

When an agent (RustClaw, gid-cli, etc.) works on a project, it reads that project's graph. Switching projects = reading a different file. No cross-contamination.

---

## License

MIT
