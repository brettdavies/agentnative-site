# Spec-drift poll runbook

How the site learns that an upstream specification it relies on has moved: the watched-source manifest, the scheduled
poll that compares it with the live sources, the one issue it keeps per drifted source, and the procedure for re-pinning
after review. Pairs with [`scripts/SYNCS.md` § Watched upstream specifications](../../scripts/SYNCS.md), which places
the manifest among the repo's other sync mechanisms.

## The pieces

| Piece                               | Role                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `src/data/standards/watch.yaml`     | The manifest: one entry per watched source, with the value observed when it was pinned. |
| `scripts/standards/check-drift.ts`  | Fetches every source, compares it with its pin, prints a JSON drift report.             |
| `scripts/standards/drift-issues.ts` | Turns a drift report and the open `spec-drift` issues into one create or update each.   |
| `.github/workflows/spec-drift.yml`  | Runs both daily at 07:41 UTC and on `workflow_dispatch`, then applies the plan.         |

Nothing in the site build or the web-audit registry reads the manifest, so a re-pin never changes a score or forces a
seed reflow.

## Manifest fields

| Field              | Meaning                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `id`               | Kebab-case and unique. Names the drift issue (`spec-drift: <id>`) and its body marker.                    |
| `tier`             | Stability of the source: `rfc`, `spec`, `draft`, `proposal`, or `convention`.                             |
| `type`             | How the source is read (below).                                                                           |
| `url`              | The watched source, in the shape its type expects.                                                        |
| `canonicalization` | `json` compares sorted-key, whitespace-free JSON; `none` hashes the bytes as served (`github-file` only). |
| `pointer`          | A JSON Pointer starting with `/`, for `json-field` only.                                                  |
| `pinned`           | The value observed when the entry was pinned. Drift is any difference after canonicalization.             |

| Type          | Observed value                                                                  |
| ------------- | ------------------------------------------------------------------------------- |
| `github-pr`   | The pull request's `state`, `merged` flag, and `head_sha`.                      |
| `github-file` | `sha256:<hex>` of the file at a branch, read from a `github.com/.../blob/` URL. |
| `url-status`  | The HTTP status of a GET with redirects followed.                               |
| `ietf-draft`  | The datatracker `rev` and document `state`.                                     |
| `json-field`  | The value at `pointer` in a JSON document.                                      |

## What a run does

The `check` job runs `bun scripts/standards/check-drift.ts`, prints the report in the job log, and uploads it as the
`spec-drift-report` artifact (`gh run download <run-id> -n spec-drift-report`). The script exits 0 when every source
matches, 1 when any source drifted, and 2 when a source could not be checked. The job also requires the report's own
`exit_code` to agree with the process exit code, because Bun exits 1 on an uncaught exception too.

- **Clean:** the run is green and opens nothing.
- **Drift:** the run stays green and the `upsert-issues` job keeps exactly one open issue per drifted source. The issue
  is the alert.
- **Unchecked source:** the run goes red with one annotation per error naming its `next_step`: `retry` for a network
  failure, timeout, rate limit, or server error; `fix-manifest` when a watched file answers 404 or 410 or a pointer no
  longer resolves, which needs the entry re-pointed rather than re-pinned. Drift found in the same run still gets its
  issue.

The `check` job sends the workflow token to `api.github.com` only, for the GitHub-hosted sources; unauthenticated, a
shared runner address can exhaust GitHub's 60-requests-an-hour limit. It holds `contents: read`. Only `upsert-issues`
holds `issues: write`, and only its `gh` steps see the token. Runs share one concurrency group across every ref and
never cancel each other, so two runs cannot both decide an issue is missing.

## Drift issues

Each drifted source owns one open issue labeled `spec-drift` (the job creates the label when it is missing). The title
is `spec-drift: <id>` and the body's first line is the marker `<!-- spec-drift:source=<id> -->`. An open issue belongs
to a source when its body carries the marker or its title matches, so editing one of the two does not fork a duplicate;
when two open issues match, the oldest wins. The job lists open issues through the list endpoint rather than search,
because the search index lags minutes behind and would hide an issue the previous run just opened.

On every drifted run the job rewrites the matched issue's title and body: the source, tier, and type, the pinned and
observed values, and a link to the run that observed it. The title and body belong to the poll; discussion goes in
comments, which the poll never touches. The job never closes an issue. Closing one while the source still drifts from
`main`'s pin makes the next run open a fresh issue.

## Re-pinning after a reviewed upstream change

1. Read the upstream change the issue points at: the PR, the file's history at the watched branch, the draft's
   datatracker page, or the JSON document.
2. Decide what the change means for the site. A change to a shape the web audit checks may need code or registry work
   before the pin moves; that work ships in the same PR as the re-pin.
3. Copy the issue's observed value into the entry's `pinned` field in `src/data/standards/watch.yaml`. The value is
   JSON, which is valid YAML, so it pastes as written.
4. For `mcp-server-card-schema`, vendor the new upstream commit first with `scripts/sync-server-card-schema.sh --ref
   <sha>` and update `PINNED_REF` in that script: `tests/standards-drift.test.ts` fails while the vendored schema and
   the pin disagree.
5. Confirm locally that the entry is clean: `GITHUB_TOKEN="$(gh auth token)" bun scripts/standards/check-drift.ts` exits
   0 when nothing else has moved.
6. Open the re-pin PR to `dev` and reference the issue.
7. Close the issue once the release carrying the re-pin is on `main`. Until then the scheduled run still reads `main`'s
   old pin, so it keeps updating the open issue.

## Main-only execution

Scheduled runs execute `main`'s copy of `spec-drift.yml` and check `main`'s manifest. The `check` job also refuses any
non-dispatch event on another ref, so pins only ever come from `main` unless an operator asks for a branch. The poll is
inert on `dev`: a workflow change merged to `dev` takes effect once a release ships it to `main`.

`workflow_dispatch` runs on any branch with `gh workflow run spec-drift.yml --ref <branch>`. GitHub resolves a
dispatched workflow by name on the default branch, so dispatch works only once the file is on `main`; the `--ref` branch
then supplies both the workflow definition and the manifest. A dispatched branch run writes to the same issues as the
scheduled run.

## Forced-drift proof

Proves the issue path end to end: one run opens one issue, a second run updates it, and no duplicate appears. Run it
after the workflow first reaches `main`, and again after any change to the upsert job or the issue title or marker.

1. Confirm no open issue exists for the source you will force:
   `gh issue list --label spec-drift --state open --json number,title`.
2. Cut a throwaway branch from `main` and pin a deliberately wrong value. A draft revision is the simplest:

   ```bash
   git switch -c chore/spec-drift-forced-proof origin/main
   # in src/data/standards/watch.yaml, change ietf-content-signals' pinned rev to "99"
   git commit -am "chore(standards): force spec drift for the poll proof"
   git push -u origin chore/spec-drift-forced-proof
   ```

3. Dispatch and wait: `gh workflow run spec-drift.yml --ref chore/spec-drift-forced-proof`, then
   `gh run list --workflow spec-drift.yml --limit 1` and `gh run watch <run-id> --exit-status`.
4. Observe one new issue titled `spec-drift: ietf-content-signals`, pinned `"99"`, observed the live revision, last
   observed on `chore/spec-drift-forced-proof`. The run summary reads `opened <url>`.
5. Dispatch again on the same branch and wait. Observe the run summary reads `updated #<n>`, the issue's last-observed
   run link changes, and `gh issue list --label spec-drift --state open` still lists exactly one issue for the source.
6. Restore: delete the branch (`git push origin --delete chore/spec-drift-forced-proof`, then
   `git branch -D chore/spec-drift-forced-proof`), and close the issue with a comment naming both run ids. The pin on
   `main` never changed, so the next scheduled run opens nothing for that source.
7. Record both run URLs and the issue number in the PR or release that called for the proof.

## Local run

```bash
GITHUB_TOKEN="$(gh auth token)" bun scripts/standards/check-drift.ts | jq '{status, drifted: [.drifted[].id]}'
```

The token is optional and goes to `api.github.com` only. Without it, the four GitHub-hosted sources read
unauthenticated.
