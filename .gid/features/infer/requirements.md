# Requirements: `gid infer` — Auto-Generate Project & Feature Layers from Code

## Overview

`gid extract` 产生代码层（files, classes, functions, edges）。但一个完整的项目图需要三层：

- **Code layer** — 已有，`gid extract` 产出
- **Component/Project layer** — 模块、组件、子系统（目录聚类 + 依赖聚类）
- **Feature layer** — 业务特性、功能域（需要语义理解）

目前从 code layer 到 project/feature layer 全靠人工（手写 graph.yml 或跑 `gid design`）。`gid infer` 解决这个问题：从代码层自动推断上层结构，输出完整的三层图。

**核心管线**: `gid extract` → Infomap 社区检测 → LLM 语义标注 → 三层图

**用户**: GidHub（批量处理开源仓库）和本地开发者（理解新项目）。

## Priority Levels

- **P0**: Core — `gid infer` 基本能力，没有这个 GidHub 无法运转
- **P1**: Important — 质量提升和可控性
- **P2**: Enhancement — 优化和可观测性

## Guard Severity

- **hard**: Violation = 图损坏或数据丢失
- **soft**: Violation = 推断质量差但不破坏

---

## Goals

### 1. Infomap 聚类 (clustering)

- **GOAL-1.1** [P0]: 从代码层构建 Infomap 网络 — 代码节点为 network node，代码边（calls, imports, type_reference, defined_in）为 network edge，边权重按关系类型分 4 档：calls = 1.0, imports = 0.8, type_reference/inherits/implements = 0.5, structural (defined_in/contains/belongs_to) = 0.2。验证：对含 50+ 文件的项目，网络构建无 panic，输出非空社区。

- **GOAL-1.2** [P0]: Infomap 聚类结果映射为 component 节点 — 每个社区生成一个 `type: component` 节点，社区内的代码节点通过 `belongs_to` 边连接到 component。验证：每个代码节点恰好属于一个 component，无孤立代码节点（除非原图中就是孤立的）。

- **GOAL-1.3** [P1]: 支持层级聚类 — Infomap 输出的层级结构（sub-communities）映射为嵌套 component。顶层社区 = 大组件，子社区 = 子组件，通过 `contains` 边连接。验证：对大项目（200+ 文件），生成至少 2 级层级。

- **GOAL-1.4** [P1]: 聚类参数可配 — Infomap 的 teleportation rate、num_trials、min_community_size 通过 CLI 参数或 `.gid/config.yml` 配置。默认值对 typical 代码仓库（50-500 文件）产生合理结果（3-15 个顶层社区）。

- **GOAL-1.5** [P2]: 聚类质量指标 — 输出 modularity score 和 codelength，让用户判断聚类质量。验证：指标包含在 `gid infer` 的输出摘要中。

### 2. LLM 语义标注 (semantic-labeling)

- **GOAL-2.1** [P0]: 每个 component 节点由 LLM 命名 — 输入为社区内文件名、类名、函数签名、README 相关段落。LLM 输出：component title（简短描述性名称，如 "Authentication & Authorization"）和 description（1-2 句话）。验证：所有 component 有非空 title，title 不含泛化词如 "Component 1"。

- **GOAL-2.2** [P0]: LLM 从 component 聚类推断 feature 节点 — 将多个相关 component 归纳为业务 feature。输入：全部 component 列表 + 各自内容摘要 + README。输出：feature 节点列表，每个 feature 包含 title、description、关联的 component IDs。验证：feature 数量在合理范围内（通常 3-10 个），每个 component 至少属于一个 feature，一个 feature 可跨多个 component。一个 component 也可属于多个 feature（多对多关系），但 typical case 是一对多（一个 feature 包含多个 component）。

- **GOAL-2.3** [P1]: LLM 推断 feature 间的依赖关系 — 基于 component 间的跨社区边（calls/imports 跨社区），推断 feature 级别的 `depends_on` 边。验证：跨社区 import 边存在的 feature 对之间有 `depends_on` 边。

- **GOAL-2.4** [P1]: README/文档辅助推断 — 如果项目有 README.md、ARCHITECTURE.md 或类似文档，提取其中的结构描述作为 LLM 的额外上下文，提升命名和分类质量。验证：有 README 的项目 vs 没有 README 的项目，LLM 都能输出结果（README 是增强，不是前提）。

- **GOAL-2.5** [P2]: 支持无 LLM 模式 — `gid infer --no-llm` 只跑 Infomap 聚类，component 用目录名/文件前缀自动命名，不生成 feature 层。用于离线或低成本场景。验证：`--no-llm` 模式输出 code + component 两层图，无 API 调用。

### 3. 图生成与合并 (graph-output)

- **GOAL-3.1** [P0]: 推断结果写入图存储 — component 和 feature 节点追加到现有图中（不覆盖已有的 project layer 节点），支持 YAML（graph.yml）和 SQLite（SqliteStorage）两种后端。新增节点的 `source` 字段标记为 `infer` 以区分人工创建的节点。验证：对已有 5 个手动 task 节点的图跑 infer，task 节点不丢失；YAML 和 SQLite 产出的节点/边一致。

- **GOAL-3.2** [P0]: 生成完整的跨层边 — feature → component（`contains`）、component → code（`contains`）、feature → feature（`depends_on`）。所有自动生成的边标记 `source: infer`。验证：从 feature 节点出发能通过边遍历到代码节点。

- **GOAL-3.3** [P1]: 增量 infer — 如果 graph.yml 中已有 `source: infer` 的节点，重新跑 infer 时先清除旧的推断节点/边，再写入新结果。手动创建的节点不受影响。验证：跑两次 infer，图中不出现重复的推断节点。

- **GOAL-3.4** [P1]: 人工覆盖优先 — 如果用户手动创建了 component/feature 节点（`source` 不是 `infer`），infer 不覆盖它们。用户的手动标注是 ground truth。验证：手动创建一个 feature 节点，跑 infer，该节点 title/description 不变。

- **GOAL-3.5** [P2]: Dry-run 模式 — `gid infer --dry-run` 输出推断结果的预览（YAML 格式），不写入 graph.yml。用于审查。

### 4. CLI 集成 (cli)

- **GOAL-4.1** [P0]: `gid infer` 命令 — 在当前项目目录运行，自动加载 graph.yml 中的代码层，执行 Infomap + LLM 管线，写回 graph.yml。输出摘要：N components, M features generated。

- **GOAL-4.2** [P1]: `gid infer --model <model>` — 指定 LLM 模型（默认 claude-sonnet-4-20250514）。支持 Anthropic 和 OpenAI provider。

- **GOAL-4.3** [P1]: `gid infer --level component|feature|all` — 控制推断深度。`component` 只跑 Infomap 聚类，`feature` 在 component 基础上跑 LLM feature 推断，`all`（默认）两者都跑。

- **GOAL-4.4** [P2]: `gid extract --infer` — 在 extract 完成后自动运行 infer。一条命令从源码到完整三层图。

### 5. Library API + 输出 (api-output)

- **GOAL-5.1** [P0]: Rust crate-level API — `gid_core::infer::run(graph: &Graph, config: &InferConfig, llm: Option<&dyn LlmClient>) -> Result<InferResult>`。GidHub 服务端直接调用此 API，不经过 CLI。验证：API 可在无 `.gid/` 目录、无 CLI 的环境下调用。

- **GOAL-5.2** [P0]: SQLite 输出支持 — infer 结果可通过 `SqliteStorage` 写入 `.db` 文件（不仅限于 graph.yml）。GidHub pipeline 是 `extract → infer → .db`，全程 SQLite。验证：对一个 repo 跑 infer 后，`.db` 文件包含 component/feature 节点和跨层边。

- **GOAL-5.3** [P0]: 输出 Schema 稳定 — 推断出的节点有明确、稳定的 schema：component 节点 `node_type: component`，`source: infer`，必须含 `title`/`description` metadata；feature 节点 `node_type: feature`，`source: infer`，必须含 `title`/`description`/`components`（关联的 component ID 列表） metadata。验证：schema 定义在代码中的常量/类型，GidHub overview API 可直接消费。

- **GOAL-5.4** [P1]: Batch/headless 模式 — 支持从环境变量（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`）读取 LLM key，不依赖 `.gid/config.yml`。错误隔离：单个 repo 的 infer 失败不影响 batch 中的其他 repo。输出支持 JSON 摘要格式（`--format json`）。验证：在无 `.gid/` 目录的 CI/server 环境中，通过 API 调用 infer 成功。

- **GOAL-5.5** [P1]: 自动 extract 触发 — 如果调用 infer 时图中没有代码层节点（code layer 为空），自动先运行 extract（如果提供了源码路径），再运行 infer。不需要用户手动分两步。验证：对一个新 clone 的 repo 目录直接调用 `gid infer`，自动完成 extract + infer。

---

## Guards

- **GUARD-1** [hard]: Infer 不得删除或修改代码层节点（`type: code` 或 `node_type: code`）。代码层是 extract 的产物，infer 只读取、不写入代码层。

- **GUARD-2** [hard]: Infer 不得删除或修改 `source` 不为 `infer` 的 project/feature 层节点。用户手动创建的节点是不可覆盖的。

- **GUARD-3** [soft]: LLM 调用失败不应导致整个 infer 失败 — 聚类结果仍应写入图中，只是缺少语义标注。降级到 `--no-llm` 行为。

- **GUARD-4** [soft]: 单次 infer 的 LLM token 消耗应有上限（默认 50k tokens）。超过时警告并截断输入，而不是无限消费。

---

## Out of Scope

- **代码层 extract** — 已有 `gid extract`，本 feature 不重复
- **Task/TODO 推断** — 从代码注释中提取 TODO/FIXME 生成 task 节点（未来 feature）
- **跨仓库推断** — 多个 repo 的关系推断（GidHub Phase 4）
- **实时同步** — `gid watch` + 自动 re-infer（未来集成）

---

## Dependencies

- **infomap-rs** v0.1.0 — 已发布，已集成 gid-rs（feature-gated `infomap`）
- **unified-graph** — GOAL-1.x 依赖代码层已在 graph.yml 中（`gid extract` 已实现）
- **iss-009-cross-layer** — Module nodes + BelongsTo edges 已实现，infer 可利用
- **SqliteStorage** — GOAL-5.2 依赖 gid-core 的 SqliteStorage（T2.5 已实现）
- **LlmClient trait** — GOAL-5.1 API 需要一个 LLM 抽象层，gid-core 已有 `llm_client.rs`

## Existing Assets

- `advise.rs` 中的 `detect_code_modules()` — 已实现 Infomap → component 的基本映射，可复用/扩展
- `infomap-rs` crate — Network 构建、社区检测、层级输出均已实现
- `semantify` — 基于路径的架构层标签（interface/domain/infra），可作为 LLM 的额外信号
