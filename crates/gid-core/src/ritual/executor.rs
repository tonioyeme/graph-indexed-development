//! Phase Executors — Execute individual phases by delegating to backends.
//!
//! Each executor handles a different phase kind: skill, gid command, harness, or shell.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use async_trait::async_trait;
use tracing::{info, debug, warn};

use super::definition::{PhaseDefinition, HarnessConfigOverride};

/// Result of executing a single phase.
#[derive(Debug, Clone)]
pub struct PhaseResult {
    /// Whether the phase completed successfully.
    pub success: bool,
    /// Artifacts produced by this phase.
    pub artifacts: Vec<String>,
    /// Error message if failed.
    pub error: Option<String>,
    /// Duration in seconds.
    pub duration_secs: u64,
}

/// Context passed to every phase executor.
#[derive(Debug, Clone)]
pub struct PhaseContext {
    /// Project root directory.
    pub project_root: PathBuf,
    /// GID directory (usually .gid/).
    pub gid_root: PathBuf,
    /// Artifacts from previous phases, keyed by phase ID.
    pub previous_artifacts: HashMap<String, Vec<PathBuf>>,
    /// Model to use for this phase.
    pub model: String,
    /// Name of the ritual.
    pub ritual_name: String,
    /// Index of the current phase.
    pub phase_index: usize,
}

/// Trait for phase execution backends.
#[async_trait]
pub trait PhaseExecutor: Send + Sync {
    /// Execute the phase and return the result.
    async fn execute(
        &self,
        phase: &PhaseDefinition,
        context: &PhaseContext,
    ) -> Result<PhaseResult>;
}

/// Runs a skill by spawning an LLM session with the skill's prompt.
///
/// NOTE: This is a stub implementation. Full skill execution requires
/// LLM integration which will be added later.
pub struct SkillExecutor {
    project_root: PathBuf,
}

impl SkillExecutor {
    pub fn new(project_root: &Path) -> Self {
        Self {
            project_root: project_root.to_path_buf(),
        }
    }
    
    /// Execute a skill phase.
    pub async fn execute(
        &self,
        phase: &PhaseDefinition,
        context: &PhaseContext,
        skill_name: &str,
    ) -> Result<PhaseResult> {
        let start = std::time::Instant::now();
        
        info!(
            "Executing skill phase '{}' with skill '{}'",
            phase.id, skill_name
        );
        
        // TODO: Full implementation would:
        // 1. Load skill's SKILL.md
        // 2. Construct system prompt with skill template + input artifacts
        // 3. Run LLM session via agentctl_auth::claude::Client
        // 4. Parse output to extract artifacts
        
        // For now, just log and return success (stub)
        debug!(
            "Skill execution is stubbed. Would run skill '{}' with model '{}'",
            skill_name, context.model
        );
        
        // Check for expected output artifacts
        let mut artifacts = Vec::new();
        for output in &phase.output {
            let path = self.project_root.join(&output.path);
            if path.exists() {
                artifacts.push(output.path.clone());
            } else if output.required {
                warn!("Required output artifact not found: {}", output.path);
            }
        }
        
        Ok(PhaseResult {
            success: true,
            artifacts,
            error: None,
            duration_secs: start.elapsed().as_secs(),
        })
    }
}

/// Runs a gid CLI command (design, extract, advise, etc.).
pub struct GidCommandExecutor {
    gid_binary: PathBuf,
}

impl GidCommandExecutor {
    pub fn new() -> Self {
        // Try to find gid binary in PATH
        let gid_binary = which::which("gid")
            .unwrap_or_else(|_| PathBuf::from("gid"));
        
        Self { gid_binary }
    }
    
    pub fn with_binary(gid_binary: PathBuf) -> Self {
        Self { gid_binary }
    }
    
    /// Execute a gid command phase.
    pub async fn execute(
        &self,
        phase: &PhaseDefinition,
        context: &PhaseContext,
        command: &str,
        args: &[String],
    ) -> Result<PhaseResult> {
        let start = std::time::Instant::now();
        
        info!(
            "Executing gid command phase '{}': {} {}",
            phase.id, command, args.join(" ")
        );
        
        let mut cmd = tokio::process::Command::new(&self.gid_binary);
        cmd.arg(command);
        cmd.args(args);
        cmd.current_dir(&context.project_root);
        
        let output = cmd.output().await
            .with_context(|| format!("Failed to execute: gid {} {}", command, args.join(" ")))?;
        
        let success = output.status.success();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        
        if !success {
            return Ok(PhaseResult {
                success: false,
                artifacts: vec![],
                error: Some(format!("gid {} failed:\nstdout: {}\nstderr: {}", command, stdout, stderr)),
                duration_secs: start.elapsed().as_secs(),
            });
        }
        
        debug!("gid {} completed: {}", command, stdout.trim());
        
        // Collect output artifacts
        let mut artifacts = Vec::new();
        for output_spec in &phase.output {
            let path = context.project_root.join(&output_spec.path);
            if path.exists() {
                artifacts.push(output_spec.path.clone());
            } else if output_spec.required {
                return Ok(PhaseResult {
                    success: false,
                    artifacts,
                    error: Some(format!("Required output artifact not found: {}", output_spec.path)),
                    duration_secs: start.elapsed().as_secs(),
                });
            }
        }
        
        Ok(PhaseResult {
            success: true,
            artifacts,
            error: None,
            duration_secs: start.elapsed().as_secs(),
        })
    }
}

impl Default for GidCommandExecutor {
    fn default() -> Self {
        Self::new()
    }
}

/// Runs the task harness (gid execute).
///
/// NOTE: This is a stub implementation. Full harness execution requires
/// integration with gid_harness::scheduler::execute_plan().
pub struct HarnessExecutor {
    #[allow(dead_code)]  // Will be used when harness integration is complete
    project_root: PathBuf,
}

impl HarnessExecutor {
    pub fn new(project_root: &Path) -> Self {
        Self {
            project_root: project_root.to_path_buf(),
        }
    }
    
    /// Execute a harness phase.
    pub async fn execute(
        &self,
        phase: &PhaseDefinition,
        context: &PhaseContext,
        config_overrides: Option<&HarnessConfigOverride>,
    ) -> Result<PhaseResult> {
        let start = std::time::Instant::now();
        
        info!("Executing harness phase '{}'", phase.id);
        
        // TODO: Full implementation would:
        // 1. Load harness config from .gid/execution.yml
        // 2. Apply config_overrides
        // 3. Call gid_harness::scheduler::execute_plan()
        // 4. Return results
        
        // For now, log and return success (stub)
        if let Some(overrides) = config_overrides {
            debug!(
                "Harness config overrides: max_concurrent={:?}, max_retries={:?}",
                overrides.max_concurrent, overrides.max_retries
            );
        }
        
        debug!(
            "Harness execution is stubbed. Would run task harness with model '{}'",
            context.model
        );
        
        Ok(PhaseResult {
            success: true,
            artifacts: vec![],
            error: None,
            duration_secs: start.elapsed().as_secs(),
        })
    }
}

/// Runs an arbitrary shell command.
pub struct ShellExecutor {
    working_dir: PathBuf,
}

impl ShellExecutor {
    pub fn new(working_dir: &Path) -> Self {
        Self {
            working_dir: working_dir.to_path_buf(),
        }
    }
    
    /// Execute a shell command phase.
    pub async fn execute(
        &self,
        phase: &PhaseDefinition,
        _context: &PhaseContext,
        command: &str,
    ) -> Result<PhaseResult> {
        let start = std::time::Instant::now();
        
        info!("Executing shell phase '{}': {}", phase.id, command);
        
        let output = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(&self.working_dir)
            .output()
            .await
            .with_context(|| format!("Failed to execute shell command: {}", command))?;
        
        let success = output.status.success();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        
        if !success {
            return Ok(PhaseResult {
                success: false,
                artifacts: vec![],
                error: Some(format!(
                    "Shell command failed with exit code {:?}:\nstdout: {}\nstderr: {}",
                    output.status.code(), stdout, stderr
                )),
                duration_secs: start.elapsed().as_secs(),
            });
        }
        
        debug!("Shell command completed: {}", stdout.trim());
        
        // Collect output artifacts
        let mut artifacts = Vec::new();
        for output_spec in &phase.output {
            let path = self.working_dir.join(&output_spec.path);
            if path.exists() {
                artifacts.push(output_spec.path.clone());
            } else if output_spec.required {
                return Ok(PhaseResult {
                    success: false,
                    artifacts,
                    error: Some(format!("Required output artifact not found: {}", output_spec.path)),
                    duration_secs: start.elapsed().as_secs(),
                });
            }
        }
        
        Ok(PhaseResult {
            success: true,
            artifacts,
            error: None,
            duration_secs: start.elapsed().as_secs(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    
    fn create_test_phase() -> PhaseDefinition {
        PhaseDefinition {
            id: "test".to_string(),
            kind: super::super::definition::PhaseKind::Shell {
                command: "echo test".to_string(),
            },
            model: None,
            approval: super::super::definition::ApprovalRequirement::Auto,
            skip_if: None,
            timeout_minutes: None,
            input: vec![],
            output: vec![],
            hooks: super::super::definition::PhaseHooks::default(),
            on_failure: super::super::definition::FailureStrategy::Escalate,
            harness_config: None,
        }
    }
    
    fn create_test_context(project_root: &Path) -> PhaseContext {
        PhaseContext {
            project_root: project_root.to_path_buf(),
            gid_root: project_root.join(".gid"),
            previous_artifacts: HashMap::new(),
            model: "sonnet".to_string(),
            ritual_name: "test".to_string(),
            phase_index: 0,
        }
    }
    
    #[tokio::test]
    async fn test_shell_executor_success() {
        let temp_dir = TempDir::new().unwrap();
        let executor = ShellExecutor::new(temp_dir.path());
        let phase = create_test_phase();
        let context = create_test_context(temp_dir.path());
        
        let result = executor.execute(&phase, &context, "echo hello").await.unwrap();
        
        assert!(result.success);
        assert!(result.error.is_none());
    }
    
    #[tokio::test]
    async fn test_shell_executor_failure() {
        let temp_dir = TempDir::new().unwrap();
        let executor = ShellExecutor::new(temp_dir.path());
        let phase = create_test_phase();
        let context = create_test_context(temp_dir.path());
        
        let result = executor.execute(&phase, &context, "exit 1").await.unwrap();
        
        assert!(!result.success);
        assert!(result.error.is_some());
    }
    
    #[tokio::test]
    async fn test_shell_executor_with_output() {
        let temp_dir = TempDir::new().unwrap();
        let executor = ShellExecutor::new(temp_dir.path());
        
        let mut phase = create_test_phase();
        phase.output = vec![
            super::super::definition::ArtifactSpec {
                path: "output.txt".to_string(),
                required: true,
            },
        ];
        
        let context = create_test_context(temp_dir.path());
        
        // Create the output file
        std::fs::write(temp_dir.path().join("output.txt"), "test").unwrap();
        
        let result = executor.execute(&phase, &context, "echo done").await.unwrap();
        
        assert!(result.success);
        assert_eq!(result.artifacts, vec!["output.txt"]);
    }
    
    #[tokio::test]
    async fn test_shell_executor_missing_required_output() {
        let temp_dir = TempDir::new().unwrap();
        let executor = ShellExecutor::new(temp_dir.path());
        
        let mut phase = create_test_phase();
        phase.output = vec![
            super::super::definition::ArtifactSpec {
                path: "missing.txt".to_string(),
                required: true,
            },
        ];
        
        let context = create_test_context(temp_dir.path());
        
        let result = executor.execute(&phase, &context, "echo done").await.unwrap();
        
        assert!(!result.success);
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("not found"));
    }
}
