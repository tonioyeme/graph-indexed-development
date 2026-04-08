# Design: Frictionless Graph Operations

## Problem Statement

GID's graph has powerful capabilities (extract, unify, query, context assembly) but the **day-to-day developer workflow has too much friction**. The gap isn't missing features — it's that existing features require too many manual steps to use together.

### Friction Inventory

| Operation | Current Steps | Pain |
|---|---|---|
| Add a feature + tasks | `add-node` feature, N× `add-node` task, N× `add-edge` implements, M× `add-edge` depends_on | 2N+M+1 commands |
| Generate graph from design | `gid design DOC` → copy prompt → feed LLM → copy YAML → `gid design --parse` | 5 steps, 2 context switches |
| Update graph for new feature | Same as above, and `--parse` **overwrites** project layer | Destructive |
| Sync code layer after edits | Manual `gid extract src/` | Must remember to run |
| Find a node to query | Guess the node ID format (`func:src/foo.rs:bar`?) | Trial and error |
| Understand a code area | `impact`? `deps`? `complexity`? `working-memory`? `analyze`? | 5 commands, unclear which |

### Root Cause

The graph was designed **bottom-up** (primitives first: add-node, add-edge, extract). What's missing is a **top-down** layer: high-level operations that compose primitives into workflows.

## Design

### Principle: Compose, Don't Replace

All new operations are **compositions** of existing primitives. No new graph data structures, no schema changes. Just orchestration.

### §1. High-Level Graph Mutations

#### §1.1 `gid add-feature`

One command to create a feature with its task breakdown and all edges.

```
gid add-feature "user-auth" \
  --task "implement JWT validation" \
  --task "add login endpoint" \
  --task "write auth middleware" \
  --dep "add login endpoint" "implement JWT validation"
```

**Agent tool:** A corresponding `gid_add_feature` tool for RustClaw with JSON schema:
```json
{
  "name": "user-auth",
  "tasks": [
    {"title": "implement JWT validation", "deps": [], "status": "todo", "tags": ["p0"]},
    {"title": "add login endpoint", "deps": ["implement JWT validation"]},
    {"title": "write auth middleware", "deps": [], "status": "done", "tags": ["p1"]}
  ]
}
```

All task fields except `title` are optional. Defaults: `status: "todo"`, `tags: []`, `deps: []`.

Produces:
```yaml
nodes:
  - id: feat-user-auth
    title: "user-auth"
    type: feature
    status: todo
  - id: task-implement-jwt-validation
    title: "implement JWT validation"
    type: task
    status: todo
  - id: task-add-login-endpoint
    title: "add login endpoint"
    type: task
    status: todo
  - id: task-write-auth-middleware
    title: "write auth middleware"
    type: task
    status: todo
edges:
  - from: task-implement-jwt-validation
    to: feat-user-auth
    relation: implements
  - from: task-add-login-endpoint
    to: feat-user-auth
    relation: implements
  - from: task-write-auth-middleware
    to: feat-user-auth
    relation: implements
  - from: task-add-login-endpoint
    to: task-implement-jwt-validation
    relation: depends_on
```

**Implementation:**
```rust
/// Ensures a node ID is unique by appending -2, -3, etc. if needed.
fn ensure_unique_id(graph: &Graph, base: String) -> String {
    if graph.get_node(&base).is_none() { return base; }
    for i in 2.. {
        let candidate = format!("{}-{}", base, i);
        if graph.get_node(&candidate).is_none() { return candidate; }
    }
    unreachable!()
}

// New function in graph.rs or a new commands.rs
pub fn add_feature(graph: &mut Graph, name: &str, tasks: &[TaskSpec], deps: &[(&str, &str)]) {
    let feat_id = format!("feat-{}", slugify(name));
    let mut feat = Node::new(&feat_id, name);
    feat.node_type = Some("feature".to_string());
    feat.status = NodeStatus::Todo;
    graph.add_node(feat);

    let mut task_ids: HashMap<String, String> = HashMap::new();
    let feature_slug = slugify(name);
    for spec in tasks {
        let base_id = format!("task-{}-{}", feature_slug, slugify(&spec.title));
        let task_id = ensure_unique_id(graph, base_id);
        let mut task = Node::new(&task_id, &spec.title);
        task.node_type = Some("task".to_string());
        task.status = spec.status.unwrap_or(NodeStatus::Todo);
        task.tags = spec.tags.clone();
        graph.add_node(task);
        graph.add_edge(Edge::new(&task_id, &feat_id, "implements"));
        task_ids.insert(spec.title.clone(), task_id);
    }

    for (from_title, to_title) in deps {
        if let (Some(from_id), Some(to_id)) = (task_ids.get(*from_title), task_ids.get(*to_title)) {
            graph.add_edge(Edge::new(from_id, to_id, "depends_on"));
        }
    }
}

/// Task specification for `add_feature()`.
pub struct TaskSpec {
    pub title: String,
    pub status: Option<NodeStatus>,  // default: Todo
    pub tags: Vec<String>,           // default: []
}
```

**ID generation:** `slugify()` is a **new function to implement** that converts title → kebab-case ID (lowercase, replace spaces/special chars with `-`, collapse multiple `-`). "implement JWT validation" → `implement-jwt-validation`.

**`slugify()` edge case specification:**
- Leading/trailing dashes are stripped
- Consecutive dashes are collapsed to single dash
- Non-ASCII characters are transliterated (e.g., "café" → "cafe") or stripped if no transliteration available
- Empty input or all-stripped input returns `"unnamed"`

**Collision handling:** Task IDs are prefixed with feature slug to avoid collisions: `task-{feature-slug}-{task-slug}` instead of `task-{task-slug}`. If a node ID already exists after prefixing, append `-2`, `-3`, etc.

**Design decisions acknowledgment:** The exact ID format (`feat-{slug}`, `task-{slug}-{task_slug}`), edge relation strings ("subtask_of", "implements"), and metadata keys ("feature", "context") are **design decisions** established in this document. These conventions could be adjusted during implementation if needed, but consistency across the codebase is critical.

Example: feature "user-auth" with task "implement validation" → `task-user-auth-implement-validation`. If that exists, try `task-user-auth-implement-validation-2`.

#### §1.2 `gid add-task`

Lightweight variant for standalone tasks without a parent feature (bug fixes, one-off tasks, etc.).

```
gid add-task "fix UTF-8 panic in parser" --tag bugfix --priority 0
```

Produces one task node. No feature, no ceremony. For small fixes that don't warrant a feature hierarchy.

**Note:** The name `add-task --standalone` could also be used, or keep `add-issue` but document that it's for one-off tasks of any kind, not just bugs.

### §2. Incremental Design Integration

#### §2.1 Problem

`gid design --parse` calls `save_graph()` which **replaces the entire graph**. The `merge_project_layer()` function exists in `unify.rs` but `cmd_design` doesn't use it.

#### §2.2 Solution: Feature-Scoped Merge

```
gid design --merge --scope feat-xxx < llm_response.yaml
```

**Problem with naive merge:** The existing `merge_project_layer()` function **replaces ALL project nodes** with new ones, deleting existing features. This is destructive for incremental workflows.

**RustClaw already does it differently:** RustClaw's `GidDesignTool` (parse=true) already implements **add-if-not-exists** merge:
```rust
if graph.get_node(&node.id).is_none() {
    graph.add_node(node);
}
```

**New approach:** Introduce `merge_feature()` that only replaces nodes belonging to the target feature:

1. In the **existing** graph, find all nodes whose `implements` edges point to the target feature — these are the old feature tasks
2. Remove those old task nodes and their edges from the existing graph
3. Add ALL incoming nodes (everything in the incoming graph belongs to this feature — that's what `--scope feat-xxx` means)
4. Add `implements` edges from each new task node to the feature node
5. Deduplicate edges: before adding any edge, check if an edge with the same `from` + `to` + `relation` already exists
6. Run `resolve_edges_fuzzy()` to fix cross-feature references
7. Re-run `generate_bridge_edges()` to reconnect

```rust
pub fn merge_feature(existing: &mut Graph, feature_id: &str, incoming: Graph) {
    // Step 1: Find and remove OLD feature tasks from existing graph
    let old_task_ids: Vec<String> = existing.edges.iter()
        .filter(|e| e.to == feature_id && e.relation_str() == "implements")
        .map(|e| e.from.clone())
        .collect();
    
    for id in &old_task_ids {
        existing.remove_node(id);  // also removes associated edges
    }
    
    // Step 2: Collect incoming node IDs for fuzzy resolution guard
    let incoming_node_ids: HashSet<String> = incoming.nodes.iter()
        .map(|n| n.id.clone())
        .collect();
    
    // Step 3: Add all incoming nodes
    for node in incoming.nodes {
        existing.add_node(node);
    }
    
    // Step 4: Add implements edges for each new task
    for id in &incoming_node_ids {
        add_edge_dedup(existing, Edge::new(id, feature_id, "implements"));
    }
    
    // Step 5: Add incoming edges with dedup
    for edge in incoming.edges {
        add_edge_dedup(existing, edge);
    }
    
    // Step 6: Fuzzy-resolve edges targeting unknown nodes
    resolve_edges_fuzzy(existing, &incoming_node_ids);
}

/// Add edge only if no edge with same from+to+relation exists.
fn add_edge_dedup(graph: &mut Graph, edge: Edge) {
    let exists = graph.edges.iter().any(|e| 
        e.from == edge.from && e.to == edge.to && e.relation_str() == edge.relation_str()
    );
    if !exists {
        graph.add_edge(edge);
    }
}
```

**Implementation note:** Always use `remove_node()` (not `nodes.retain()`) to remove old feature tasks — `remove_node()` cascades to clean up associated edges. Direct `nodes.retain()` would leave dangling edges, causing data corruption.

**Naming note:** The final implementation could use `merge_feature_nodes()` instead of `merge_feature()` to match the `merge_*_layer()` naming pattern. This design uses `merge_feature()` for brevity.

**Type system clarification:** `Graph::Edge.relation` is a `String` (project layer). The `add_edge_dedup()` function compares string equality via `relation_str()`, not `EdgeRelation` enum variants from the code layer. This prevents implementers from trying to `use EdgeRelation` in graph.rs code.

**Edge dedup applies everywhere:** Both `merge_feature()` and RustClaw's `GidDesignTool` must use `add_edge_dedup()`. The current RustClaw code (tools.rs) calls `graph.add_edge(edge)` unconditionally — calling `gid_design parse=true` twice creates duplicate edges. Fix: replace `graph.add_edge(edge)` with `add_edge_dedup(&mut graph, edge)` in RustClaw's GidDesignTool.

**`--dry-run` support:** Add `--dry-run` flag that prints a summary without saving:
```
$ gid design --merge --scope feat-auth --dry-run < new.yaml
Dry run: Would remove 3 nodes (old feat-auth tasks), add 5 nodes, add 8 edges.
Removed: task-auth-old-1, task-auth-old-2, task-auth-old-3
Added: task-auth-jwt, task-auth-login, task-auth-middleware, task-auth-refresh, task-auth-revoke
```

**Alignment:** Both CLI and RustClaw agent tool should use the same feature-scoped merge strategy:
- CLI `gid design --merge --scope feat-xxx` → feature-scoped merge
- RustClaw `gid_design parse=true` → feature-scoped merge (update from current add-if-not-exists)

**Change in `cmd_design()`:**

This requires updating the CLI's `Design` clap command struct to add two new fields:
```rust
#[derive(Parser)]
struct DesignCmd {
    // ... existing fields ...
    
    /// Merge into existing graph instead of overwriting
    #[arg(long)]
    merge: bool,
    
    /// Feature scope for merge (required with --merge)
    #[arg(long, requires = "merge")]
    scope: Option<String>,
    
    /// Preview merge without saving
    #[arg(long, requires = "merge")]
    dry_run: bool,
}
```

Then the parse branch:
```rust
if parse {
    let incoming = parse_llm_response(&response)?;
    if merge {
        let mut existing = load_graph(&path)?;
        if let Some(ref feature_id) = scope {
            if dry_run {
                // Preview: count what would change
                let old_count = existing.edges.iter()
                    .filter(|e| e.to == *feature_id && e.relation_str() == "implements")
                    .count();
                let new_count = incoming.nodes.len();
                eprintln!("Dry run: Would remove {} nodes, add {} nodes, add {} edges.",
                    old_count, new_count, incoming.edges.len());
            } else {
                merge_feature(&mut existing, feature_id, incoming);
                generate_bridge_edges(&mut existing);
                save_graph(&existing, &path)?;
            }
        } else {
            // Legacy full merge (deprecated)
            merge_project_layer(&mut existing, incoming);
            generate_bridge_edges(&mut existing);
            save_graph(&existing, &path)?;
        }
    } else {
        save_graph(&incoming, &path)?;
    }
}
```

**Effort estimate:** ~80 lines for `merge_feature()` + `add_edge_dedup()`, ~30 lines for CLI struct changes, ~40 lines for the branching logic = **~150 lines total** across graph.rs + main.rs. Not "~20 lines" as originally estimated.

#### §2.3 Scoped Design: Feature-Level Graph Generation

Problem: When adding a feature to an existing project, `generate_graph_prompt()` doesn't know about the existing graph. The LLM generates IDs that clash or don't connect to existing nodes.

Solution: `gid design --scope feat-xxx DESIGN.md`

The prompt includes:
1. The design document content
2. **Existing project-layer nodes** (so LLM knows what already exists)
3. **Instruction**: "Generate ONLY new nodes for this feature. Reference existing nodes by ID in edges."

```rust
pub fn generate_scoped_graph_prompt(
    design_doc: &str,
    existing_project_nodes: &[&Node],
    feature_scope: &str,
) -> String {
    let existing_summary = existing_project_nodes.iter()
        .map(|n| format!("  - {} ({}): {}", n.id, 
            n.node_type.as_deref().unwrap_or("?"),
            n.title))
        .collect::<Vec<_>>()
        .join("\n");

    format!(r#"You are a software architect. Generate ONLY the new graph nodes for feature "{feature_scope}".

EXISTING GRAPH NODES (do NOT recreate these, reference them by ID):
{existing_summary}

NEW FEATURE DESIGN:
{design_doc}

Output YAML with ONLY the new nodes and edges. Use existing node IDs in edges where needed.
..."#)
}
```

**Merge path:** Output goes through `--merge --scope feat-xxx`, so existing graph is preserved.

**Fuzzy edge resolution:** After LLM generates scoped output, run a post-processing step using `resolve_node()` (§3) to fuzzy-match edge targets against existing node IDs. This handles LLM hallucination or minor ID mismatches.

**Important:** Only fuzzy-resolve edges whose targets are neither in the existing graph NOR in the incoming node set. Incoming nodes haven't been added to the graph yet during resolution, so without this guard, edges between new nodes would get incorrectly rewritten to existing nodes.

```rust
fn resolve_edges_fuzzy(graph: &mut Graph, incoming_node_ids: &HashSet<String>) {
    let edges_to_fix: Vec<(usize, String)> = graph.edges.iter().enumerate()
        .filter_map(|(i, edge)| {
            // Only resolve if target is unknown AND not an incoming node
            if graph.get_node(&edge.to).is_none() && !incoming_node_ids.contains(&edge.to) {
                resolve_node(graph, &edge.to).first()
                    .map(|resolved| {
                        eprintln!("⚠ Fuzzy-resolved edge target: {} → {}", edge.to, resolved.id);
                        (i, resolved.id.clone())
                    })
            } else {
                None
            }
        })
        .collect();
    
    for (idx, new_to) in edges_to_fix {
        graph.edges[idx].to = new_to;
    }
}
```

### §3. Fuzzy Node Resolution

#### §3.1 Problem

Node IDs follow conventions (`func:src/foo.rs:bar`, `file:src/foo.rs`, `feat-auth`) but users don't remember exact IDs. Every query requires knowing the precise format.

#### §3.2 Solution: `resolve_node()`

A resolver that finds the best matching node from a human query.

**Priority cascade (explicit ordering):**
1. Exact ID match
2. Exact title match (case-insensitive)
3. ID segment match — structural separators (`:`, `-`, `/`)
4. ID segment match — word separators (`_`)
5. File path match
6. Substring match on title
7. Substring match on ID

```rust
pub fn resolve_node<'a>(graph: &'a Graph, query: &str) -> Vec<&'a Node> {
    // 1. Exact ID match
    if let Some(node) = graph.get_node(query) {
        return vec![node];
    }
    
    // 2. Exact title match (case-insensitive)
    let matches: Vec<_> = graph.nodes.iter()
        .filter(|n| n.title.eq_ignore_ascii_case(query))
        .collect();
    if !matches.is_empty() { return matches; }
    
    // 3a. ID segment match — structural separators first (`:`, `-`, `/`)
    // These split meaningful boundaries: "func:src/foo.rs:bar" → ["func", "src", "foo.rs", "bar"]
    let matches: Vec<_> = graph.nodes.iter()
        .filter(|n| {
            n.id.split(&[':', '-', '/'][..])
               .any(|segment| segment == query)
        })
        .collect();
    if !matches.is_empty() { return matches; }
    
    // 3b. ID segment match — word separators (`_`) as fallback
    // Only tried if structural separators found nothing.
    // Prevents "test" matching "test_utils" which would be a false positive.
    let matches: Vec<_> = graph.nodes.iter()
        .filter(|n| {
            n.id.split(&[':', '-', '/', '_'][..])
               .any(|segment| segment == query)
        })
        .collect();
    if !matches.is_empty() { return matches; }
    
    // 4. File path match — "foo.rs" matches node with file_path containing "foo.rs"
    let matches: Vec<_> = graph.nodes.iter()
        .filter(|n| n.file_path.as_deref().map_or(false, |fp| fp.contains(query)))
        .collect();
    if !matches.is_empty() { return matches; }
    
    // 5. Substring match on title
    let q_lower = query.to_lowercase();
    let matches: Vec<_> = graph.nodes.iter()
        .filter(|n| n.title.to_lowercase().contains(&q_lower))
        .collect();
    if !matches.is_empty() { return matches; }
    
    // 6. Substring match on ID
    graph.nodes.iter()
        .filter(|n| n.id.to_lowercase().contains(&q_lower))
        .collect()
}
```

**Zero-match behavior:** If no matches are found at any priority level, the function returns an empty `Vec<&Node>`. Callers handle this as follows:
- **CLI:** Print `"No node found matching '{query}'."` with suggestions from closest fuzzy matches (edit distance ≤ 3 or prefix matches)
- **Agent tools:** Return `{"matches": []}`

**Disambiguation behavior:**
- **CLI:** If `resolve_node()` returns multiple matches, print a numbered list and exit with non-zero status:
  ```
  Ambiguous query "test" — multiple matches:
    1. func:src/auth/test_jwt.rs:test_validate (Function)
    2. task-user-auth-test-login (Task)
  Use a more specific query or pass the exact ID.
  ```
- **Agent tools:** Return the match list in JSON so the LLM can pick one:
  ```json
  {"ambiguous": true, "matches": [{"id": "func:...", "title": "..."}, ...]}
  ```

**Integration:** All query commands (`impact`, `deps`, `analyze`) use `resolve_node()` instead of `graph.get_node()`. If multiple matches → disambiguation (see above). If exactly one → use it.

```
# Before (exact ID required):
gid query impact func:src/ritual/v2_executor.rs:enrich_implement_context

# After (fuzzy):
gid query impact enrich_implement_context
gid query impact v2_executor
gid query impact "enrich implement"
```

### §4. Unified Query: `gid about`

#### §4.1 Problem

5 different query commands, user doesn't know which to use. Each gives partial picture.

#### §4.2 Solution

One command that gives you everything relevant:

```
gid about <query>
```

**Layering:** `resolve_node()` (§3) is a library function in `graph.rs`. `cmd_about` is a CLI command that uses it. All query commands (`impact`, `deps`, `analyze`) also call `resolve_node()` as a preprocessing step before executing their specific query logic.

Under the hood, it:
1. `resolve_node()` to find the target
2. Uses `QueryEngine` for traversal (not raw edge iteration):
   ```rust
   let engine = QueryEngine::new(&graph);
   let deps = engine.deps(node_id, false);   // direct deps only
   let impacted = engine.impact(node_id);     // what depends on this
   ```
3. If code node → shows file path, signature, line number
4. If task node → shows status, blockers, feature it implements
5. Shows connected nodes up to depth 2

**Implementation:** New `cmd_about()` that composes `resolve_node` + `QueryEngine::deps` + `QueryEngine::impact` + node field display. ~100 lines, no new data structures.

**Output format trade-offs:**
1. **JSON mode:** The `--json` flag produces machine-readable equivalent of all sections
2. **Relationship truncation:** Relationships truncated at 20 per category with `... and N more` suffix to prevent overwhelming output
3. **Source preview truncation:** Source preview truncated at 30 lines with `... (N more lines)` suffix
```
╭─ func:src/ritual/v2_executor.rs:enrich_implement_context ──╮
│ Type: Function (code)                                       │
│ File: src/ritual/v2_executor.rs:245                        │
│ Sig:  fn enrich_implement_context(&self, state: &RitualS.. │
├─────────────────────────────────────────────────────────────┤
│ DEPENDS ON:                                                 │
│  → func:harness/context.rs:assemble_task_context (calls)   │
│  → file:src/ritual/v2_executor.rs (defined_in)             │
│                                                             │
│ DEPENDED ON BY:                                             │
│  ← func:v2_executor.rs:handle_action (calls)               │
│                                                             │
│ RELATED TESTS:                                              │
│  🧪 func:tests/ritual_test.rs:test_enrich_context          │
╰─────────────────────────────────────────────────────────────╯
```

**Implementation:** New `cmd_about()` that composes `resolve_node` + `graph.edges_from` + `graph.edges_to` + node field display. ~100 lines, no new data structures.

### §5. Auto-Sync Code Layer

#### §5.1 Problem

After editing code, `gid extract` must be run manually. Graph goes stale without it.

#### §5.2 Solution: `gid watch`

```
gid watch src/ [--debounce <ms>]
```

Uses `notify = "6"` crate (**needs to be added to gid-cli's Cargo.toml**) to watch for file changes. 

**macOS note:** Use the `fsevent` backend on macOS rather than `kqueue` — `kqueue` has file descriptor leak issues. The `notify` crate's `RecommendedWatcher` selects `fsevent` automatically on macOS.

**Configuration:**
- Debounce: Configurable via `--debounce <ms>` flag (default: 1000ms)
- Ignore patterns: `.gidignore` patterns should be respected by the watcher

On change:
1. Debounce (wait for save-all to complete)
2. Skip extraction if previous one is still running (guard against overlapping extractions)
3. Run `extract_incremental()` (already exists — only re-parses changed files)
4. Run `merge_code_layer()` (already exists)
5. Run `generate_bridge_edges()` (already exists)
6. Save graph

**All the heavy lifting is done.** The watch command is just a loop calling existing functions.

```rust
pub fn watch_and_sync(dir: &Path, gid_dir: &Path, debounce_ms: u64) -> Result<()> {
    let (tx, rx) = channel();
    let mut watcher = RecommendedWatcher::new(tx, Config::default())?;
    watcher.watch(dir, RecursiveMode::Recursive)?;
    
    let mut extraction_running = false;

    loop {
        match rx.recv_timeout(Duration::from_millis(debounce_ms)) {
            Ok(_event) => {
                // Debounce: drain any queued events
                while rx.try_recv().is_ok() {}
                
                // Guard: skip if extraction still running
                if extraction_running {
                    eprintln!("⚠ Skipping extraction, previous one still running");
                    continue;
                }
                
                extraction_running = true;
                
                // Panic-safe: extraction_running is reset even if extract panics
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let meta_path = gid_dir.join("extract-meta.json");
                    let (cg, report) = CodeGraph::extract_incremental(dir, gid_dir, &meta_path, false)?;
                    
                    if report.files_changed > 0 {
                        let (code_nodes, code_edges) = codegraph_to_graph_nodes(&cg, dir);
                        let graph_path = gid_dir.join("graph.yml");
                        let mut graph = Graph::load(&graph_path)?;
                        merge_code_layer(&mut graph, code_nodes, code_edges);
                        generate_bridge_edges(&mut graph);
                        graph.save(&graph_path)?;
                        eprintln!("♻ Graph synced: {} files changed", report.files_changed);
                    }
                    Ok::<_, anyhow::Error>(())
                }));
                
                extraction_running = false;  // Always reset, even after panic
                
                match result {
                    Ok(Ok(())) => {},
                    Ok(Err(e)) => eprintln!("⚠ Extraction error: {}", e),
                    Err(_) => eprintln!("⚠ Extraction panicked, continuing watch"),
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}
```

**Testability:** The watch loop should call a testable `handle_change(path, graph) -> Result<Graph>` function, with the watcher being a thin shell around it. This allows unit testing the core logic without flaky filesystem timing tests in CI.

**Testability:** Extract the core logic (detect change → extract → merge) into a testable function `sync_on_change(path, graph)`. Test that function directly rather than the watch loop, avoiding flaky filesystem timing tests in CI.

#### §5.3 Git Hook Alternative

For users who don't want a daemon:

```bash
# .git/hooks/post-commit
#!/bin/sh
gid extract src/
```

Incremental extraction is the **default behavior** when running `gid extract` (without `--force` flag). For quiet output, use `--json` mode or redirect stderr:

```bash
# JSON output mode (quiet)
gid extract src/ --json >/dev/null

# Or redirect stderr
gid extract src/ 2>/dev/null
```

### §6. Ergonomic Defaults

Small changes that reduce friction across all commands:

#### §6.1 Auto-detect graph path

Currently every command requires `--graph .gid/graph.yml` or relies on default. Walk up from CWD to find `.gid/` directory (like git finds `.git/`):

**Note:** This should extend the existing `find_project_root()` function (line 1662 of main.rs) to also check for `.gid/` as a marker, not create a new function. The existing function checks for `.git/`, `Cargo.toml`, etc. — add `.gid/` to that list.

```rust
fn find_gid_dir() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let gid = dir.join(".gid");
        if gid.is_dir() { return Some(gid); }
        if !dir.pop() { return None; }
    }
}
```

#### §6.2 Default node type inference

**Note:** This is low priority and should only be implemented if trivially easy. Don't design around it.

When running `gid add-node`, infer `type` from ID prefix or context:
- ID starts with `feat-` → `type: feature`
- ID starts with `task-` → `type: task`
- ID starts with `file:` → `type: code`
- Otherwise → `type: task` (most common use case)

#### §6.3 Compact output mode

For agent use, `--json` exists. For human use, default output is verbose. Add `--compact` or make default output denser:

```
# Current verbose:
✓ Added node: task-foo
✓ Added edge: task-foo → feat-bar (implements)
✓ Added edge: task-foo → task-baz (depends_on)
✓ Saved to .gid/graph.yml

# Compact:
+ task-foo → feat-bar (implements), → task-baz (depends_on)
```

## Summary of Changes

| Change | File(s) | Effort | Dependencies |
|---|---|---|---|
| §1.1 `add-feature` | graph.rs + main.rs | Small | None |
| §1.2 `add-task` | graph.rs + main.rs | Tiny | None |
| §2.1–2.2 `design --merge` | graph.rs + main.rs (cmd_design + clap) | Medium | merge_project_layer exists |
| §2.3 Scoped design prompt | design.rs | Small | None |
| §3 Fuzzy node resolution | graph.rs + all query cmds | Medium | None |
| §4 `gid about` | main.rs | Medium | §3 (fuzzy resolve) |
| §5 `gid watch` | new watch.rs + main.rs | Medium | extract_incremental exists |
| §6.1 Auto-detect gid dir | main.rs | Tiny | None |
| §6.2 Type inference | main.rs (cmd_add_node) | Tiny | None |
| §6.3 Compact output | main.rs | Small | None |

## Non-Goals

- **No new graph schema** — all changes work with existing Node/Edge types
- **No LLM integration in gid-core** — design prompts are generated, not executed. The caller (agent, CLI pipe, ritual) handles LLM interaction
- **No GUI** — gidterm exists for TUI visualization, this feature focuses on CLI ergonomics
- **No auto-commit** — `gid watch` updates graph.yml but doesn't git commit

### Integration with Ritual Pipeline

These commands operate on `graph.yml` directly. Ritual state (`.gid/rituals/*.json`) is not affected. If a ritual is active and `gid watch` updates the graph, the ritual should treat it as an external modification (reload graph, re-evaluate context, etc.). No special coupling is needed.

## Testing

- §1: Unit tests for `add_feature()` — verify nodes/edges created correctly, status/tags propagated, ensure_unique_id collision handling
- §2: Unit tests for `merge_feature()` — verify old nodes removed, new nodes added, edge dedup, dry-run output. Unit test for `add_edge_dedup()`. Integration test for CLI `--merge --scope` path.
- §3: Unit tests for `resolve_node()` — exact, suffix (structural separators only), suffix (with `_` fallback), file path, substring, case-insensitive, disambiguation (multiple matches)
- §4: Integration test for `cmd_about` — verify all sections populated, uses QueryEngine
- §5: Integration test for watch with temp dir — create file, verify graph updated, verify panic recovery (extraction_running reset)
- §6: Unit tests for `find_gid_dir()`, type inference
