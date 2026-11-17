// Black-box test skeleton for an agent-native CLI, distilled from
// agentnative-cli tests/integration.rs
// @ eba21454ccbc5fae9c09613b982104676c7956a7.
// The live file at that repo's HEAD is the authoritative robust version;
// this is a starting skeleton to adapt.
//
// Adapt: replace every YOUR_* placeholder, drop tests for surfaces your
// tool does not ship, and run the suite red before making it pass.
// Cargo.toml dev-dependencies: assert_cmd, predicates, serde_json.

use assert_cmd::Command;
use predicates::prelude::*;

const BINARY: &str = "YOUR_BINARY";
// A verb that reads state without mutating anything, e.g. "list".
const READ_VERB: &str = "YOUR_READ_VERB";
// A verb with at least one required input, e.g. "create".
const VERB_WITH_REQUIRED_INPUT: &str = "YOUR_MUTATING_VERB";
// The exit code your tool documents for usage errors (commonly 2).
const USAGE_EXIT: i32 = 2;
// The exit code your tool documents for a nonexistent target (path, id,
// host). The spec's exit table separates general command errors (1) from
// usage errors (2); the anchor tool documents 2 for this arm. Assert
// your documented arm, not a source's choice.
const YOUR_NONEXISTENT_TARGET_EXIT: i32 = 1;
// Top-level keys your JSON output guarantees. The key-set test is
// bidirectional: it fails on missing AND on unexpected keys.
const EXPECTED_KEYS: &[&str] = &["YOUR_KEY_A", "YOUR_KEY_B"];

fn cmd() -> Command {
    Command::cargo_bin(BINARY).expect("binary should exist")
}

fn json_stdout(args: &[&str]) -> serde_json::Value {
    let assert = cmd().args(args).assert();
    let output = assert.get_output().stdout.clone();
    serde_json::from_slice(&output).expect("stdout should be valid JSON")
}

// P1: assert_cmd spawns with stdin closed; a verb that prompts or waits
// for input hangs this test instead of completing.
#[test]
fn p1_closed_stdin_neither_hangs_nor_prompts() {
    cmd().arg(READ_VERB).assert().success();
}

// P1: a missing required input errors immediately instead of prompting.
#[test]
fn p1_missing_required_input_errors_instead_of_prompting() {
    cmd()
        .arg(VERB_WITH_REQUIRED_INPUT)
        .assert()
        .code(USAGE_EXIT)
        .stderr(predicate::str::is_empty().not());
}

// P1: bare invocation is deliberate and safe. Swap the expectation for
// the behavior your tool documents (help on stdout, or a usage error).
#[test]
fn p1_bare_invocation_is_deliberate_and_safe() {
    cmd()
        .assert()
        .code(USAGE_EXIT)
        .stderr(predicate::str::contains("Usage"));
}

// P2: structured output parses with a real JSON parser.
#[test]
fn p2_output_json_parses() {
    let parsed = json_stdout(&[READ_VERB, "--output", "json"]);
    assert!(parsed.is_object() || parsed.is_array());
}

// P2: the top-level key set is stable in both directions.
#[test]
fn p2_stable_top_level_keys() {
    let parsed = json_stdout(&[READ_VERB, "--output", "json"]);
    let obj = parsed.as_object().expect("top level should be an object");
    for key in EXPECTED_KEYS {
        assert!(obj.contains_key(*key), "missing required key {key:?}");
    }
    let unexpected: Vec<&String> = obj
        .keys()
        .filter(|k| !EXPECTED_KEYS.contains(&k.as_str()))
        .collect();
    assert!(
        unexpected.is_empty(),
        "unexpected top-level key(s): {unexpected:?}"
    );
}

// P2: the short alias produces the same shape as the long form.
#[test]
fn p2_json_alias_matches_output_json() {
    let long_form = json_stdout(&[READ_VERB, "--output", "json"]);
    let alias = json_stdout(&[READ_VERB, "--json"]);
    assert_eq!(long_form, alias);
}

// P2: NO_COLOR strips ANSI escapes and the output still parses.
#[test]
fn p2_no_color_strips_ansi() {
    let assert = cmd()
        .env("NO_COLOR", "1")
        .args([READ_VERB, "--output", "json"])
        .assert();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    assert!(
        !stdout.contains("\x1b["),
        "output should carry no ANSI escapes under NO_COLOR=1"
    );
    let _: serde_json::Value = serde_json::from_str(&stdout).expect("still valid JSON");
}

// P2: a bad invocation under JSON mode emits a typed error envelope, so
// a JSON-pinned consumer never needs a second parser for failures.
#[test]
fn p2_bad_invocation_emits_json_error_envelope() {
    let assert = cmd()
        .args(["--this-flag-does-not-exist", "--output", "json"])
        .assert()
        .code(USAGE_EXIT);
    let stderr = String::from_utf8(assert.get_output().stderr.clone()).expect("utf8 stderr");
    let line = stderr.lines().next().expect("envelope on first line");
    let parsed: serde_json::Value = serde_json::from_str(line).expect("valid JSON envelope");
    let obj = parsed.as_object().expect("envelope is a JSON object");
    assert!(obj.contains_key("error"));
    assert!(obj.contains_key("kind"));
    assert!(obj.contains_key("message"));
}

// P3: --help succeeds and shows usage.
#[test]
fn p3_help_contains_usage() {
    cmd()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("Usage"));
}

// P3: per-verb help documents that verb's flags.
#[test]
fn p3_verb_help_documents_flags() {
    cmd()
        .args([READ_VERB, "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("YOUR_DOCUMENTED_FLAG"));
}

// P3: --version prints the tool name and a version string.
#[test]
fn p3_version_prints_name_and_version() {
    cmd()
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::contains(BINARY));
}

// P4: an unknown flag exits with the usage code and a stderr message.
#[test]
fn p4_unknown_flag_exits_usage_code_with_stderr() {
    cmd()
        .arg("--this-flag-does-not-exist")
        .assert()
        .code(USAGE_EXIT)
        .stderr(predicate::str::is_empty().not());
}

// P4: assert every arm of your exit-code table; this is the nonexistent-
// target arm. Add one test per documented code, even the trivial ones.
#[test]
fn p4_nonexistent_target_exits_documented_code() {
    cmd()
        .args([READ_VERB, "/nonexistent/path/that/does/not/exist"])
        .assert()
        .code(YOUR_NONEXISTENT_TARGET_EXIT)
        .stderr(predicate::str::contains("error"));
}

// P6: tokens after `--` parse as positionals, never as flags.
#[test]
fn p6_double_dash_separator_treats_tokens_as_positionals() {
    cmd()
        .args([READ_VERB, "--", "YOUR_POSITIONAL"])
        .assert()
        .stderr(predicate::str::contains("unexpected argument").not());
}

// P6: completions generate for at least one shell and are non-empty.
#[test]
fn p6_completions_generate() {
    cmd()
        .args(["completions", "bash"])
        .assert()
        .success()
        .stdout(predicate::str::is_empty().not());
}

// P7: --quiet output is strictly smaller and carries no per-item status
// lines. Swap the marker for whatever your normal output prefixes.
#[test]
fn p7_quiet_suppresses_noise() {
    let normal = cmd().arg(READ_VERB).output().expect("normal run");
    let quiet = cmd()
        .args([READ_VERB, "--quiet"])
        .output()
        .expect("quiet run");
    let normal_stdout = String::from_utf8_lossy(&normal.stdout);
    let quiet_stdout = String::from_utf8_lossy(&quiet.stdout);
    assert!(
        quiet_stdout.len() < normal_stdout.len(),
        "quiet output should be shorter than normal output"
    );
    assert!(!quiet_stdout.contains("YOUR_STATUS_LINE_MARKER"));
}
