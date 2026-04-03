# Ritual v2 — Pure Function State Machine Design

> 从今天讨论中提炼的完整优化方案

## 问题

RustClaw收到dev task后不一定走ritual流程。AGENTS.md里的规则靠LLM自觉遵守，经常被跳过。需要代码层面强制。

## 架构总览

```
👤 用户（自然语言）
   ↓
🐾 RustClaw Agent
   ├── Tool Gating（外层门控）
   │   └── 无active ritual时，拦截src/写入 → 强制进入ritual
   ↓
⚙️ gid-core
   ├── Ritual Engine（纯函数状态机）
   │   ├── State: Idle → Designing → Planning → Graphing → Implementing → Verifying → Done
   │   ├── Events: Start, ProjectDetected, SkillCompleted, SkillFailed, ShellCompleted, ShellFailed, UserCancel
   │   └── Actions: DetectProject, RunSkill, RunShell, RunHarness, RunPlanning, Notify, SaveState
   ├── Composer（动态组装 — 代码+LLM混合）
   │   ├── 代码检测：DESIGN.md? graph.yml? src/? Cargo.toml?
   │   └── LLM判断：feature大小、拆不拆子任务（在Planning phase）
   ├── Executor（副作用执行器）
   │   ├── SkillExecutor — LLM + Read/Write/Edit/Bash tools
   │   ├── ShellExecutor — cargo test, cargo build
   │   └── HarnessExecutor — 多agent并行（大feature用）
   └── ToolScope（内层权限控制）
       └── 每个phase限制可用工具和路径
```

## 1. Tool Gating（触发层）

### 位置
`rustclaw/src/agent.rs` — 工具执行前

### 配置（`.gid/config.yml`）
```yaml
ritual:
  gating:
    enabled: true                # 可关闭（调试用）
    gated_paths:                 # 写入这些路径需要active ritual
      - "src/**"
      - "tests/**"
      - "crates/**"
      - "lib/**"
      - "Cargo.toml"
      - "package.json"
      - "*.rs"                   # 根目录的.rs文件
    ungated_paths:               # 白名单（优先级高于gated）
      - "DESIGN.md"
      - ".gid/**"
      - "docs/**"
      - "memory/**"
      - "AGENTS.md"
      - "TOOLS.md"
    gated_commands:              # 这些shell命令需要active ritual
      - pattern: "^cargo\\s+(build|run|test|check)\\b"
        type: regex
      - pattern: "^rustc\\b"
        type: regex
      - pattern: "^npm\\s+run\\s+(build|start)\\b"
        type: regex
      - pattern: "^gcc\\b"
        type: regex
    verify_command: "cargo build 2>&1 && cargo test 2>&1"  # 配置化，不hardcode
```

不同项目可以有不同配置。`gid init` 时根据语言生成默认配置。

### 默认配置（按语言）
```rust
fn default_gating_config(lang: &ProjectLanguage) -> GatingConfig {
    match lang {
        Rust => GatingConfig {
            gated_paths: vec!["src/**", "tests/**", "crates/**", "Cargo.toml", "build.rs"],
            ungated_paths: default_ungated(),
            gated_commands: vec![
                CommandPattern::regex(r"^cargo\s+(build|run|test|check)\b"),
                CommandPattern::regex(r"^rustc\b"),
            ],
            verify_command: "cargo build 2>&1 && cargo test 2>&1".into(),
            ..defaults()
        },
        TypeScript => GatingConfig {
            gated_paths: vec!["src/**", "lib/**", "tests/**", "package.json", "tsconfig.json"],
            ungated_paths: default_ungated(),
            gated_commands: vec![
                CommandPattern::regex(r"^npm\s+run\s+(build|start)\b"),
                CommandPattern::regex(r"^tsc\b"),
            ],
            verify_command: "npm run build 2>&1 && npm test 2>&1".into(),
            ..defaults()
        },
        Python => GatingConfig {
            gated_paths: vec!["**/*.py", "setup.py", "pyproject.toml"],
            ungated_paths: default_ungated(),
            gated_commands: vec![
                CommandPattern::regex(r"^python\b"),
                CommandPattern::regex(r"^pip\s+install"),
            ],
            verify_command: "python -m pytest 2>&1".into(),
            ..defaults()
        },
        Go => GatingConfig {
            gated_paths: vec!["**/*.go", "go.mod", "go.sum"],
            ungated_paths: default_ungated(),
            gated_commands: vec![
                CommandPattern::regex(r"^go\s+(build|run|test)\b"),
            ],
            verify_command: "go build ./... 2>&1 && go test ./... 2>&1".into(),
            ..defaults()
        },
        _ => GatingConfig {
            verify_command: "echo 'No verify command configured'".into(),
            ..defaults()
        },
    }
}

fn default_ungated() -> Vec<String> {
    vec!["DESIGN.md", ".gid/**", "docs/**", "memory/**", "AGENTS.md", "TOOLS.md"]
}
```

### 逻辑
```rust
fn check_tool_gating(&self, tool_name: &str, input: &Value) -> Result<(), String> {
    // 如果ritual active，放行（内层ToolScope接管）
    if self.get_active_scope().is_some() {
        return Ok(());
    }
    
    // 读取gating配置
    let config = self.load_gating_config();
    if !config.enabled {
        return Ok(());
    }
    
    // 无ritual时，检查是否为gated操作
    if self.is_gated_operation(tool_name, input, &config) {
        return Err(
            "⚠️ Source code changes require an active ritual.\n\
             Call gid_ritual_init(task=\"your task description\") first.\n\
             This ensures design → implement → verify quality gates."
            .to_string()
        );
    }
    
    Ok(())
}

fn is_gated_operation(&self, tool: &str, input: &Value, config: &GatingConfig) -> bool {
    match tool {
        "write_file" | "edit_file" => {
            let path = input["path"].as_str().unwrap_or("");
            // 白名单优先
            if config.ungated_paths.iter().any(|p| glob_match(p, path)) {
                return false;
            }
            config.gated_paths.iter().any(|p| glob_match(p, path))
        }
        "exec" => {
            let cmd = input["command"].as_str().unwrap_or("");
            config.gated_commands.iter().any(|gc| gc.matches(cmd))
        }
        _ => false,
    }
}
```

## 2. 纯函数状态机（执行层）

### RitualState（完整定义）
```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RitualState {
    pub phase: RitualPhase,
    pub task: String,                          // 用户的原始task描述
    pub project: Option<ProjectState>,         // 项目检测结果
    pub strategy: Option<ImplementStrategy>,   // Planning决定的策略
    pub verify_retries: u32,                   // verify→implement重试次数
    pub phase_retries: HashMap<String, u32>,   // 每个phase的重试次数（design等也可重试）
    pub failed_phase: Option<RitualPhase>,     // escalated时记录哪个phase失败
    pub error_context: Option<String>,         // 最近一次失败的error
    pub transitions: Vec<TransitionRecord>,    // 转移历史（调试用）
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransitionRecord {
    pub from: RitualPhase,
    pub to: RitualPhase,
    pub event: String,       // event简述
    pub timestamp: DateTime<Utc>,
}

impl RitualState {
    pub fn new() -> Self {
        Self {
            phase: RitualPhase::Idle,
            task: String::new(),
            project: None,
            strategy: None,
            verify_retries: 0,
            phase_retries: HashMap::new(),
            failed_phase: None,
            error_context: None,
            transitions: Vec::new(),
            started_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    pub fn with_phase(mut self, phase: RitualPhase) -> Self {
        self.transitions.push(TransitionRecord {
            from: self.phase.clone(),
            to: phase.clone(),
            event: format!("{:?} → {:?}", self.phase, phase),
            timestamp: Utc::now(),
        });
        self.phase = phase;
        self.updated_at = Utc::now();
        self
    }

    pub fn with_task(mut self, task: String) -> Self {
        self.task = task;
        self
    }

    pub fn with_project(mut self, ps: ProjectState) -> Self {
        self.project = Some(ps);
        self
    }

    pub fn with_strategy(mut self, strategy: ImplementStrategy) -> Self {
        self.strategy = Some(strategy);
        self
    }

    pub fn inc_verify_retries(mut self) -> Self {
        self.verify_retries += 1;
        self
    }

    pub fn inc_phase_retry(mut self, phase_key: &str) -> Self {
        *self.phase_retries.entry(phase_key.to_string()).or_insert(0) += 1;
        self
    }

    pub fn with_failed_phase(mut self, phase: RitualPhase) -> Self {
        self.failed_phase = Some(phase);
        self
    }

    pub fn with_error_context(mut self, error: String) -> Self {
        self.error_context = Some(error);
        self
    }

    /// 获取某个phase的重试次数
    pub fn retries_for(&self, phase_key: &str) -> u32 {
        *self.phase_retries.get(phase_key).unwrap_or(&0)
    }

    /// 获取配置的verify命令（从project config读取）
    pub fn verify_command(&self) -> &str {
        // 从config读取，fallback到语言默认值
        self.project.as_ref()
            .and_then(|p| p.verify_command.as_deref())
            .unwrap_or("echo 'No verify command configured'")
    }
}
```

### States
```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum RitualPhase {
    Idle,           // 无ritual
    Initializing,   // 检测项目状态
    Designing,      // 写/更新DESIGN.md
    Planning,       // LLM判断工作量和实现策略
    Graphing,       // 生成/更新graph
    Implementing,   // 写代码
    Verifying,      // cargo test / cargo build
    Done,           // 完成
    Escalated,      // 失败，等用户决定
    Cancelled,      // 用户取消
}

impl RitualPhase {
    /// 人类可读的phase名称
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Initializing => "Initializing",
            Self::Designing => "Design",
            Self::Planning => "Planning",
            Self::Graphing => "Graph",
            Self::Implementing => "Implement",
            Self::Verifying => "Verify",
            Self::Done => "Done",
            Self::Escalated => "Escalated",
            Self::Cancelled => "Cancelled",
        }
    }

    /// 下一个正常flow的phase（用于skip）
    pub fn next(&self) -> Option<RitualPhase> {
        match self {
            Self::Initializing => Some(Self::Designing),
            Self::Designing => Some(Self::Planning),
            Self::Planning => Some(Self::Graphing),
            Self::Graphing => Some(Self::Implementing),
            Self::Implementing => Some(Self::Verifying),
            Self::Verifying => Some(Self::Done),
            _ => None,  // Idle, Done, Escalated, Cancelled没有next
        }
    }
}
```

### Events
```rust
pub enum RitualEvent {
    // 用户事件
    Start { task: String },
    UserCancel,
    UserRetry,
    UserSkipPhase,

    // 系统事件
    ProjectDetected(ProjectState),
    PlanDecided(ImplementStrategy),
    SkillCompleted { phase: String, artifacts: Vec<String> },
    SkillFailed { phase: String, error: String },
    ShellCompleted { stdout: String, exit_code: i32 },
    ShellFailed { stderr: String, exit_code: i32 },
}

pub enum ImplementStrategy {
    SingleLlm,
    MultiAgent { tasks: Vec<String> },
}
```

**注意**: `SkillFailed` 不带 `retries` 字段。重试次数由transition函数从 `state.phase_retries` 读取，不依赖event传递。

### ProjectState（扩展）
```rust
pub struct ProjectState {
    pub has_design: bool,
    pub has_graph: bool,
    pub has_source: bool,
    pub has_tests: bool,
    pub language: Option<ProjectLanguage>,
    pub source_file_count: usize,
    pub verify_command: Option<String>,  // 从.gid/config.yml读取
}
```

### Actions
```rust
pub enum RitualAction {
    DetectProject,                                    // executor读文件系统+配置 → ProjectDetected
    RunSkill { name: String, context: String },       // executor调LLM skill → SkillCompleted/SkillFailed
    RunShell { command: String },                     // executor跑命令 → ShellCompleted/ShellFailed
    RunHarness { tasks: Vec<String> },                // executor启动多agent → SkillCompleted/SkillFailed
    RunPlanning,                                      // executor读DESIGN.md + 调LLM → PlanDecided
    UpdateGraph { description: String },              // executor自行查graph找相关node更新
    Notify { message: String },                       // executor发Telegram（fire-and-forget）
    SaveState,                                        // executor写ritual-state.json
    Cleanup,                                          // executor清理临时文件
}
```

**Action分类（executor行为）：**
- **Event-producing**: `DetectProject`, `RunSkill`, `RunShell`, `RunHarness`, `RunPlanning` — 执行后返回一个Event
- **Fire-and-forget**: `Notify`, `SaveState`, `Cleanup`, `UpdateGraph` — 执行后不产生Event

Executor先执行所有fire-and-forget actions，然后执行唯一的event-producing action，返回其Event。

**约束**: 每个transition至多产出一个event-producing action。如果违反，编译期不检查但executor会panic。

**`UpdateGraph`**: executor收到后自行查询graph，根据 `description` 找到相关task node并更新状态。状态机不需要知道graph node ID — 这是executor的实现细节。

### Transition函数（核心 — 纯函数，零IO）
```rust
/// 纯函数。输入(状态, 事件)，输出(新状态, 动作列表)。
/// 不读文件、不调网络、不写任何东西。100%可单元测试。
fn transition(
    state: &RitualState,
    event: RitualEvent,
) -> (RitualState, Vec<RitualAction>) {
    use RitualPhase::*;
    use RitualEvent::*;
    use RitualAction::*;

    match (&state.phase, event) {
        // ═══════════════════════════════════════
        // 正常流程
        // ═══════════════════════════════════════

        // ── 启动 ──
        (Idle, Start { task }) => (
            state.clone().with_phase(Initializing).with_task(task.clone()),
            vec![
                Notify { message: format!("🔧 Ritual started: \"{}\"", task) },
                SaveState,
                DetectProject,
            ],
        ),

        // ── 项目检测完成 → 选Design skill ──
        (Initializing, ProjectDetected(ps)) => {
            let skill = if ps.has_design { "update-design" } else { "draft-design" };
            (
                state.clone().with_phase(Designing).with_project(ps),
                vec![
                    Notify { message: format!("📝 Phase 1/4: {}...", skill) },
                    SaveState,
                    RunSkill { name: skill.into(), context: state.task.clone() },
                ],
            )
        },

        // ── Design完成 → Planning ──
        (Designing, SkillCompleted { .. }) => (
            state.clone().with_phase(Planning),
            vec![
                Notify { message: "🧠 Planning implementation strategy...".into() },
                SaveState,
                RunPlanning,  // executor读DESIGN.md + 调LLM → PlanDecided
            ],
        ),

        // ── Planning决定策略 → Graphing ──
        (Planning, PlanDecided(strategy)) => {
            let skill = if state.project.as_ref().map_or(false, |p| p.has_graph) {
                "update-graph"
            } else {
                "generate-graph"
            };
            (
                state.clone().with_phase(Graphing).with_strategy(strategy),
                vec![
                    Notify { message: format!("📊 Phase 2/4: {}...", skill) },
                    SaveState,
                    RunSkill { name: skill.into(), context: state.task.clone() },
                ],
            )
        },

        // ── Graph完成 → Implementing ──
        (Graphing, SkillCompleted { .. }) => {
            let action = match &state.strategy {
                Some(ImplementStrategy::MultiAgent { tasks }) =>
                    RunHarness { tasks: tasks.clone() },
                _ =>
                    RunSkill { name: "implement".into(), context: state.task.clone() },
            };
            (
                state.clone().with_phase(Implementing),
                vec![
                    Notify { message: "💻 Phase 3/4: Implementing...".into() },
                    SaveState,
                    action,
                ],
            )
        },

        // ── Implement完成 → Verifying ──
        (Implementing, SkillCompleted { .. }) => {
            let cmd = state.verify_command().to_string();
            (
                state.clone().with_phase(Verifying),
                vec![
                    Notify { message: "✅ Phase 4/4: Verifying...".into() },
                    SaveState,
                    RunShell { command: cmd },
                ],
            )
        },

        // ── Verify成功 → Done ──
        (Verifying, ShellCompleted { exit_code, .. }) if exit_code == 0 => (
            state.clone().with_phase(Done),
            vec![
                Notify { message: "🎉 Ritual complete!".into() },
                UpdateGraph { description: state.task.clone() },
                SaveState,
                Cleanup,
            ],
        ),

        // ═══════════════════════════════════════
        // 失败与重试
        // ═══════════════════════════════════════

        // ── Verify失败 → 回到Implementing（最多3次）──
        (Verifying, ShellFailed { stderr, .. }) if state.verify_retries < 3 => (
            state.clone()
                .with_phase(Implementing)
                .inc_verify_retries()
                .with_error_context(stderr.clone()),
            vec![
                Notify { message: format!(
                    "🔄 Build failed (attempt {}/3), fixing...",
                    state.verify_retries + 1
                )},
                SaveState,
                RunSkill {
                    name: "implement".into(),
                    context: format!(
                        "FIX BUILD/TEST ERROR:\n{}\n\nOriginal task: {}",
                        stderr, state.task
                    ),
                },
            ],
        ),

        // ── Verify重试超限 → Escalate ──
        (Verifying, ShellFailed { stderr, .. }) => (
            state.clone()
                .with_phase(Escalated)
                .with_failed_phase(Verifying)
                .with_error_context(stderr.clone()),
            vec![
                Notify { message: format!(
                    "❌ Build failed after 3 attempts.\nLast error: {}",
                    truncate(&stderr, 200)
                )},
                SaveState,
            ],
        ),

        // ── Verify非零退出码（executor发ShellCompleted但exit_code!=0）──
        // Executor约定：exit_code!=0 统一发 ShellFailed。
        // 这条分支是防御性兜底，也检查retries。
        (Verifying, ShellCompleted { exit_code, stdout }) if exit_code != 0 && state.verify_retries < 3 => (
            state.clone()
                .with_phase(Implementing)
                .inc_verify_retries()
                .with_error_context(stdout.clone()),
            vec![
                Notify { message: format!("🔄 Tests returned exit code {} (attempt {}/3), fixing...", exit_code, state.verify_retries + 1) },
                SaveState,
                RunSkill {
                    name: "implement".into(),
                    context: format!(
                        "FIX: verify exited with code {}\nOutput:\n{}\n\nOriginal task: {}",
                        exit_code, stdout, state.task
                    ),
                },
            ],
        ),

        // ── 防御性兜底 + retries超限 → Escalate ──
        (Verifying, ShellCompleted { exit_code, stdout }) if exit_code != 0 => (
            state.clone()
                .with_phase(Escalated)
                .with_failed_phase(Verifying)
                .with_error_context(stdout.clone()),
            vec![
                Notify { message: format!("❌ Verify failed (exit {}) after 3 attempts.", exit_code) },
                SaveState,
            ],
        ),

        // ── Design失败 → 重试1次，超了escalate ──
        (Designing, SkillFailed { error, .. }) if state.retries_for("designing") < 1 => (
            state.clone().with_phase(Designing).inc_phase_retry("designing"),
            vec![
                Notify { message: format!("🔄 Design failed, retrying... ({})", truncate(&error, 100)) },
                SaveState,
                RunSkill {
                    name: if state.project.as_ref().map_or(false, |p| p.has_design) {
                        "update-design"
                    } else {
                        "draft-design"
                    }.into(),
                    context: format!("RETRY — previous error: {}\n\nOriginal task: {}", error, state.task),
                },
            ],
        ),

        // ── Graphing失败 → 重试1次 ──
        (Graphing, SkillFailed { error, .. }) if state.retries_for("graphing") < 1 => (
            state.clone().with_phase(Graphing).inc_phase_retry("graphing"),
            vec![
                Notify { message: format!("🔄 Graph generation failed, retrying... ({})", truncate(&error, 100)) },
                SaveState,
                RunSkill {
                    name: if state.project.as_ref().map_or(false, |p| p.has_graph) {
                        "update-graph"
                    } else {
                        "generate-graph"
                    }.into(),
                    context: format!("RETRY — previous error: {}\n\nOriginal task: {}", error, state.task),
                },
            ],
        ),

        // ── Implementing失败 → 重试1次 ──
        (Implementing, SkillFailed { error, .. }) if state.retries_for("implementing") < 1 => (
            state.clone().with_phase(Implementing).inc_phase_retry("implementing"),
            vec![
                Notify { message: format!("🔄 Implementation failed, retrying... ({})", truncate(&error, 100)) },
                SaveState,
                RunSkill {
                    name: "implement".into(),
                    context: format!("RETRY — previous error: {}\n\nOriginal task: {}", error, state.task),
                },
            ],
        ),

        // ── 任意phase的Skill失败（重试用完后 → Escalate）──
        (phase, SkillFailed { error, .. }) => (
            state.clone()
                .with_phase(Escalated)
                .with_failed_phase(phase.clone())
                .with_error_context(error.clone()),
            vec![
                Notify { message: format!(
                    "❌ {} failed: {}",
                    phase.display_name(),
                    truncate(&error, 200)
                )},
                SaveState,
            ],
        ),

        // ═══════════════════════════════════════
        // 用户交互
        // ═══════════════════════════════════════

        // ── 用户取消（任何状态）──
        (_, UserCancel) => (
            state.clone().with_phase(Cancelled),
            vec![
                Notify { message: "🛑 Ritual cancelled.".into() },
                SaveState,
            ],
        ),

        // ── 用户重试（从Escalated，回到失败的phase）──
        (Escalated, UserRetry) => {
            let retry_phase = state.failed_phase.clone().unwrap_or(Implementing);
            let context = format!(
                "RETRY after escalation.\nPrevious error: {}\n\nOriginal task: {}",
                state.error_context.as_deref().unwrap_or("unknown"),
                state.task
            );
            let action = match &retry_phase {
                Designing => RunSkill {
                    name: if state.project.as_ref().map_or(false, |p| p.has_design) {
                        "update-design"
                    } else {
                        "draft-design"
                    }.into(),
                    context,
                },
                Planning => RunPlanning,
                Graphing => RunSkill {
                    name: if state.project.as_ref().map_or(false, |p| p.has_graph) {
                        "update-graph"
                    } else {
                        "generate-graph"
                    }.into(),
                    context,
                },
                Implementing => RunSkill {
                    name: "implement".into(),
                    context,
                },
                Verifying => RunShell {
                    command: state.verify_command().to_string(),
                },
                _ => RunSkill {
                    name: "implement".into(),
                    context,
                },
            };
            (
                state.clone().with_phase(retry_phase),
                vec![
                    Notify { message: "🔄 Retrying...".into() },
                    SaveState,
                    action,
                ],
            )
        },

        // ── 用户跳过当前phase → 自动进入下一个phase ──
        // 每个skip target都有明确的action，不靠catch-all。
        (phase, UserSkipPhase) => {
            match phase.next() {
                Some(next_phase) => {
                    let action = match &next_phase {
                        // skip到Designing：需要先检测项目再design。
                        // 进入Initializing而不是Designing，让正常flow处理。
                        Designing => {
                            return (
                                state.clone().with_phase(Initializing),
                                vec![
                                    Notify { message: format!("⏭️ Skipped {}. Detecting project...", phase.display_name()) },
                                    SaveState,
                                    DetectProject,
                                ],
                            );
                        },
                        Planning => RunPlanning,
                        Graphing => {
                            let skill = if state.project.as_ref().map_or(false, |p| p.has_graph) {
                                "update-graph"
                            } else {
                                "generate-graph"
                            };
                            RunSkill { name: skill.into(), context: state.task.clone() }
                        },
                        Implementing => {
                            match &state.strategy {
                                Some(ImplementStrategy::MultiAgent { tasks }) =>
                                    RunHarness { tasks: tasks.clone() },
                                _ =>
                                    RunSkill { name: "implement".into(), context: state.task.clone() },
                            }
                        },
                        Verifying => RunShell { command: state.verify_command().to_string() },
                        Done => {
                            return (
                                state.clone().with_phase(Done),
                                vec![
                                    Notify { message: format!("⏭️ Skipped {}. Ritual complete.", phase.display_name()) },
                                    SaveState,
                                ],
                            );
                        },
                        _ => {
                            return (
                                state.clone()
                                    .with_phase(Escalated)
                                    .with_failed_phase(phase.clone()),
                                vec![
                                    Notify { message: format!("❌ Cannot skip to {:?}.", next_phase) },
                                    SaveState,
                                ],
                            );
                        },
                    };
                    (
                        state.clone().with_phase(next_phase.clone()),
                        vec![
                            Notify { message: format!("⏭️ Skipped {}. Moving to {}...", phase.display_name(), next_phase.display_name()) },
                            SaveState,
                            action,
                        ],
                    )
                },
                None => (
                    state.clone()
                        .with_phase(Escalated)
                        .with_failed_phase(phase.clone()),
                    vec![
                        Notify { message: format!("❌ Cannot skip {} — no next phase.", phase.display_name()) },
                        SaveState,
                    ],
                ),
            }
        },

        // ═══════════════════════════════════════
        // 兜底
        // ═══════════════════════════════════════

        // ── 未预期的(state, event)组合 → Escalated ──
        // Invariant: 每个transition要么终态，要么1个EP action。不做silent no-op。
        (phase, event) => (
            state.clone()
                .with_phase(Escalated)
                .with_failed_phase(phase.clone())
                .with_error_context(format!(
                    "Unexpected event {:?} in phase {}",
                    std::mem::discriminant(&event),
                    phase.display_name()
                )),
            vec![
                Notify { message: format!(
                    "❌ Unexpected event in {}. Ritual paused — use /ritual retry or /ritual cancel.",
                    phase.display_name()
                )},
                SaveState,
            ],
        ),
    }
}

/// 截断字符串（UTF-8安全）
fn truncate(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}
```

### 执行循环
```rust
/// 主循环：纯函数 transition + 有副作用的 executor。
/// 每轮：transition算出(new_state, actions) → executor执行actions → 得到下一个event。
async fn run_ritual(initial_event: RitualEvent, executor: &ActionExecutor) -> Result<RitualState> {
    let mut state = RitualState::new();
    let mut event = initial_event;

    loop {
        // 1. 纯函数：算出下一步
        let (new_state, actions) = transition(&state, event);
        state = new_state;

        // 2. 终态检查
        if matches!(state.phase, RitualPhase::Done | RitualPhase::Cancelled | RitualPhase::Escalated) {
            // 执行剩余的fire-and-forget actions（Notify, SaveState等）
            executor.execute_fire_and_forget(&actions).await;
            break;
        }

        // 3. 执行actions
        //    - fire-and-forget先执行（Notify, SaveState, Cleanup, UpdateGraph）
        //    - event-producing action最后执行，返回下一个event
        //    - executor error → 转成SkillFailed event，让状态机决定下一步
        event = match executor.execute_actions(&actions).await {
            Ok(evt) => evt,
            Err(e) => {
                tracing::error!("Executor error: {}", e);
                RitualEvent::SkillFailed {
                    phase: state.phase.display_name().to_string(),
                    error: format!("Executor error: {}", e),
                }
            }
        };
    }

    Ok(state)
}
```

### Executor行为约定

```rust
impl ActionExecutor {
    /// 执行所有actions。
    /// 1. 先执行所有fire-and-forget（Notify, SaveState, Cleanup, UpdateGraph）
    /// 2. 找到唯一的event-producing action执行，返回Event
    /// 3. 如果没有event-producing action → panic（transition逻辑错误）
    /// 4. 如果有多个event-producing action → panic（transition逻辑错误）
    async fn execute_actions(&self, actions: &[RitualAction]) -> Result<RitualEvent> {
        let (ff, ep): (Vec<_>, Vec<_>) = actions.iter().partition(|a| a.is_fire_and_forget());
        
        // Fire-and-forget: 并行执行，errors只log不fail
        for action in &ff {
            if let Err(e) = self.execute_one(action).await {
                tracing::warn!("Fire-and-forget action failed (continuing): {}", e);
            }
        }
        
        // Event-producing: 必须恰好1个
        assert_eq!(ep.len(), 1, "transition must produce exactly 1 event-producing action, got {}", ep.len());
        
        self.execute_event_producing(&ep[0]).await
    }

    async fn execute_fire_and_forget(&self, actions: &[RitualAction]) {
        for action in actions.iter().filter(|a| a.is_fire_and_forget()) {
            let _ = self.execute_one(action).await;
        }
    }

    /// ShellCompleted vs ShellFailed 约定：
    /// exit_code == 0 → ShellCompleted
    /// exit_code != 0 → ShellFailed { stderr: combined_output, exit_code }
    async fn execute_shell(&self, command: &str) -> Result<RitualEvent> {
        let output = Command::new("sh").arg("-c").arg(command).output().await?;
        let combined = String::from_utf8_lossy(&output.stdout).to_string()
            + &String::from_utf8_lossy(&output.stderr);
        
        if output.status.success() {
            Ok(RitualEvent::ShellCompleted { stdout: combined, exit_code: 0 })
        } else {
            Ok(RitualEvent::ShellFailed {
                stderr: combined,
                exit_code: output.status.code().unwrap_or(-1),
            })
        }
    }

    /// UpdateGraph: executor自行查graph找与task描述相关的node
    async fn execute_update_graph(&self, description: &str) -> Result<()> {
        // 1. 搜索graph中匹配description的task node
        // 2. 更新状态为done
        // 3. 如果找不到匹配的node，只log warning不fail
        Ok(())
    }
}
```

## 3. Composer v2（组装层 — 代码+LLM混合）

### 代码检测（零成本）
```rust
pub struct ProjectState {
    pub has_design: bool,
    pub has_graph: bool,
    pub has_source: bool,
    pub has_tests: bool,
    pub language: Option<ProjectLanguage>,
    pub source_file_count: usize,
    pub verify_command: Option<String>,  // 从.gid/config.yml读取
}
```
这部分已实现（`composer.rs`）。现在由 `DetectProject` action触发，executor调 `detect_project_state()` 并读 `.gid/config.yml` 返回 `ProjectDetected` event。

### LLM判断（Planning phase）
`RunPlanning` action触发executor：
1. 读 `DESIGN.md`
2. 构造prompt发给LLM
3. 解析JSON返回 `PlanDecided(strategy)`

```
System: 你是项目规划师。根据以下DESIGN.md内容判断：
1. 这个feature的工作量（小/中/大）
2. 需要改几个文件？
3. 建议用单LLM session还是多agent并行？

输出JSON: {"strategy": "single_llm"} 或 {"strategy": "multi_agent", "tasks": ["task1", "task2"]}

{design_content}
```

这个LLM调用只在ritual内部发生一次，成本可控。

## 4. 上下文注入

### 实现
Context字符串直接来自transition函数产出的 `RunSkill.context`。Transition负责组装context（包含task + error信息），executor只做拼接：

```rust
async fn execute_skill(&self, name: &str, context: &str) -> Result<RitualEvent> {
    let base_prompt = self.load_skill_prompt(name)?;
    
    // context由transition组装好了，包含task和可能的error信息
    let full_prompt = format!(
        "## USER TASK\n{}\n\n## INSTRUCTIONS\n{}",
        context,
        base_prompt
    );
    
    match self.llm_client.run_skill(&full_prompt, tools, model, working_dir).await {
        Ok(result) => Ok(RitualEvent::SkillCompleted {
            phase: name.to_string(),
            artifacts: result.artifacts_created,
        }),
        Err(e) => Ok(RitualEvent::SkillFailed {
            phase: name.to_string(),
            error: e.to_string(),
        }),
    }
}
```

## 5. ToolScope对齐

### 问题
Composer生成的phase ID（`update-design`, `implement`）和 `default_scope_for_phase()` 匹配不上。

### 解决
用 `RitualPhase` enum直接映射scope，不依赖phase ID字符串：

```rust
pub enum ScopeCategory {
    Design,      // Read + Write（文档）
    Plan,        // Read only
    Implement,   // Read + Write + Edit + Bash
    Verify,      // Bash only（测试/构建）
}

impl RitualPhase {
    pub fn scope_category(&self) -> Option<ScopeCategory> {
        match self {
            Self::Designing => Some(ScopeCategory::Design),
            Self::Planning => Some(ScopeCategory::Plan),
            Self::Graphing => Some(ScopeCategory::Design),  // graph也是文档写入
            Self::Implementing => Some(ScopeCategory::Implement),
            Self::Verifying => Some(ScopeCategory::Verify),
            _ => None,
        }
    }
}
```

直接从状态机的phase映射，不需要string matching，不需要 `scope_hint` 字段。零歧义。

## 6. 通知

### 实现
`Notify` action由executor通过已有的 `RitualNotifier` trait发送。Fire-and-forget — 发送失败只log，不影响ritual流程。

### 格式
```
🔧 Ritual started: "加/tools命令"
📝 Phase 1/4: draft-design... ✅ (12s)
🧠 Planning implementation strategy... ✅ (5s) → SingleLlm
📊 Phase 2/4: generate-graph... ✅ (8s)
💻 Phase 3/4: Implementing... ❌ build failed
🔄 Build failed (attempt 1/3), fixing...
💻 Phase 3/4: Implementing... ✅ (45s)
✅ Phase 4/4: Verifying... ✅ cargo test passed
🎉 Ritual complete!
```

Timing由executor在action执行前后记录，不在状态机里。

## 7. RustClaw中的 `/ritual` 命令（可选快捷方式）

虽然tool gating自动触发，但保留 `/ritual` 作为显式入口：
```
/ritual 加一个 /tools 命令    → 直接启动ritual（Start event）
/ritual status                → 查看当前phase + transitions历史
/ritual cancel                → UserCancel event
/ritual retry                 → UserRetry event（从Escalated恢复）
/ritual skip                  → UserSkipPhase event
```

## 实现优先级

| # | 改动 | 位置 | 代码量 | 价值 |
|---|---|---|---|---|
| 1 | 上下文注入 | gid-core executor.rs | ~10行 | 🔴 没这个skill不知道做什么 |
| 2 | Tool gating（配置化） | rustclaw agent.rs + .gid/config.yml | ~100行 | 🔴 代码强制进入ritual |
| 3 | 纯函数状态机 | gid-core engine.rs (替换while loop) | ~450行 | 🔴 正确的控制流 + retry + escalate |
| 4 | Planning phase | gid-core executor (RunPlanning) | ~60行 | 🟡 LLM判断工作量 |
| 5 | 通知集成 | executor → RitualNotifier | ~30行 | 🟡 用户体验 |
| 6 | ToolScope对齐 | RitualPhase.scope_category() | ~20行 | 🟢 安全性 |
| 7 | Transition history | RitualState.transitions | 已含在#3 | 🟢 可调试性 |

## 不做的事

- ~~通用FSM框架~~ — `match` 就够，不需要状态机库
- ~~Event sourcing~~ — 过度设计，`ritual-state.json` 够用
- ~~多ritual并行~~ — RustClaw一次做一个任务
- ~~Pre/Post approval分离~~ — 当前auto模式为主，需要再加
- ~~Async event channel~~ — 不需要mpsc，同步循环就行

## 与现有代码的关系

### 替换
- `engine.rs` 的 `while current_phase < phases.len()` 循环 → 纯函数transition + executor循环
- `RitualStatus` enum → `RitualPhase` enum（更多状态，更精确的语义）
- `compose_ritual()` → `detect_project_state()`（不再生成phase列表，状态机自己决定flow）

### 保留
- `executor.rs` 的 `SkillExecutor`, `ShellExecutor`, `HarnessExecutor` — 包装进 `ActionExecutor`
- `scope.rs` 的 `ToolScope` — 改为从 `RitualPhase.scope_category()` 驱动
- `notifier.rs` 的 `RitualNotifier` trait — executor的fire-and-forget调用
- `template.rs` — 保留作为预定义ritual的快捷方式（不强制使用）
- `api_llm_client.rs` — Planning phase的LLM调用可用
- `llm.rs` 的 `LlmClient` trait — skill execution不变
