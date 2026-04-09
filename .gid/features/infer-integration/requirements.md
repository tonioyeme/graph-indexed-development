# Requirements: `infer-integration` — Graph Output, CLI & API

## Overview

将 clustering + labeling 的推断结果写入图存储、提供 CLI 命令和 Rust library API。这是 infer 管线的输出层和用户接口。

Master doc: [requirements-master.md](../infer/requirements-master.md)

## Goals

### 3. 图生成与合并

#### GOAL-3.1 [P0]: 写入图存储

推断结果追加到现有图中（不覆盖已有 project layer 节点），支持 YAML（graph.yml）和 SQLite 两种后端。新增节点 `source: infer`。

**验证**: 对已有 5 个手动 task 节点的图跑 infer，task 节点不丢失；YAML 和 SQLite 产出一致。

#### GOAL-3.2 [P0]: 跨层边

feature → component（`contains`）、component → code（`contains`）、feature → feature（`depends_on`）。所有自动生成的边标记 `source: infer`。

**验证**: 从 feature 节点出发能通过边遍历到代码节点。

#### GOAL-3.3 [P1]: 增量 infer

重新跑 infer 时先清除旧的推断节点/边（`source: infer`），再写入新结果。手动创建的节点不受影响。

**验证**: 跑两次 infer，无重复推断节点。

#### GOAL-3.4 [P1]: 人工覆盖优先

如果用户手动创建了 component/feature 节点（`source != infer`），infer 不覆盖它们。

**验证**: 手动创建 feature 节点后跑 infer，该节点 title/description 不变。

#### GOAL-3.5 [P2]: Dry-run 模式

`gid infer --dry-run` 输出推断结果的预览（YAML 格式），不写入。

### 4. CLI 集成

#### GOAL-4.1 [P0]: `gid infer` 命令

在当前项目目录运行，自动加载代码层，执行 Infomap + LLM 管线，写回 graph。输出摘要：N components, M features generated。

#### GOAL-4.2 [P1]: `--model <model>`

指定 LLM 模型（默认 claude-sonnet-4-20250514）。支持 Anthropic 和 OpenAI。

#### GOAL-4.3 [P1]: `--level component|feature|all`

控制推断深度。`component` 只跑聚类，`feature` 在 component 基础上跑 LLM，`all`（默认）两者都跑。`--level feature` 时如果 component 层缺失，自动先跑 component。

#### GOAL-4.4 [P2]: `gid extract --infer`

Extract 完成后自动运行 infer。一条命令从源码到完整三层图。

### 5. Library API + 输出

#### GOAL-5.1 [P0]: Rust API

`gid_core::infer::run(graph: &Graph, config: &InferConfig, llm: Option<&dyn LlmClient>) -> Result<InferResult>`

GidHub 直接调用此 API，不经过 CLI。可在无 `.gid/` 目录环境下调用。

#### GOAL-5.2 [P0]: SQLite 输出

infer 结果可通过 SqliteStorage 写入 `.db` 文件。GidHub pipeline: `extract → infer → .db`，全程 SQLite。

#### GOAL-5.3 [P0]: 输出 Schema 稳定

推断节点 schema：
- component: `node_type: component`, `source: infer`, metadata 含 `title`/`description`
- feature: `node_type: feature`, `source: infer`, metadata 含 `title`/`description`/`components`

Schema 定义在代码常量/类型中。

#### GOAL-5.4 [P1]: Batch/headless 模式

从环境变量读 LLM key，不依赖 `.gid/config.yml`。单 repo 失败不影响 batch 其他 repo。支持 `--format json` 输出。

#### GOAL-5.5 [P1]: 自动 extract 触发

调用 infer 时如果图中没有代码层节点，自动先运行 extract（如果提供了源码路径）。

**验证**: 对新 clone 的 repo 直接 `gid infer`，自动完成 extract + infer。

---

## Guards (from master)

- GUARD-1 [hard]: 不得删除或修改代码层节点
- GUARD-2 [hard]: 不得删除或修改 `source != infer` 的 project/feature 层节点
- GUARD-3 [soft]: LLM 失败 → 降级
- GUARD-4 [soft]: Token 上限 50k

## Dependencies

- **infer-clustering** — component 层输出
- **infer-labeling** — feature 层输出
- **SqliteStorage** — GOAL-5.2
- **LlmClient trait** — GOAL-5.1
