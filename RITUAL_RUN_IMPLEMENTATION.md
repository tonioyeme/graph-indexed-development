# `gid ritual run` CLI Implementation Summary

## What Was Implemented

Successfully implemented the `gid ritual run` CLI command with full LLM client integration, progress tracking, interactive approval, and resume support.

## Changes Made

### 1. Created `crates/gid-cli/src/llm_client.rs`

New module implementing `LlmClient` trait for ritual phase execution:

- **`CliLlmClient`**: Shells out to `claude -p` to run skill phases
- **Features**:
  - Passes skill prompts to claude CLI
  - Filters allowed tools via `--allowedTools` flag
  - Parses usage statistics (tokens, tool calls) from stderr
  - Works with any model via `--model` flag
  - Sets working directory for claude execution
  - Returns `SkillResult` with output and usage stats

### 2. Updated `crates/gid-cli/src/main.rs`

**Module Declaration:**
- Added `mod llm_client;` to expose the new module

**CLI Arguments:**
Updated `RitualCommands::Run` variant:
- `--template` / `-t`: Initialize from template before running (combines init + run)
- `--model` / `-m`: Override default model for skill phases
- `--auto-approve`: Auto-approve all approval gates (existing, preserved)

**Enhanced `cmd_ritual_run()` function:**

1. **Template Support**: If `--template` is provided and no ritual exists, runs `cmd_ritual_init()` first
2. **LLM Client Integration**: Creates `CliLlmClient` and passes to `RitualEngine::with_llm_client()`
3. **Resume Support**: Detects existing `ritual-state.json` and uses `RitualEngine::resume()` instead of `new()`
4. **Progress Output**: Shows detailed progress for each phase:
   ```
   ▶ Running ritual: full-dev-cycle
     [1/8] capture-idea (skill, opus)
     ✓ capture-idea completed (12.3s, 3 artifacts)
     [2/8] research (skill, opus)
   ```
5. **Interactive Approval**: When `RitualStatus::WaitingApproval` is returned:
   - Shows phase name requiring approval
   - Lists artifacts produced
   - Prompts: `Approve? [y/n/s(kip)]`
   - Handles: `y`/`yes` (approve), `n`/`no` (reject/pause), `s`/`skip` (skip phase)
6. **Auto-Approve Mode**: With `--auto-approve`, bypasses prompts and auto-approves all phases
7. **Phase Timing**: Tracks and displays duration for each phase
8. **Artifact Count**: Shows how many artifacts each phase produced
9. **Skip Handling**: Displays reason when phases are skipped due to conditions

### 3. Updated `crates/gid-cli/Cargo.toml`

Added dependency:
```toml
async-trait = "0.1"
```

Required for implementing the `LlmClient` trait (uses `#[async_trait]` macro).

## How It Works

### Normal Flow (New Ritual)

```bash
gid ritual run --template full-dev-cycle
```

1. CLI checks if `.gid/ritual.yml` exists
2. If not, runs `cmd_ritual_init()` with the template
3. Creates `CliLlmClient` for skill execution
4. Creates `RitualEngine::with_llm_client()`
5. Loops through phases:
   - Shows progress: `[1/8] capture-idea (skill, opus)`
   - Calls `engine.run()` (runs ONE phase)
   - Shows completion: `✓ capture-idea completed (12.3s, 3 artifacts)`
6. Handles approval gates when needed
7. Continues until ritual completes or fails

### Resume Flow (Existing State)

```bash
gid ritual run
```

1. CLI detects `.gid/ritual-state.json` exists
2. Uses `RitualEngine::resume_with_llm_client()`
3. Shows: `▶ Resuming ritual: full-dev-cycle (from phase 3)`
4. Continues from current phase

### Interactive Approval Example

```
  [2/8] research (skill, opus)
  ⏸ Approval required for 'research'
    Review artifacts:
      - .gid/features/auth/research.md
      - .gid/features/auth/api-design.md
    Approve? [y/n/s(kip)] y
  ✓ Approved.
  [3/8] draft-requirements (skill, opus)
```

## Testing

All tests pass:
```bash
cargo test --all-features
# Result: ok. 2 passed; 0 failed (llm_client tests)
# Result: ok. (all other gid-core tests)
```

Build succeeds without warnings:
```bash
cargo build --release --all-features
# Finished `release` profile [optimized] in 11.48s
```

## Usage Examples

### Basic run (interactive)
```bash
gid ritual run
```

### Run with template initialization
```bash
gid ritual run --template full-dev-cycle
```

### Auto-approve all gates (CI/testing)
```bash
gid ritual run --auto-approve
```

### Override model for all skill phases
```bash
gid ritual run --model sonnet
```

### Combine flags
```bash
gid ritual run --template minimal --model opus --auto-approve
```

## Architecture Notes

### Why `CliLlmClient` is Separate

- **Decoupling**: Keeps `gid-core` free of CLI dependencies
- **Flexibility**: Allows different implementations (API, mock, etc.)
- **Testing**: Core logic can be tested without external CLI dependencies

### Why `RitualEngine::run()` Returns After Each Phase

- **Incremental Progress**: Can show progress and handle approvals between phases
- **Fault Tolerance**: State is saved after each phase completes
- **Interruptibility**: User can pause/resume/skip at any point

### Model Override Precedence

1. CLI `--model` flag (highest priority)
2. Phase-level `model:` in ritual.yml
3. Ritual-level `config.default_model`

## Files Modified

1. **Created**: `crates/gid-cli/src/llm_client.rs` (149 lines)
2. **Modified**: `crates/gid-cli/src/main.rs` (~200 lines changed)
3. **Modified**: `crates/gid-cli/Cargo.toml` (1 dependency added)

## Implementation Status

✅ **Complete and Tested**

All requirements from the task specification have been implemented:
- ✅ CliLlmClient shells out to `claude -p`
- ✅ RitualEngine uses LlmClient via `with_llm_client()`
- ✅ --template flag: init + run in one command
- ✅ --model flag: override default model
- ✅ Progress output: phase names, indices, timings
- ✅ Interactive approval: y/n/s prompt with stdin
- ✅ Resume support: detects and resumes from state file
- ✅ Auto-approve mode: --auto-approve flag
- ✅ All tests passing
- ✅ Feature-gated under `ritual` feature (via `full` feature)

## Next Steps (Optional Future Enhancements)

These were not part of the requirements but could be added later:

1. **Artifact tracking**: Scan working dir for new/modified files
2. **Detailed tool stats**: Show which tools were used during skill execution
3. **Progress bar**: Visual progress indicator for long-running phases
4. **Notification support**: Desktop notifications when approval needed
5. **Parallel phase execution**: Run independent phases concurrently
