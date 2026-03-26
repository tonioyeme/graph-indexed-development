# GID Workflows

Common use cases and how to combine GID commands.

---

## 1. New Project Setup

**Scenario:** Starting a new project, want to design architecture before coding.

```bash
# 1. Initialize empty graph
gid init

# 2. Design with AI assistance
gid design --requirements "Build an e-commerce API with..."

# 3. Review and validate
gid check
gid visual

# 4. Start coding with graph as guide
```

**Result:** Architecture map before writing any code.

---

## 2. Document Existing Codebase

**Scenario:** Have existing code, want to understand and document dependencies.

```bash
# 1. Extract dependencies from code
gid extract ./src

# 2. Validate health
gid check

# 3. Visualize
gid visual

# 4. (Optional) Upgrade to semantic graph
# Add Features, assign layers, add implements edges
```

**Result:** Visual map of existing architecture.

---

## 3. Plan New Feature

**Scenario:** Have existing graph, want to plan a new feature.

```bash
# 1. Add planned feature to graph.yml
```
```yaml
nodes:
  NewPaymentFeature:
    type: Feature
    status: planned          # <-- Mark as planned
    description: "Support crypto payments"

  CryptoPaymentService:
    type: Component
    status: planned          # <-- Mark as planned
    layer: application

edges:
  - from: CryptoPaymentService
    to: NewPaymentFeature
    relation: implements
```
```bash
# 2. Visualize - planned nodes show in different color
gid visual

# 3. Check if plan is valid
gid check

# 4. After implementing, change status to active
```

**Result:** See planned vs existing features side by side.

---

## 4. Impact Analysis Before Changes

**Scenario:** Need to modify a component, want to know what's affected.

```bash
# 1. Query impact
gid query impact DatabaseService

# Output:
# Direct dependents: UserService, OrderService, PaymentService
# Affected Features: UserRegistration, OrderPayment

# 2. (Optional) Visualize the impact
gid visual
# Search for DatabaseService, see connections highlighted
```

**Result:** Know exactly what to test before making changes.

---

## 5. Debug Coupled Failures

**Scenario:** Two services fail together, want to find common cause.

```bash
# 1. Find shared dependencies
gid query common-cause OrderService PaymentService

# Output:
# Shared dependencies: DatabaseService, ConfigService

# 2. Find path between them
gid query path OrderService PaymentService
```

**Result:** Identify root cause of coupled failures.

---

## 6. Code Review with Context

**Scenario:** Reviewing a PR, want to understand architectural impact.

```bash
# 1. See what the changed file depends on
gid query deps src/services/user.ts

# 2. See what depends on the changed file
gid query deps src/services/user.ts --reverse

# 3. Check for any new violations
gid check
```

**Result:** Review with full dependency context.

---

## 7. Refactor Planning

**Scenario:** Want to refactor a high-coupling component.

```bash
# 1. Identify high-coupling nodes
gid check
# Shows: "Warning: Parser has 8 dependents (threshold: 5)"

# 2. Visualize to understand connections
gid visual

# 3. Plan the split in graph.yml
# Add new nodes with status: planned
# Update edges

# 4. Validate the plan
gid check

# 5. (Pro) Apply refactoring to code
gid refactor --dry-run
gid refactor
```

**Result:** Safe, validated refactoring plan.

---

## 8. Architecture Health Monitoring

**Scenario:** Track architecture health over time (CI/CD).

```bash
# In CI pipeline:
gid check --json > health-report.json

# Fail if score drops below threshold
gid check --min-score 80

# Compare with previous version
gid history diff HEAD~1
```

**Result:** Automated architecture quality gates.

---

## 9. Onboarding New Team Member

**Scenario:** New developer needs to understand the codebase.

```bash
# 1. Show the big picture
gid visual

# 2. Explain key features and their implementations
gid query deps UserRegistration --reverse
# Shows: UserController, UserService implement this feature

# 3. Show architecture layers
# In visual: toggle layer view
```

**Result:** Quick understanding of system architecture.

---

## 10. Deprecation Planning

**Scenario:** Want to phase out a component.

```bash
# 1. Mark as deprecated in graph.yml
```
```yaml
nodes:
  LegacyAuthService:
    type: Component
    status: deprecated       # <-- Mark for removal
    description: "Old auth - migrate to NewAuthService"
```
```bash
# 2. See what still depends on it
gid query deps LegacyAuthService --reverse

# 3. Visualize - deprecated shows in gray
gid visual

# 4. Track migration progress
# Update dependents one by one, re-run query
```

**Result:** Safe deprecation with visibility.

---

## Node Status Reference

| Status | Visual | Use Case |
|--------|--------|----------|
| `active` | Solid color | Exists, implemented |
| `planned` | Faded/dashed | On roadmap, not built |
| `deprecated` | Gray | Being removed |

---

## Command Quick Reference

| Task | Command |
|------|---------|
| Initialize | `gid init` |
| Extract from code | `gid extract ./src` |
| Validate | `gid check` |
| Visualize | `gid visual` |
| Impact analysis | `gid query impact <node>` |
| Dependencies | `gid query deps <node>` |
| Reverse deps | `gid query deps <node> --reverse` |
| Common cause | `gid query common-cause <a> <b>` |
| Path finding | `gid query path <from> <to>` |
| AI design | `gid design` |
| Version history | `gid history list` |

---

*See [README.md](README.md) for full command reference*
