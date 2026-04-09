# Requirements: `infer-clustering` — Infomap Code→Component Mapping

## Overview

从代码层（`gid extract` 产出的 files, classes, functions, edges）通过 Infomap 社区检测算法自动推断 component 层。纯算法，不需要 LLM。

Master doc: [requirements-master.md](../infer/requirements-master.md)

## Goals

### GOAL-1.1 [P0]: 构建 Infomap 网络

从代码层构建 Infomap 网络 — 代码节点为 network node，代码边（calls, imports, type_reference, defined_in）为 network edge，边权重按关系类型分 4 档：

| Relation | Weight | Rationale |
|----------|--------|-----------|
| calls | 1.0 | 最强功能耦合 |
| imports | 0.8 | 直接依赖 |
| type_reference / inherits / implements | 0.5 | 类型级耦合 |
| structural (defined_in / contains / belongs_to) | 0.2 | 结构包含关系 |

**验证**: 对含 50+ 文件的项目，网络构建无 panic，输出非空社区。

### GOAL-1.2 [P0]: 社区→Component 节点映射

Infomap 聚类结果映射为 component 节点 — 每个社区生成一个 `node_type: component` 节点，社区内的代码节点通过 `belongs_to` 边连接到 component。

**验证**: 每个代码节点恰好属于一个 component，无孤立代码节点（除非原图中就是孤立的）。

### GOAL-1.3 [P1]: 层级聚类

Infomap 输出的层级结构（sub-communities）映射为嵌套 component。顶层社区 = 大组件，子社区 = 子组件，通过 `contains` 边连接。

**验证**: 对大项目（200+ 文件），生成至少 2 级层级。

### GOAL-1.4 [P1]: 聚类参数可配

Infomap 的 teleportation rate、num_trials、min_community_size 通过 CLI 参数或 `.gid/config.yml` 配置。默认值对 typical 代码仓库（50-500 文件）产生合理结果（3-15 个顶层社区）。

### GOAL-1.5 [P2]: 聚类质量指标

输出 modularity score 和 codelength，让用户判断聚类质量。

**验证**: 指标包含在 `gid infer` 的输出摘要中。

---

## Guards (from master)

- GUARD-1 [hard]: 不得修改代码层节点
- GUARD-3 [soft]: LLM 失败时降级（本 feature 无 LLM，但此原则适用于整体管线）

## Dependencies

- **infomap-rs** v0.1.0 — 已发布
- **advise.rs** `detect_code_modules()` — 已有基础 Infomap 集成可复用
- **unified-graph** — 代码层节点/边已在 graph 中
