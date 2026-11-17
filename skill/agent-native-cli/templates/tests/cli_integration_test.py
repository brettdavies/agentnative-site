# Black-box test skeleton for an agent-native CLI on the Python harness
# row (subprocess + pytest), transposed from agentnative-cli
# tests/integration.rs
# @ eba21454ccbc5fae9c09613b982104676c7956a7.
# The live file at that repo's HEAD is the authoritative robust version;
# this is a starting skeleton to adapt.
#
# Adapt: replace every YOUR_* placeholder, drop tests for surfaces your
# tool does not ship, and run the suite red before making it pass.
# Keep a pytest-discoverable filename (test_*.py or *_test.py).
# Dependencies: pytest; the standard library covers the rest.

import json
import os
import subprocess

BINARY = "YOUR_BINARY"
# A verb that reads state without mutating anything, e.g. "list".
READ_VERB = "YOUR_READ_VERB"
# A verb with at least one required input, e.g. "create".
VERB_WITH_REQUIRED_INPUT = "YOUR_MUTATING_VERB"
# The exit code your tool documents for usage errors (commonly 2).
USAGE_EXIT = 2
# The exit code your tool documents for a nonexistent target (path, id,
# host). The spec's exit table separates general command errors (1) from
# usage errors (2); the anchor tool documents 2 for this arm. Assert
# your documented arm, not a source's choice.
YOUR_NONEXISTENT_TARGET_EXIT = 1
# Top-level keys your JSON output guarantees. The key-set test is
# bidirectional: it fails on missing AND on unexpected keys.
EXPECTED_KEYS = {"YOUR_KEY_A", "YOUR_KEY_B"}


def run(*args, extra_env=None):
    # Spawn the real binary with stdin closed; a verb that prompts or
    # waits for input hits the timeout and fails instead of hanging.
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [BINARY, *args],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        env=env,
        timeout=10,
    )


def json_stdout(*args, extra_env=None):
    result = run(*args, extra_env=extra_env)
    return json.loads(result.stdout)


# P1: stdin is closed in run(); a verb that prompts or waits for input
# times this test out instead of completing.
def test_p1_closed_stdin_neither_hangs_nor_prompts():
    assert run(READ_VERB).returncode == 0


# P1: a missing required input errors immediately instead of prompting.
def test_p1_missing_required_input_errors_instead_of_prompting():
    result = run(VERB_WITH_REQUIRED_INPUT)
    assert result.returncode == USAGE_EXIT
    assert result.stderr != ""


# P1: bare invocation is deliberate and safe. Swap the expectation for
# the behavior your tool documents (help on stdout, or a usage error).
def test_p1_bare_invocation_is_deliberate_and_safe():
    result = run()
    assert result.returncode == USAGE_EXIT
    assert "usage" in result.stderr.lower()


# P2: structured output parses with a real JSON parser.
def test_p2_output_json_parses():
    parsed = json_stdout(READ_VERB, "--output", "json")
    assert isinstance(parsed, (dict, list))


# P2: the top-level key set is stable in both directions.
def test_p2_stable_top_level_keys():
    parsed = json_stdout(READ_VERB, "--output", "json")
    assert isinstance(parsed, dict)
    keys = set(parsed)
    missing = EXPECTED_KEYS - keys
    unexpected = keys - EXPECTED_KEYS
    assert not missing, f"missing required key(s): {sorted(missing)}"
    assert not unexpected, f"unexpected top-level key(s): {sorted(unexpected)}"


# P2: the short alias produces the same shape as the long form.
def test_p2_json_alias_matches_output_json():
    long_form = json_stdout(READ_VERB, "--output", "json")
    alias = json_stdout(READ_VERB, "--json")
    assert long_form == alias


# P2: NO_COLOR strips ANSI escapes and the output still parses.
def test_p2_no_color_strips_ansi():
    result = run(READ_VERB, "--output", "json", extra_env={"NO_COLOR": "1"})
    assert "\x1b[" not in result.stdout, "output should carry no ANSI escapes under NO_COLOR=1"
    json.loads(result.stdout)


# P2: a bad invocation under JSON mode emits a typed error envelope, so
# a JSON-pinned consumer never needs a second parser for failures.
def test_p2_bad_invocation_emits_json_error_envelope():
    result = run("--this-flag-does-not-exist", "--output", "json")
    assert result.returncode == USAGE_EXIT
    envelope = json.loads(result.stderr.splitlines()[0])
    assert isinstance(envelope, dict)
    for key in ("error", "kind", "message"):
        assert key in envelope


# P3: --help succeeds and shows usage.
def test_p3_help_contains_usage():
    result = run("--help")
    assert result.returncode == 0
    assert "usage" in result.stdout.lower()


# P3: per-verb help documents that verb's flags.
def test_p3_verb_help_documents_flags():
    result = run(READ_VERB, "--help")
    assert result.returncode == 0
    assert "YOUR_DOCUMENTED_FLAG" in result.stdout


# P3: --version prints the tool name and a version string.
def test_p3_version_prints_name_and_version():
    result = run("--version")
    assert result.returncode == 0
    assert BINARY in result.stdout


# P4: an unknown flag exits with the usage code and a stderr message.
def test_p4_unknown_flag_exits_usage_code_with_stderr():
    result = run("--this-flag-does-not-exist")
    assert result.returncode == USAGE_EXIT
    assert result.stderr != ""


# P4: assert every arm of your exit-code table; this is the nonexistent-
# target arm. Add one test per documented code, even the trivial ones.
def test_p4_nonexistent_target_exits_documented_code():
    result = run(READ_VERB, "/nonexistent/path/that/does/not/exist")
    assert result.returncode == YOUR_NONEXISTENT_TARGET_EXIT
    assert "error" in result.stderr.lower()


# P6: tokens after `--` parse as positionals, never as flags. Swap the
# rejection phrase for your parser's wording if it differs.
def test_p6_double_dash_separator_treats_tokens_as_positionals():
    result = run(READ_VERB, "--", "YOUR_POSITIONAL")
    assert "unexpected argument" not in result.stderr
    assert "unrecognized arguments" not in result.stderr


# P6: completions generate for at least one shell and are non-empty.
def test_p6_completions_generate():
    result = run("completions", "bash")
    assert result.returncode == 0
    assert result.stdout != ""


# P7: --quiet output is strictly smaller and carries no per-item status
# lines. Swap the marker for whatever your normal output prefixes.
def test_p7_quiet_suppresses_noise():
    normal = run(READ_VERB)
    quiet = run(READ_VERB, "--quiet")
    assert len(quiet.stdout) < len(normal.stdout), "quiet output should be shorter than normal output"
    assert "YOUR_STATUS_LINE_MARKER" not in quiet.stdout
