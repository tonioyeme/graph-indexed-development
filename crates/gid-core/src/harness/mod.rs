//! Task execution harness — planning, topology analysis, and context assembly.
//!
//! This module provides the pure, deterministic planning functions for the
//! GID task execution harness. It does NOT perform I/O or spawn sub-agents.
//!
//! The execution engine (scheduler, executor, worktree manager) lives in
//! the `gid-harness` crate, which depends on this module for types and planning.

pub mod types;
pub mod topology;
pub mod planner;
pub mod context;
pub mod config;

// Re-export key types
pub use types::*;
pub use topology::{detect_cycles, compute_layers, critical_path, orphan_tasks};
pub use planner::create_plan;
pub use context::assemble_task_context;
pub use config::load_config;
