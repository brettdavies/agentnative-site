// Canonical output formatting for an agent-native Rust CLI tool.
//
// Demonstrates:
// - OutputFormat enum with Text/Json/Jsonl variants (P2: structured output)
// - OutputConfig struct threaded through call stack (P2: never naked println!)
// - TTY detection respecting NO_COLOR and TERM=dumb (P6: composable)
// - diag! macro for gated diagnostic output (P7: bounded responses)
// - FalseyValueParser for boolean env vars (P1: non-interactive)
// - Env var overrides for all agentic flags (P1: scriptable)
//
// Adapt to your tool: rename env var prefixes (TOOL_OUTPUT, TOOL_QUIET).

use clap::{builder::FalseyValueParser, ColorChoice, Parser, ValueEnum};
use std::io::IsTerminal;

// ---------------------------------------------------------------------------
// OutputFormat enum — the --output flag
// ---------------------------------------------------------------------------

/// Output format selection. Agents set --output json; humans get text by default.
#[derive(Clone, Debug, ValueEnum, PartialEq, Eq)]
pub enum OutputFormat {
    /// Human-readable, colored when TTY. Default.
    Text,
    /// Machine-readable JSON. One object per response.
    Json,
    /// Newline-delimited JSON. One object per line for streaming.
    Jsonl,
}

// ---------------------------------------------------------------------------
// Agentic flags on the Cli struct — add these to your #[derive(Parser)] struct
// ---------------------------------------------------------------------------

// These fields go inside your Cli struct alongside other flags:
//
//   /// Output format (text, json, jsonl)
//   #[arg(long, value_enum, default_value_t = OutputFormat::Text,
//          env = "TOOL_OUTPUT", global = true)]
//   pub output: OutputFormat,
//
//   /// Suppress non-essential output
//   #[arg(short, long, env = "TOOL_QUIET", global = true,
//          value_parser = FalseyValueParser::new())]
//   pub quiet: bool,
//
//   /// Disable interactive prompts (for automation/agents)
//   #[arg(long, env = "TOOL_NO_INTERACTIVE", global = true,
//          value_parser = FalseyValueParser::new())]
//   pub no_interactive: bool,
//
//   /// Request timeout in seconds
//   #[arg(long, default_value_t = 30, env = "TOOL_TIMEOUT", global = true)]
//   pub timeout: u64,
//
// FalseyValueParser allows TOOL_QUIET=0 to correctly disable quiet mode.
// Without it, any non-empty env var value (including "0", "false", "no")
// would be treated as truthy.

// ---------------------------------------------------------------------------
// OutputConfig — threaded through the call stack
// ---------------------------------------------------------------------------

/// Output configuration derived from CLI flags. Thread this through every
/// function that produces output — never call println! or eprintln! directly.
#[derive(Clone, Debug)]
pub struct OutputConfig {
    pub format: OutputFormat,
    pub use_color: bool,
    pub quiet: bool,
}

impl OutputConfig {
    /// Create from CLI flags. Detects TTY and respects NO_COLOR.
    pub fn new(format: OutputFormat, quiet: bool) -> Self {
        let stderr_tty = std::io::stderr().is_terminal();
        let no_color = std::env::var("NO_COLOR").is_ok();
        let term_dumb = std::env::var("TERM").as_deref() == Ok("dumb");

        let use_color = stderr_tty && !no_color && !term_dumb
            && format == OutputFormat::Text;

        Self { format, use_color, quiet }
    }

    /// Whether diagnostic (non-essential) output should be suppressed.
    /// True when --quiet is set OR when output format is JSON/JSONL
    /// (agents parsing JSON don't want interleaved human text).
    pub fn suppress_diag(&self) -> bool {
        self.quiet || self.format != OutputFormat::Text
    }

    /// Clap ColorChoice derived from the same signals as use_color.
    /// Pass to Cli::command().color(color_choice_for_clap()) for consistent
    /// help text coloring.
    pub fn color_choice_for_clap() -> ColorChoice {
        let stderr_tty = std::io::stderr().is_terminal();
        let no_color = std::env::var("NO_COLOR").is_ok();
        let term_dumb = std::env::var("TERM").as_deref() == Ok("dumb");

        if !stderr_tty || no_color || term_dumb {
            ColorChoice::Never
        } else {
            ColorChoice::Auto
        }
    }
}

// ---------------------------------------------------------------------------
// diag! macro — gated diagnostic output
// ---------------------------------------------------------------------------

/// Print diagnostic messages to stderr, suppressed when quiet or JSON output.
///
/// Usage:
///   diag!(out, "Processing {} items", count);
///
/// Equivalent to eprintln! but checks suppress_diag() first.
/// Zero allocation when suppressed — the format string is never evaluated.
#[macro_export]
macro_rules! diag {
    ($out:expr, $($arg:tt)*) => {
        if !$out.suppress_diag() {
            eprintln!($($arg)*);
        }
    };
}
