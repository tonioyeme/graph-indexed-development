# Ritual Executors — Design

## Architecture

```
engine.run()
  └─ for each phase:
      ├─ match phase.kind:
      │   ├─ Skill → SkillExecutor.execute()
      │   │   ├─ Load skill prompt (from template or .gid/features/)
      │   │   ├─ Create LLM session with ToolScope filter
      │   │   ├─ Run agentic loop until completion
      │   │   └─ Collect produced artifacts
      │   ├─ Harness → HarnessExecutor.execute()
      │   │   ├─ Load task graph from .gid/graph.yml
      │   │   ├─ Create HarnessConfig from ritual overrides
      │   │   ├─ Run scheduler.execute() (existing harness)
      │   │   └─ Report task completion/failure as phase result
      │   ├─ GidCommand → GidCommandExecutor.execute()
      │   │   ├─ Spawn `gid <command> <args>` subprocess
      │   │   └─ Capture output, check exit code
      │   └─ Shell → ShellExecutor.execute()
      │       ├─ Validate command against bash_policy
      │       ├─ Run in working directory
      │       └─ Check exit code + output artifacts
      └─ Check artifacts → advance or fail
```

## SkillExecutor Detail

The key challenge: SkillExecutor needs to CREATE an LLM session.
This is different from the other executors which run CLI commands.

### Option A: Use agent runtime directly (Recommended)
SkillExecutor takes an `LlmClient` trait object:
```rust
pub struct SkillExecutor {
    project_root: PathBuf,
    llm_client: Arc<dyn LlmClient>,  // Injected by the caller
}
```
The caller (RustClaw, gidterm, or CLI) provides its own LLM client.
This keeps gid-core free of LLM provider dependencies.

### Option B: Shell out to agent CLI
SkillExecutor runs `rustclaw exec --skill research --scope .gid/features/auth/`.
Simpler but requires a specific agent runtime to be installed.

### Decision: Option A
- Clean dependency injection
- Works with any agent runtime
- Testable with mock LlmClient

## LlmClient Trait (New, in gid-core)
```rust
#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn run_skill(
        &self,
        skill_prompt: &str,
        tools: Vec<ToolDefinition>,
        model: &str,
    ) -> Result<SkillResult>;
}

pub struct SkillResult {
    pub output: String,
    pub artifacts_created: Vec<PathBuf>,
    pub tool_calls_made: usize,
}
```

## HarnessExecutor Detail

Delegates to the existing harness scheduler:
```rust
pub struct HarnessExecutor {
    project_root: PathBuf,
    llm_client: Arc<dyn LlmClient>,
}

impl HarnessExecutor {
    async fn execute(&self, phase: &PhaseDefinition, ctx: &PhaseContext) -> Result<PhaseResult> {
        let config = HarnessConfig::from_overrides(phase.harness_config.as_ref());
        let graph = TaskGraph::load(&ctx.gid_root.join("graph.yml"))?;
        let scheduler = Scheduler::new(graph, config);
        scheduler.execute(self.llm_client.clone()).await
    }
}
```

## Implementation Order
1. Define `LlmClient` trait in gid-core
2. Implement SkillExecutor with LlmClient
3. Implement HarnessExecutor delegating to scheduler
4. Wire GidCommandExecutor to subprocess
5. Add ToolScope validation to ShellExecutor
6. Integration tests with mock LlmClient
