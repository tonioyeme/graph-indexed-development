# Design: `infer-labeling` — LLM Semantic Labeling

## §1 Overview

### §1.1 Goals

After Infomap produces component nodes (from `infer-clustering`), use LLM to:
1. Name each component with a meaningful title + description
2. Group components into business features
3. Infer feature-level dependencies

**Covers**: GOAL-2.1 through GOAL-2.5

### §1.2 Non-Goals

- Clustering (done by `infer-clustering`)
- Writing to graph storage (done by `infer-integration`)
- Training or fine-tuning LLM

### §1.3 Trade-offs

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| LLM call structure | 2 calls (name components, then group into features) | 1 mega-call | 2 smaller calls are more reliable. Feature grouping needs component names as input. |
| Chunking | Batch ~10 components per naming call | One component per call | Batching reduces API calls 10x. Context per component is small (~200 tokens). |
| Feature→Component | N:M relationship | Strict 1:N partition | N:M is more accurate — "logging" component may belong to both "observability" and "core infrastructure" features. |
| No-LLM fallback | Directory-based naming, no features | Require LLM | Offline/low-cost use case is real (GidHub batch with budget). |

---

## §2 Architecture

### §2.1 Data Flow

```
ClusterResult (from infer-clustering)
  │
  ├─ §3.1 ContextAssembler
  │    └─ for each component: gather file names, class names, function signatures
  │    └─ load README/ARCHITECTURE.md if present
  │    └─ outputs: Vec<ComponentContext>
  │
  ├─ §3.2 ComponentNamer (LLM call 1)
  │    └─ batch components into groups of ~10
  │    └─ LLM names each: title + description
  │    └─ outputs: Vec<ComponentLabel>
  │
  ├─ §3.3 FeatureInferrer (LLM call 2)
  │    └─ send all named components + README
  │    └─ LLM groups into features with titles, descriptions, component memberships
  │    └─ outputs: Vec<FeatureLabel>
  │
  └─ §3.4 DependencyInferrer
       └─ from cross-component edges, derive feature→feature depends_on
       └─ outputs: Vec<Edge>
```

### §2.2 Relationship to Existing Code

**`design.rs`** has similar LLM→graph patterns:
- `generate_features_prompt()` / `parse_features_response()` — prompt + parse for features
- `generate_components_prompt()` / `parse_components_response()` — prompt + parse for components
- `build_graph_from_proposals()` — converts proposals to graph nodes

**`llm_client.rs`** provides the LLM abstraction:
```rust
pub trait LlmClient: Send + Sync {
    fn complete(&self, prompt: &str, config: &LlmConfig) -> Result<String>;
}
```

We follow the same pattern: structured prompt → JSON response → parse → typed result.

---

## §3 Components

### §3.1 ContextAssembler

Gathers information about each component's code members to send to LLM.

```rust
pub struct ComponentContext {
    /// Component node ID (e.g. "infer:component:3")
    pub component_id: String,
    /// Auto-generated name from clustering (directory-based)
    pub auto_name: String,
    /// File paths in this component
    pub files: Vec<String>,
    /// Class/struct names found in member files
    pub class_names: Vec<String>,
    /// Top-level function names (max 20 per component)
    pub function_names: Vec<String>,
    /// File-level brief (first doc comment or module doc, max 200 chars per file)
    pub file_briefs: Vec<String>,
}

pub struct ProjectContext {
    /// README.md content (truncated to 2000 chars)
    pub readme: Option<String>,
    /// ARCHITECTURE.md content (truncated to 2000 chars)
    pub architecture_doc: Option<String>,
    /// Project name from graph.project.name
    pub project_name: Option<String>,
}

/// Assemble LLM context for each component from the graph.
/// Reads file content from disk for briefs when project_root is provided.
pub fn assemble_contexts(
    graph: &Graph,
    cluster_result: &ClusterResult,
    project_root: Option<&Path>,
) -> (Vec<ComponentContext>, ProjectContext) {
    // For each component node in cluster_result:
    //   1. Get member code node IDs from "contains" edges
    //   2. Look up each member in graph → extract file_path, title
    //   3. For file nodes: collect class/function children via defined_in edges
    //   4. If project_root is Some: read first doc comment from file (max 200 chars) for file_briefs
    //      If project_root is None (GidHub headless mode): skip file_briefs (empty vec)
    //   5. Truncate lists (max 20 functions, max 10 files with briefs)
    //
    // For project context:
    //   1. Check graph.project for name
    //   2. Look for README.md node → read content from metadata or file_path
    //   3. Look for ARCHITECTURE.md similarly
    //   4. Truncate to 2000 chars each
}
```

**Token budget awareness** (GUARD-4): Each `ComponentContext` is estimated at ~200-400 tokens. With 10 components per batch, that's 2-4k tokens input per LLM call. For a project with 30 components, that's 3 naming calls (~12k tokens) + 1 feature call (~6k tokens) = ~18k tokens total. Well within 50k budget for typical projects.

For large projects (50+ components): context is truncated — fewer function names, shorter briefs. The `max_tokens_estimate()` method tracks budget.

**Satisfies**: GOAL-2.4 (README/doc augmentation)

### §3.2 ComponentNamer

LLM call to name components.

```rust
pub struct ComponentLabel {
    pub component_id: String,
    pub title: String,        // e.g. "Authentication & Session Management"
    pub description: String,  // e.g. "Handles user login, JWT tokens, and session lifecycle"
}

pub struct NamingConfig {
    /// Max components per LLM batch (default: 10)
    pub batch_size: usize,
    /// Max tokens per naming call (default: 4000)
    pub max_tokens: usize,
}

/// Name components via LLM.
/// Returns None for each component where LLM fails (graceful degradation).
pub fn name_components(
    contexts: &[ComponentContext],
    project: &ProjectContext,
    llm: &dyn LlmClient,
    config: &NamingConfig,
) -> Vec<ComponentLabel> {
    // 1. Chunk contexts into batches of config.batch_size
    // 2. For each batch, build prompt (see §3.2.1)
    // 3. Call llm.complete(prompt, ...)
    // 4. Parse JSON response → Vec<ComponentLabel>
    //    a. Strip markdown code fences (```json ... ```)
    //    b. Try serde_json::from_str
    //    c. On failure: repair (trim trailing commas, close brackets)
    //    d. On persistent failure: retry once with explicit "respond in valid JSON only" prompt
    //    e. THEN fall back to auto_name
    //    Reuse parse pattern from design.rs::parse_features_response()
    // 5. On total LLM failure: use auto_name as fallback title, empty description
}
```

#### §3.2.1 Naming Prompt Template

```
You are analyzing a software project{project_name_clause}.
{readme_excerpt}

Below are code components detected by clustering analysis. For each component,
provide a concise title (2-5 words) and a one-sentence description.

Components:
{for each component in batch:}
---
Component ID: {component_id}
Files: {files, comma-separated}
Classes/Structs: {class_names}
Key Functions: {function_names, max 10}
{end for}

Respond in JSON:
[
  {"id": "{component_id}", "title": "...", "description": "..."},
  ...
]
```

**Satisfies**: GOAL-2.1 (component naming)

### §3.3 FeatureInferrer

LLM call to group components into features.

```rust
pub struct FeatureLabel {
    pub id: String,           // generated: "infer:feature:{index}"
    pub title: String,        // e.g. "User Management"
    pub description: String,  // e.g. "User registration, authentication, profiles, and permissions"
    pub component_ids: Vec<String>,  // N:M — components belonging to this feature
}

/// Infer features from named components.
pub fn infer_features(
    labels: &[ComponentLabel],
    project: &ProjectContext,
    llm: &dyn LlmClient,
) -> Vec<FeatureLabel> {
    // 1. Build prompt with ALL component labels (they're short — title + description)
    // 2. Ask LLM to group into 3-10 business features
    // 3. Parse JSON response
    //    a. Strip markdown code fences (```json ... ```)
    //    b. Try serde_json::from_str
    //    c. On failure: repair (trim trailing commas, close brackets)
    //    d. On persistent failure: retry once with explicit "respond in valid JSON only" prompt
    //    e. THEN return empty vec (no features, components still exist)
    // 4. Validate: if <3 features, accept as-is (small project); if >10, take top 10 by component count; log warning either way
}
```

#### §3.3.1 Feature Prompt Template

```
You are analyzing a software project{project_name_clause}.
{readme_excerpt}

The project has these components (detected by code analysis):
{for each component:}
- {component_id}: {title} — {description}
{end for}

Group these components into high-level business features (3-10 features).
A component may belong to multiple features if it serves multiple purposes.

Respond in JSON:
[
  {
    "title": "...",
    "description": "...",
    "components": ["{component_id}", ...]
  },
  ...
]
```

**Satisfies**: GOAL-2.2 (feature inference, N:M relationship)

### §3.4 DependencyInferrer

Derives feature→feature dependencies from code-level cross-component edges. No LLM needed — purely algorithmic.

```rust
/// Infer feature-level dependencies from cross-component code edges.
pub fn infer_feature_deps(
    graph: &Graph,
    cluster_result: &ClusterResult,
    features: &[FeatureLabel],
) -> Vec<Edge> {
    // 1. Build component_id → feature_ids map (N:M)
    // 2. For each code edge that crosses component boundaries:
    //    a. Find source component → source features
    //    b. Find target component → target features
    //    c. For each (source_feature, target_feature) pair where source != target
    //       AND source and target components belong to DIFFERENT features
    //       (shared feature membership via N:M does NOT count as dependency):
    //       Increment dependency weight counter
    // 3. Create depends_on edges for pairs above a threshold (≥2 cross-component edges)
    // 4. Edge metadata: { "source": "infer", "weight": cross_edge_count }
}
```

**Threshold**: A feature depends on another only if there are ≥2 cross-component code edges between them. This filters out incidental single-import dependencies.

**Satisfies**: GOAL-2.3 (feature dependency inference)

### §3.5 LabelingResult & Public API

```rust
pub struct LabelingResult {
    /// Named component updates (title + description to apply to existing component nodes)
    pub component_labels: Vec<ComponentLabel>,
    /// New feature nodes to create
    pub feature_nodes: Vec<FeatureLabel>,
    /// Feature→feature dependency edges
    pub feature_deps: Vec<Edge>,
    /// Feature→component membership edges
    pub feature_component_edges: Vec<Edge>,
    /// Token usage stats
    pub token_usage: TokenUsage,
}

pub struct TokenUsage {
    pub input_tokens: usize,
    pub output_tokens: usize,
    pub num_calls: usize,
}

pub struct LabelingConfig {
    pub naming_batch_size: usize,  // default: 10
    pub max_total_tokens: usize,   // default: 50_000 (GUARD-4)
    pub model: String,             // default: "claude-sonnet-4-20250514"
}

/// Run LLM labeling on clustered components.
/// If llm is None, returns empty result (caller should use auto_name from clustering).
pub fn label(
    graph: &Graph,
    cluster_result: &ClusterResult,
    llm: Option<&dyn LlmClient>,
    config: &LabelingConfig,
) -> Result<LabelingResult> {
    let llm = match llm {
        Some(l) => l,
        None => return Ok(LabelingResult::empty()), // --no-llm mode
    };
    
    // 1. Assemble contexts
    let (comp_contexts, proj_context) = assemble_contexts(graph, cluster_result, None);
    
    // 2. Name components (LLM call 1, possibly batched)
    let naming_config = NamingConfig {
        batch_size: config.naming_batch_size,
        max_tokens: 4000,
    };
    let labels = name_components(&comp_contexts, &proj_context, llm, &naming_config);
    
    // 3. Infer features (LLM call 2)
    let features = infer_features(&labels, &proj_context, llm);
    
    // 4. Derive feature dependencies (no LLM)
    let feature_deps = infer_feature_deps(graph, cluster_result, &features);
    
    // 5. Build feature→component edges
    let fc_edges = build_feature_component_edges(&features);
    
    Ok(LabelingResult { component_labels: labels, feature_nodes: features, feature_deps, feature_component_edges: fc_edges, token_usage })
}
```

---

## §4 Data Flow — End to End

```
ClusterResult (component nodes + contains edges from infer-clustering)
  │
  │  Step 1: assemble_contexts()
  │  → For each component, gather member file names, class names, function names
  │  → Load README.md / ARCHITECTURE.md from graph
  │  → Output: Vec<ComponentContext> + ProjectContext
  │
  │  Step 2: name_components() [LLM CALL]
  │  → Batch 10 components per prompt
  │  → LLM returns JSON: [{id, title, description}, ...]
  │  → Parse, validate (no empty titles, no "Component 1")
  │  → Fallback on failure: use auto_name from clustering
  │  → Output: Vec<ComponentLabel>
  │
  │  Step 3: infer_features() [LLM CALL]  
  │  → Single prompt with all component labels
  │  → LLM returns JSON: [{title, description, components: [ids]}, ...]
  │  → Validate: 3-10 features, every component covered, valid IDs
  │  → Fallback on failure: no features created (components still exist)
  │  → Output: Vec<FeatureLabel>
  │
  │  Step 4: infer_feature_deps() [NO LLM]
  │  → Count cross-component edges between feature groups
  │  → Threshold ≥2 → depends_on edge
  │  → Output: Vec<Edge>
  │
  └─ LabelingResult { component_labels, feature_nodes, feature_deps, feature_component_edges, token_usage }
```

---

## §5 Guard Implementation

### GUARD-3: LLM Failure → Graceful Degradation

Three levels of failure:

| Failure | Impact | Fallback |
|---------|--------|----------|
| Single naming batch fails | Some components unnamed | Use auto_name from clustering |
| Feature inference fails | No feature layer | Components still exist with names. Log warning. |
| All LLM calls fail | No naming, no features | Equivalent to `--no-llm`. Clustering result still valid. |

Implementation: Each LLM call is wrapped in `match llm.complete(...) { Ok(resp) => parse(resp), Err(e) => { warn!("LLM failed: {e}"); fallback } }`.

### GUARD-4: Token Budget Cap

```rust
struct TokenBudget {
    limit: usize,      // default 50_000
    consumed: usize,
}

impl TokenBudget {
    fn can_afford(&self, estimated: usize) -> bool {
        self.consumed + estimated <= self.limit
    }
    fn record(&mut self, estimated: usize) {
        // Track using estimated tokens (conservative).
        // LlmClient::complete() returns String only — no usage stats available.
        // Estimated tokens are always >= actual, so budget tracking is safe (may under-spend, never over-spend).
        self.consumed += estimated;
    }
}
```

Before each LLM call, estimate tokens from context size. If budget exceeded:
1. For naming: truncate function_names and file_briefs (reduce context, not skip components)
2. For features: if still over budget, skip feature inference entirely (warn user)

---

## §6 Configuration

```yaml
infer:
  labeling:
    model: "claude-sonnet-4-20250514"
    naming_batch_size: 10
    max_total_tokens: 50000
```

CLI overrides: `--model`, `--max-tokens`

---

## §7 Testing Strategy

### §7.1 Unit Tests (no LLM)

| Test | What | GOAL |
|------|------|------|
| `test_assemble_context_basic` | 3 components → correct file/class/function lists | 2.4 |
| `test_assemble_context_with_readme` | README loaded and truncated to 2000 chars | 2.4 |
| `test_assemble_context_no_readme` | Works without README | 2.4 |
| `test_parse_naming_response` | Valid JSON → ComponentLabel | 2.1 |
| `test_parse_naming_response_invalid` | Malformed JSON → fallback names | GUARD-3 |
| `test_parse_feature_response` | Valid JSON → FeatureLabel with N:M | 2.2 |
| `test_parse_feature_response_invalid` | Malformed → empty features | GUARD-3 |
| `test_infer_feature_deps` | Cross-component edges → feature deps | 2.3 |
| `test_infer_feature_deps_threshold` | Single cross-edge → no dependency (below threshold) | 2.3 |
| `test_token_budget_enforcement` | Budget tracking, truncation on exceed | GUARD-4 |
| `test_no_llm_mode` | label(llm=None) → empty result, no panic | 2.5 |

### §7.2 Integration Tests (with mock LLM)

| Test | What |
|------|------|
| `test_full_labeling_pipeline` | Mock LLM → complete LabelingResult with features + deps |
| `test_llm_failure_degradation` | Mock LLM returns error → fallback names, no features |
| `test_batch_naming` | 25 components → 3 batches of ~10 |
