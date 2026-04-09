# Requirements: `infer-labeling` — LLM Semantic Labeling

## Overview

在 Infomap 聚类产出 component 层之后，用 LLM 对 component 命名、推断 feature 层、推断 feature 间依赖。这是 infer 管线中唯一需要 LLM 的部分。

Master doc: [requirements-master.md](../infer/requirements-master.md)

## Goals

### GOAL-2.1 [P0]: Component 命名

每个 component 节点由 LLM 命名 — 输入为社区内文件名、类名、函数签名、README 相关段落。LLM 输出：component title（简短描述性名称，如 "Authentication & Authorization"）和 description（1-2 句话）。

**验证**: 所有 component 有非空 title，title 不含泛化词如 "Component 1"。

### GOAL-2.2 [P0]: Feature 推断

LLM 从 component 聚类推断 feature 节点 — 将多个相关 component 归纳为业务 feature。输入：全部 component 列表 + 各自内容摘要 + README。输出：feature 节点列表，每个 feature 包含 title、description、关联的 component IDs。

**关系**: Feature→Component 是 N:M（一个 feature 可包含多个 component，一个 component 可属于多个 feature），但 typical case 是 1:N。

**验证**: feature 数量在合理范围（3-10 个），每个 component 至少属于一个 feature。

### GOAL-2.3 [P1]: Feature 依赖推断

基于 component 间的跨社区边（calls/imports 跨社区），推断 feature 级别的 `depends_on` 边。

**验证**: 跨社区 import 边存在的 feature 对之间有 `depends_on` 边。

### GOAL-2.4 [P1]: README/文档辅助

如果项目有 README.md、ARCHITECTURE.md 或类似文档，提取其中的结构描述作为 LLM 额外上下文，提升命名和分类质量。README 是增强，不是前提。

**验证**: 有 README 和没有 README 的项目都能产出结果。

### GOAL-2.5 [P2]: 无 LLM 模式

`gid infer --no-llm` 只跑 Infomap 聚类，component 用目录名/文件前缀自动命名，不生成 feature 层。

**验证**: `--no-llm` 输出 code + component 两层图，无 API 调用。

---

## Guards (from master)

- GUARD-3 [soft]: LLM 调用失败 → 降级到 `--no-llm` 行为，聚类结果仍写入
- GUARD-4 [soft]: 单次 infer LLM token 消耗上限 50k tokens，超过则警告并截断输入

## Dependencies

- **infer-clustering** — 本 feature 的输入是 clustering 的输出（component 节点 + 成员关系）
- **LlmClient trait** — gid-core `llm_client.rs`
