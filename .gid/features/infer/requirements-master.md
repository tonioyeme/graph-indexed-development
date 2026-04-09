# Requirements: `gid infer` — Master

## Overview

`gid extract` 产生代码层（files, classes, functions, edges）。`gid infer` 从代码层自动推断上层结构，输出完整的三层图：

- **Code layer** — 已有，`gid extract` 产出
- **Component layer** — 模块、组件、子系统（Infomap 聚类）
- **Feature layer** — 业务特性、功能域（LLM 语义理解）

**核心管线**: `gid extract` → Infomap 社区检测 → LLM 语义标注 → 三层图

**用户**: GidHub（批量处理开源仓库）和本地开发者（理解新项目）。

## Feature Index

| Feature | GOALs | Focus |
|---------|-------|-------|
| [infer-clustering](../infer-clustering/requirements.md) | GOAL-1.1 ~ 1.5 | Infomap 聚类，纯算法，code→component 映射 |
| [infer-labeling](../infer-labeling/requirements.md) | GOAL-2.1 ~ 2.5 | LLM 语义标注，component 命名 + feature 推断 |
| [infer-integration](../infer-integration/requirements.md) | GOAL-3.1 ~ 5.5 | 图合并、CLI、Library API、输出格式 |

## Priority Levels

- **P0**: Core — `gid infer` 基本能力，没有这个 GidHub 无法运转
- **P1**: Important — 质量提升和可控性
- **P2**: Enhancement — 优化和可观测性

## Guards

- **GUARD-1** [hard]: Infer 不得删除或修改代码层节点（`type: code` 或 `node_type: code`）。代码层是 extract 的产物，infer 只读取、不写入代码层。

- **GUARD-2** [hard]: Infer 不得删除或修改 `source` 不为 `infer` 的 project/feature 层节点。用户手动创建的节点是不可覆盖的。

- **GUARD-3** [soft]: LLM 调用失败不应导致整个 infer 失败 — 聚类结果仍应写入图中，只是缺少语义标注。降级到 `--no-llm` 行为。

- **GUARD-4** [soft]: 单次 infer 的 LLM token 消耗应有上限（默认 50k tokens）。超过时警告并截断输入，而不是无限消费。

## Out of Scope

- 代码层 extract（已有 `gid extract`）
- Task/TODO 推断
- 跨仓库推断（GidHub Phase 4）
- 实时同步（`gid watch` + 自动 re-infer）

## Dependencies

- **infomap-rs** v0.1.0 — 已发布，已集成 gid-rs
- **unified-graph** — 代码层已在 graph.yml 中
- **iss-009-cross-layer** — Module nodes + BelongsTo edges 已实现
- **SqliteStorage** — gid-core T2.5 已实现
- **LlmClient trait** — gid-core `llm_client.rs` 已有
