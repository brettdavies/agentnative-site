// Canonical error types for an agent-native Rust CLI tool.
//
// Demonstrates:
// - Structured error enum with exit code mapping (P4: actionable errors)
// - sysexits-compatible codes: Config=78, Auth=77, Command=1 (P4: agents parse exit codes)
// - Format-aware error printing: JSON when --output json, colored text otherwise (P2)
// - thiserror derive for ergonomic error construction
// - Variant-to-kind mapping for JSON serialization (P2: parseable error output)
//
// Adapt to your tool: rename AppError, add domain-specific variants.

use crate::output::OutputConfig;
use thiserror::Error;

/// Application error with structured exit codes.
///
/// Exit codes follow sysexits conventions where possible:
/// - 0: Success
/// - 1: General command error (catch-all)
/// - 2: Usage error (bad arguments — handled by clap/try_parse)
/// - 77: Permission/auth error (EX_NOPERM)
/// - 78: Configuration error (EX_CONFIG)
///
/// Agents use exit codes to decide next actions:
/// - 77 → re-authenticate and retry
/// - 78 → check config file and report to user
/// - 1  → log the error message, do not retry blindly
#[derive(Debug, Error)]
pub enum AppError {
    #[error("configuration error: {0}")]
    Config(#[source] Box<dyn std::error::Error + Send + Sync>),

    #[error("authentication error: {0}")]
    Auth(#[source] Box<dyn std::error::Error + Send + Sync>),

    #[error("{name}: {source}")]
    Command {
        name: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
}

impl AppError {
    /// Exit code for this error variant.
    pub fn exit_code(&self) -> u8 {
        match self {
            AppError::Config(_) => 78,
            AppError::Auth(_) => 77,
            AppError::Command { .. } => 1,
        }
    }

    /// Machine-readable error category for JSON output.
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Config(_) => "config",
            AppError::Auth(_) => "auth",
            AppError::Command { .. } => "command",
        }
    }

    /// Print the error in the format matching OutputConfig.
    ///
    /// When --output json: structured JSON to stderr.
    /// When --output text: colored human-readable to stderr.
    ///
    /// Agents consuming JSON output can parse the error kind and exit code
    /// to decide whether to retry, re-authenticate, or report.
    pub fn print(&self, out: &OutputConfig) {
        use crate::output::OutputFormat;

        match out.format {
            OutputFormat::Json | OutputFormat::Jsonl => {
                let err_json = serde_json::json!({
                    "error": true,
                    "kind": self.kind(),
                    "message": self.to_string(),
                    "exit_code": self.exit_code(),
                });
                eprintln!("{}", serde_json::to_string(&err_json).unwrap());
            }
            OutputFormat::Text => {
                if out.use_color {
                    eprintln!("\x1b[31merror\x1b[0m: {self}");
                } else {
                    eprintln!("error: {self}");
                }
            }
        }
    }
}
