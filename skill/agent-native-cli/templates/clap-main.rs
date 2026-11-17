// Canonical main.rs structure for an agent-native Rust CLI tool.
//
// Demonstrates:
// - SIGPIPE fix (P6: composable — clean pipe exit)
// - try_parse() instead of parse() (P4: actionable errors with JSON output)
// - Three-tier dependency gating (P6: composable — fail fast on missing deps)
// - Result-returning run() (P4: structured error propagation)
// - OutputConfig threading (P2: structured output throughout)
// - Format-aware error printing (P2: JSON errors when --output json)
//
// Adapt to your tool: rename Cli/Commands/AppError, adjust dependency tiers.

use clap::Parser;
use std::process::ExitCode;

mod cli;
mod error;
mod output;

use cli::{Cli, Commands};
use error::AppError;
use output::{OutputConfig, OutputFormat};

fn main() -> ExitCode {
    // --- SIGPIPE fix (P6) ---
    // Restore default SIGPIPE handling so piping to `head` exits cleanly
    // instead of panicking with "broken pipe". Must be first thing in main().
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }

    // --- Parse CLI args (P4) ---
    // Use try_parse() so parse errors produce JSON when --output json.
    // clap's parse() calls process::exit() directly, bypassing custom error
    // handlers — the agent never sees structured error output.
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            // Check if --output json was passed (manually, since parse failed)
            let args: Vec<String> = std::env::args().collect();
            let is_json = args.windows(2).any(|w| w[0] == "--output" && w[1] == "json");
            if is_json {
                let err_json = serde_json::json!({
                    "error": true,
                    "kind": "usage",
                    "message": e.to_string(),
                });
                eprintln!("{}", serde_json::to_string(&err_json).unwrap());
            } else {
                e.print().ok();
            }
            return ExitCode::from(2);
        }
    };

    // --- Build OutputConfig (P2) ---
    let out = OutputConfig::new(cli.output, cli.quiet);

    // --- Three-tier dependency gating (P6) ---
    //
    // Tier 1: Meta-commands — no config, no network, no dependencies.
    //   Examples: completions, version
    //   These always work, even in broken environments.
    //
    // Tier 2: Local-only commands — need config, no network.
    //   Examples: config show, cache clear
    //   Fail fast if config is missing/invalid.
    //
    // Tier 3: Network commands — need config + network + auth.
    //   Examples: fetch, post, search
    //   Fail fast if auth is missing before making any network call.

    match &cli.command {
        // Tier 1: Meta-commands (no dependencies)
        Commands::Completions { shell } => {
            clap_complete::generate(
                *shell,
                &mut Cli::command(),
                env!("CARGO_BIN_NAME"),
                &mut std::io::stdout(),
            );
            ExitCode::SUCCESS
        }
        Commands::Version => {
            println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }

        // Tier 2+3: Commands that need config
        _ => match run(&cli, &out) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                e.print(&out);
                ExitCode::from(e.exit_code())
            }
        },
    }
}

/// Run the actual command logic. Returns Result so errors propagate cleanly.
///
/// This function handles Tier 2 (local) and Tier 3 (network) commands.
/// Tier 3 commands should validate auth/connectivity before doing work.
fn run(cli: &Cli, out: &OutputConfig) -> Result<(), AppError> {
    // Load config (Tier 2 gate)
    let config = load_config()?;

    match &cli.command {
        // Tier 2: Local-only commands
        Commands::ConfigShow => {
            // ... local operation using config
            Ok(())
        }

        // Tier 3: Network commands (validate auth first)
        Commands::Fetch { url } => {
            let client = create_authenticated_client(&config)?; // fails fast on bad auth
            // ... network operation
            Ok(())
        }

        _ => unreachable!("meta-commands handled in main()"),
    }
}
