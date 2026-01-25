# Graph-Indexed Development (GID)

**An Open Standard for Structural Semantic Context in AI-Augmented Software Development**

## About

This repository contains the academic paper introducing Graph-Indexed Development (GID), an open methodology that represents software systems as typed, directed graphs to provide structural and semantic context for AI-assisted development.

## Abstract

The rise of AI-powered code generation has exposed a critical gap: large language models can generate syntactically correct code but lack awareness of existing system architecture. GID addresses this by representing software systems as queryable graphs where:

- **Nodes** represent system entities (features, components, interfaces, data models)
- **Edges** encode semantic relationships (implementation, dependency, data flow)

This graph serves as a *Single Source of Truth* that is both human-readable and AI-queryable, enabling:

- Top-down feature decomposition for planning
- Bottom-up impact analysis for safe modifications
- Causal reasoning about software systems for systematic debugging

## Paper

- [`graph-indexed-development.tex`](graph-indexed-development.tex) - LaTeX source

## Author

Toni Tang (tonitang273@gmail.com)

## Related Repositories

- [GID Methodology](https://github.com/tonioyeme/graph-indexed-development-principle) - Specification and guides
- [GID CLI](https://github.com/tonioyeme/graph-indexed-development-cli) - Implementation

## License

This paper is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

For implementation licensing, see the [GID CLI repository](https://github.com/tonioyeme/graph-indexed-development-cli).
