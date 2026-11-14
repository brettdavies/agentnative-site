---
artifact_contract: ce-unified-plan/v1
execution: code
product_contract_source: ce-plan-bootstrap
title: "The agent-native-cli skill as one hosted package on anc.dev, and the agentnative-skill repo retired - Plan"
type: feat
status: proposed
date: 2026-11-14
topic: hosted-skill-package
---

# The agent-native-cli skill as one hosted package on anc.dev, and the agentnative-skill repo retired - Plan

## Goal Capsule

- **Objective:** the `agent-native-cli` skill bundle is published once, as one versioned package on anc.dev with one name, one version, and one SHA-256 digest. The website (`/skill`, `/skill.json`, the well-known agent-skills index), the MCP server, WebMCP, and `anc skill install|update` all name that one package. The bundle stays whole, and `brettdavies/agentnative-skill` stops being a source.
- **Means:** the bundle's source moves into this repo at `skill/agent-native-cli/` (KTD1). The site build turns that tree into one deterministic `.tar.gz` and one package record, `/skill.json` (KTD4, KTD5). Every surface reads the record. The CLI downloads the archive the record names, checks its digest, and extracts it under fixed safety rules (KTD9 to KTD11). The skill repo gets one bridge release that points every git install at anc.dev, and is then retired (OD4).
- **Authority:** the Key Decisions, the decided rows, and the owner decisions bind. Seven owner decisions are open (OD1, OD2, OD3, OD4, OD7, OD8, OD10). Every unit is written for the recommended option, and § Option variants spells out every other option down to units, files, tests, verification, and operator steps. Requirements win on behavior, KTDs on mechanism, and units override neither.
- **Execution profile:**
  - Code, across four repos:
    - six site PRs (S1 to S6, plus S1b under OD10 (c));
    - one CLI PR (C1);
    - one skill-repo PR (K1);
    - one spec-repo PR (P1).
  - Each PR comes from a `feat/` or `fix/` branch cut from that repo's `dev` and is squash-merged to `dev`.
  - Three releases carry the change: a site release (R1), an `anc` release, and the skill repo's bridge release. A second site release (R2) carries S4.
  - § PR sequence fixes the order.
- **Stop conditions:**
  - Brett picks an option this plan does not describe: re-plan the affected units before building.
  - A package byte changes in a PR with no matching `VERSION` bump: stop. A version names exactly one digest (R2).
  - A PR would change a bundle file beyond the forced changes F1 to F9 and the testing-guidance commits (S1b under OD10 (c), or S1 under OD10 (a)): stop and report. The bundle stays whole except for changes the move forces and that one body of Brett's own pre-freeze work.
  - The deployed archive's SHA-256 differs from the record's digest on staging or production: stop the release and report. Do not re-deploy over it.
  - The CLI drift gate stays red on CLI `dev` longer than one working day after S3 merges: stop and report. The window is planned (Risks), but an open-ended one is not.
  - Production and staging stay read-only for every planning and build session. A session may send plain public GETs and nothing else.
- **Who finishes:**
  - Sessions build each PR and run the reviews its row names, then hand it to Brett, who approves every merge.
  - Each repo's release, the skill-repo freeze and archive, and every GitHub setting are Brett's (§ Operator steps).

---

## Product Contract

### Summary

The skill lives in its own repo today and installs by `git clone`. The site, the CLI, and the skill each carry their own copy of the facts about it: the site's `src/data/skill/skill.json`, the CLI's vendored fixture, and the skill's own `VERSION`, checked against GitHub `main`. After this plan, the bundle is a directory in this repo, and the site build makes one archive and one record from it. Agents and people reach the same bytes from every entry point, and a downloaded copy can be checked against the digest the record publishes.

### Problem Frame

- **Four places hold the same facts.** The skill's version lives in four places: the skill repo's `VERSION`, its GitHub release tag, `src/data/skill/skill.json`, and the CLI's verbatim copy of that file. Preflight checks two of them against each other (`scripts/release/preflight.sh:328-341`).
- **No integrity check.** The install is a `git clone --depth 1` of the default branch, so no digest names what a host received. A copy cannot be checked against anything published.
- **The bundle does not meet the skill specs.** Its `SKILL.md` description is 1,363 characters, while the Agent Skills spec and the Cloudflare discovery RFC allow 1,024. The MCP SDK's `validateSkillEntry` drops an entry that exceeds the limit, so the bundle cannot be listed in the well-known index or served over SEP-2640 as it stands.
- **The well-known index leaves it out.** anc.dev already serves `/.well-known/agent-skills/index.json`, and the skill is missing from it.
- **The repo split costs process.** Every skill change needs a skill-repo release, then a site manifest bump, then a site release. The skill repo has never had an issue filed, has no open PRs, and has no forks.

### Requirements

- R1. **One publication.** anc.dev publishes one package for the skill: name `agent-native-cli`, a version, and one SHA-256 digest over one archive. The following all name that version and digest:
  - `/skill.json`;
  - the well-known index entry;
  - `/skill` and `/skill.md`;
  - the MCP skills entry (S4);
  - the WebMCP tool (S5);
  - `anc skill install|update`.
- R2. **One version, one digest.** The bytes of a published version never change. A change to any package byte ships under a higher version.
- R3. **The bundle stays whole.** Every file a host loads at run time ships: `SKILL.md`, `VERSION`, `getting-started.md`, `references/`, `templates/`, `spec/`, `bin/check-update`, and the two license files. Only the forced changes F1 to F9 alter bundle bytes, and each names its reason. The one other change is the testing-guidance work Brett wrote before the freeze (OD10): S1b carries it under (c), and S1 imports it under (a). It is skill work in its own right, so it gets a skill review rather than a forced-change reason.
- R4. **The archive follows the Cloudflare discovery RFC v0.2.0 archive rules.** It is a gzip-compressed tar with the files at its root and `SKILL.md` at the root. It has no wrapper directory, no links, no `..` segments, and no absolute paths. The same tree always yields the same bytes.
- R5. **The record carries everything a consumer needs:**
  - the version;
  - the archive URL, digest, size, and media type;
  - per-file digests;
  - per-host destinations and install commands.
  It keeps every `/skill.json` schema_version 1 key and type and only adds keys (decided row D1).
- R6. **The well-known index lists the skill.** The entry is `agent-native-cli` with `type: archive`, the record's URL and digest, and the description from `SKILL.md`.
- R7. **`anc skill install|update <host>` installs the package.** It reads the record, downloads the archive, and checks the digest before anything reaches the destination. It extracts under the archive safety rules and swaps the result in with a rename. Failure reasons are typed in the existing envelope.
- R8. **Existing git installs keep working.** Every git-clone install reaches the hosted package through the update path it already has: a new `anc`, an older `anc`, a `git pull`, or the update-check prompt (§ Existing installs).
- R9. **The MCP server serves the skill (SEP-2640).** It answers `skills/list`, `skills/get`, `resources/read` of `skill://agent-native-cli/<path>`, and `resources/directory/read`, with files and digests equal to the archive's (S4, OD8).
- R10. **WebMCP returns the record's summary.** On the orientation paths and on `/skill`, one WebMCP tool returns the name, version, digest, archive URL, and install command.
- R11. **Release gates.**
  - Preflight refuses a release in two cases: the release build's package differs from production's under the same version, or the release build's version is lower than production's.
  - Postflight confirms that the served record, index entry, version pointer, and archive bytes agree.
- R12. **The skill repo retires.** It gets one bridge release, then OD4's disposition. Issues and documentation route to this repo.
- R13. **Gates move.** `skill-availability.yml` is removed. The CLI keeps a build-time host map from a vendored file that changes only when hosts or stable metadata change.
- R14. **Docs.** Every document in the four repos that names the skill's location, install, or version describes the present state once the move ships (the migration checklist in the Appendix).
- R15. **Skill versioning keeps its rules.** The skill's SemVer contract carries over into this repo's release documentation and applies to every PR that changes the package.

### Key Decisions

- **The site is the publisher.** The bundle's source, the archive, the record, and the release flow all live in `agentnative-site`, and the skill repo becomes read-only history. (Brett's brief: retire the standalone repo.)
- **The bundle ships whole.** Only changes the move forces, each with its reason. (Brett's brief.)
- **One record.** `/skill.json` is the record, and every other surface is a projection of it built in the same pass (KTD5).
- **Owner decisions stay open until Brett reads the reviewed plan.** Each one is worked out fully in § Option variants, so the implementation slot builds whichever option he picks without a replan.

### Scope Boundaries

**In scope:**

- The import.
- The forced bundle changes.
- The package builder and the record.
- `/skill` and its twin.
- The well-known index entry.
- Headers, release gates, and postflight checks.
- The CLI's download install.
- The skill repo's bridge release and retirement steps.
- The MCP skills extension.
- The WebMCP tool.
- Docs and issue routing in the four repos.

**Not in scope (each one tracked by prime as a follow-up):**

- **The Codex destination.** OpenAI's Codex docs place user skills at `$HOME/.agents/skills` (<https://developers.openai.com/codex/skills/>, read 2026-11-14). `src/data/skill/skill.json` and the CLI map `codex` to `~/.codex/skills/agent-native-cli`. This plan carries the existing destinations over unchanged.
- **The update-check path in `SKILL.md`.** `SKILL.md:37` runs `bash "$(dirname "$0")/bin/check-update"`. In an agent's shell `$0` is the shell, so the path resolves against the working directory, not the skill directory. The problem is in `SKILL.md`, not in `bin/check-update`. F4 (under OD8 (a) or (b)) rewrites the paragraph that holds this line, so a fix could ride along at no extra review or test cost. The move does not force it, so it stays out.
- **Links to files the bundle does not ship.** The vendored spec's principle files link to `spec/docs/badge.md`, `spec/docs/decisions/p1-behavioral-must.md`, and `spec/principles/AGENTS.md`. No consumer vendors those files, and `src/data/spec/` carries the same bytes. The fix belongs to the spec repo.
- **`message` and `next_step` on the CLI's skill error envelope.** The envelope of `anc skill install|update` carries `reason` alone for every reason it has today (`agentnative-cli` `src/skill_install.rs:307-322`), short of the global error contract. The reasons this plan adds join that envelope as it is, and U14's docs give each one a retry answer and the next command. Bringing the envelope to the contract is one change across every reason, old and new, so it is a CLI follow-up, not part of the move.

#### Deferred to Follow-Up Work

- **A `.zip` archive beside the `.tar.gz`.** RFC clients must support both formats, and the vercel CLI and the RFC both accept `.tar.gz`.
- **A Claude Code plugin marketplace entry.** `marketplace.json` supports an `archive` source (a zip over HTTPS); <https://code.claude.com/docs/en/plugin-marketplaces>, read 2026-11-14.
- **A skill entry in `/.well-known/ai-catalog.json`.** The ARD media types are a proposal.
- **A PR-gate check that a change under `skill/agent-native-cli/` bumps `VERSION`.** Preflight enforces R2 at release time (KTD8).
- **The spec's P8 pointer to the skill repo's `bin/check-update`.** That is spec text, and the archived repo still serves the file.

### Outstanding Questions

None beyond the open owner decisions.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Source path `skill/agent-native-cli/`, producer files beside it in `skill/`.**
  - **Why not `skills/<name>/`:** that path is the convention `gh skill install` and `npx skills` discover first. It would advertise an unversioned git channel out of this repo.
  - **Why not under `src/`:** `tsconfig.json`, `biome.json`, and `knip.json` scope `src/**`, so they would check `templates/tests/worker.test.ts` and the Rust and Python templates as site code.
  - **Discovery cannot be avoided:** `npx skills` falls back to a recursive repository search when no conventional path holds a skill (vercel-labs/skills `docs/creating-skills.md`), and `gh skill install` takes any exact path. So the committed tree is kept complete and equal to the package at every commit.
  - **What sits beside the package dir:** `skill/` holds the producer-side files a host never loads: `evals/`, `PRODUCT.md`, the frozen `CHANGELOG.md` covering 0.1.0 to 0.5.0, and `AGENTS.md`. Everything under `skill/agent-native-cli/` is package. Nothing outside it is.
- KTD2. **Squash import with provenance.**
  - The site repo allows squash merges only (`allow_merge_commit: false`, `allow_rebase_merge: false`) and requires signed commits on `dev` (`.github/rulesets/protect-dev.json`). So the skill repo's 72 commits cannot pass through the PR flow.
  - S1's commit body names the source repo and the frozen `origin/dev` SHA.
  - The archived repo keeps its history readable.
  - No issues to carry: none was ever filed, and no PRs are open.
- KTD3. **The bundle's `spec/` is committed, and one sync writes both copies.**
  - At spec 0.7.0, the skill's `spec/principles/*`, `spec/VERSION`, and `spec/CHANGELOG.md` are byte-identical to `src/data/spec/`. `spec/README.md` belongs to the skill only. `spec/reading-the-spec.md` is vendored too: the skill repo's sync generates it from the spec README's `## Reading the spec` section and points its relative links at the spec repo at the synced ref (`scripts/sync-spec.sh:251-269` there), and U3 ports that step.
  - `scripts/sync-spec.sh` writes both directories, and `tests/skill-spec-copy.test.ts` holds them byte-equal.
  - Copying at build time would leave the committed tree incomplete (KTD1).
  - A spec sync that changes the package needs a skill `VERSION` bump in the same PR (R2).
- KTD4. **A deterministic archive with no compressor in the identity path.**
  - **Tar layout:** ustar. Paths in byte order, files only (no directory entries). Mode `0644`, or `0755` when the file's git index mode is `100755`, which is `bin/check-update` alone. Modes come from the index, not the checkout, so a checkout's file modes cannot move the digest. uid and gid 0, empty uname and gname, mtime 0, two zero blocks at the end.
  - **Gzip layout:** stored deflate blocks of at most 65,535 bytes. Header mtime 0, XFL 0, OS byte 255. CRC-32 and ISIZE trailer.
  - **Why stored blocks:** the same tree yields the same bytes on any machine and under any Bun or zlib version. This repo's Bun pin follows the local Bun, so a compressor change would move the digest with no content change.
  - **Size:** at `origin/dev` the package is 33 files and 245,762 bytes, so the archive is about 274 KB. `gzip -9` would give about 78 KB. Both are far under every limit (SEP-2640: 512 files and 16 MiB; vercel: 50 MiB).
- KTD5. **One record, built in one pass.**
  - **The source:** `src/data/skill/skill.json` holds only stable fields: `schema_version`, `type`, `name`, `description`, `principles_url`, `license`, `destinations`, `uninstall`, `skill_page_html`.
  - **The builder:** `src/build/skill-package.mjs` reads that file, `skill/agent-native-cli/VERSION`, and the tree. It returns one in-memory record, and every emitter projects from it:
    - `dist/skill.json`;
    - the index entry;
    - `/skill` and `/skill.md`;
    - the version pointer;
    - the archive;
    - `dist/_internal/skill/agent-native-cli/**` (the file bytes the MCP server reads).
  - **No second copy of the version:** the bundle's `VERSION` is the only place it lives.
  - **The CLI fixture changes rarely:** the CLI vendors the source file (OD2 (a)), and the source changes only when hosts or stable metadata change.
- KTD6. **Per-file digests in the record.** `source.files` lists every package file as `{path, digest, size}`, sorted by path, with `digest` in the `sha256:<hex>` form SEP-2640 and the RFC use. The MCP entry is built from the same bytes and is tested equal to this list.
- KTD7. **Headers for the new file classes.**
  - **The archive:** `Content-Type: application/gzip`, no `Content-Encoding`, `Access-Control-Allow-Origin: *`, `X-Robots-Tag: noindex`. It is a single representation, so it never gets a markdown twin, a `Link: rel=alternate`, or `X-Llms-Txt`. Cache is `IMMUTABLE_CACHE` under OD3 (a) or (b), because a versioned name never changes bytes.
  - **The version pointer:** `Content-Type: text/plain; charset=utf-8`, `SHORT_CACHE`, CORS `*`, noindex, and it is never rewritten to a twin.
  - **Why no `Content-Encoding`:** a `Content-Encoding: gzip` on the archive would let a client decompress it in transit and fail the digest check. A test and postflight both pin its absence.
- KTD8. **Where R2 is enforced.**
  - **The PR gate:** `bun test` proves the build is deterministic. It also proves the record's digest equals the SHA-256 of the emitted archive, the record's version equals `VERSION`, and the index entry equals the record.
  - **Preflight's `build` group:** right after its `bun run build`, it compares that build's `dist/skill.json` with production's `/skill.json` (a plain public GET). Same version means same digest. A different digest means a strictly higher version, compared as SemVer. It reads only `version` and `source.digest`, and the digest covers the archive's bytes, not its URL, so the build's base URL never moves it. The gate sits in `build`, not `coord`, because `coord` never builds and `all` runs it first, so a `coord` gate would read whatever `dist/` the last checkout left.
  - **First run:** production's record has no `source.digest` yet, so the gate passes when the release version is higher than production's.
  - **Why release time:** staging sits behind Cloudflare Access with `noindex`, so production is the only public publication. Preflight runs before every release reaches it.
  - **Clean tree first:** the gate requires `git diff --quiet HEAD -- skill/agent-native-cli` and stops, naming the dirty paths, when it fails, so an uncommitted edit never stands in for the committed bytes. The build itself reads the working tree, so `bun run dev` still previews uncommitted skill edits.
- KTD9. **The CLI downloads with a spawned `curl`, then verifies and extracts in-process.**
  - **The spawn:** `curl` runs through `Command::args` with no shell. `-q` comes first so no `.curlrc` is read, then the protocol flags, then `--max-redirs 0 --fail --silent --show-error --max-filesize <record size> --max-time 60 --output <temp file>`. The protocol flags follow the validated URL: `--proto =https --proto-redir =https` for an `https://` URL, and `--proto =http --proto-redir =http` only for a loopback `http://` override (KTD10). Tests pin both vectors.
  - **Environment:** the git-specific stripping goes, and the user's proxy variables are kept.
  - **In-process steps:** SHA-256 via the `sha2` crate, gunzip via `flate2` (pure-Rust backend), and a ustar reader of about 120 lines.
  - **Rejected alternative:** turning on the `web` feature's ureq and rustls stack in the default build. It brings aws-lc-rs and a C toolchain into every release target for one download.
  - **Prerequisite:** `curl` replaces `git`. It ships with macOS, mainstream Linux distributions, and Windows 10 and later.
- KTD10. **The record URL is fixed, and the archive must come from the record's origin.**
  - `https://anc.dev/skill.json` is a constant.
  - `ANC_SKILL_RECORD_URL` overrides it. The override accepts `https://` URLs, plus `http://127.0.0.1` and `http://localhost` for tests, and nothing else. A loopback override is the only case in which curl may speak plain HTTP.
  - The archive URL must share the record's origin, or the install refuses with `record-invalid`. One origin stays the only root of trust, as GitHub's HTTPS is for the git clone.
- KTD11. **Archive safety rules, the same in the CLI, the site's tests, and the e2e reader.** Every rule below refuses with `package-invalid`:
  - entries are regular files only (typeflag `0` or NUL); a link, hard link, or any other type is refused;
  - paths are relative and `/`-separated; one that is absolute or contains `..`, a backslash, a NUL, or a duplicate is refused;
  - `SKILL.md` sits at the root with frontmatter `name: agent-native-cli`;
  - at most 512 files and 16 MiB unpacked, the SEP-2640 limits.
  The digest check runs before extraction, and extraction writes only inside a staging directory beside the destination.
- KTD12. **MCP via the SDK's `SkillsExtension.load` over an ASSETS adapter** (S4, under OD8 (a) or (b)).
  - **The adapter:** `src/worker/mcp/skills.ts` implements the SDK's `SkillFiles` interface (`list(dir)`, `read(path)`). Its root is the skills folder: `list('')` returns the `agent-native-cli` directory, deeper listings derive from the record's `source.files`, and `read(path)` fetches `/_internal/skill/<path>` through `env.ASSETS`. The SDK skips a `SKILL.md` at the adapter root, so the root cannot be the skill directory itself.
  - **Load options:** `strict: true`, plus a cache hint of 3,600,000 ms `public`, matching `resources/read`.
  - **Lifetime:** the dispatch shell in `src/worker/index.ts` loads the skills catalog beside `loadCatalog(env)`, and `getWarmSkills()` reads it, as `getWarmCatalog()` reads the tool catalog. Only a successful load is cached, as in `loadCatalog`, so a transient ASSETS miss retries on the next request. `createAncServer` attaches the catalog on each per-request server.
  - **Capabilities:** the catalog `load` returns implements `readDirectory` and `listResources`, so `attach` declares `{"io.modelcontextprotocol/skills": {"directoryRead": true}}`, registers `resources/directory/read`, and lists `skill://agent-native-cli/SKILL.md` in `resources/list`. `MCP_SERVER_CAPABILITIES` gains that same `extensions` value, so the card and both lanes declare what `attach` registers.
  - **No new tools:** the tools array and its 36,864-byte budget are untouched. `resources/templates/list` gains the skills template and `resources/list` gains the `SKILL.md` entry; the existing resources stay as they are.
- KTD13. **WebMCP: one orientation tool, `get_skill_package`.** It fetches `/skill.json` from its own origin when called and returns at most 1,500 characters (`WEBMCP_EXECUTE_MAX`): the name, version, digest, archive URL, install command, and `/skill`. It is registered on the orientation paths and on `/skill`.
- KTD14. **The bridge release's bundle bytes equal the hosted package's.** K1 copies `skill/agent-native-cli/` from the site's `main` at the commit R1 deployed into the skill repo's root. Every package file at the same relative path ends up byte-identical. A git install that pulls or re-clones the bridge holds the hosted version's package files byte for byte, plus the repo files U15 lists, which a host never loads.

### Decided from evidence

These rows were owner decisions until the evidence or the coordinating session settled them. They bind.

| # | Question | Decision | Evidence |
| --- | --- | --- | --- |
| D1 (was OD9) | `/skill.json` shape | Keep schema_version 1 keys and types. Values change: `source.type` becomes `archive`, `source.url` becomes the archive, `install.<host>` becomes `anc skill install <host>`, and `update` becomes `anc skill update <host>`. Keys are added: `source.digest`, `source.size`, `source.media_type`, `source.files`, `destinations`. | The global error contract says to add keys rather than rename or retype. Settled by agentnative-site-prime on 2026-11-14. The one known parser of the install strings is the CLI's `build.rs`, and C1 changes it either way. |
| D2 (was OD5) | The CLI dry-run envelope's `command` field | `command` becomes `anc skill install <host>` (or `anc skill update <host>`), so `eval $(anc skill install --dry-run <host>)` still works. The envelope adds `url`, `digest`, and `version`, read from the record. | Same contract; settled by agentnative-site-prime on 2026-11-14. A manual shell line in the CLI would duplicate the one the site renders on `/skill`. |
| D3 (was OD6) | Versions anc.dev serves | The current version only, under OD2 (a). OD2 (b) forces every released archive to stay served (§ Option variants, OD2 (b)). | Neither spec asks for history, and the RFC's change detection is digest-only. Settled by agentnative-site-prime on 2026-11-14. |
| D4 | History and issues | Squash import with provenance (KTD2). | Squash-only merges and signed `dev` on the site; 0 issues and 0 PRs on the skill repo. |
| D5 | Source path | `skill/agent-native-cli/` (KTD1). | Discovery conventions of `gh skill` and `npx skills`; the `tsconfig`, `biome`, and `knip` scopes. |

### Owner decisions

Brett reads these once the plan has passed its three reviews. Each row names the recommendation the units are written for. § Option variants works out every other option.

| # | Question | Options | Recommendation | Evidence |
| --- | --- | --- | --- | --- |
| OD1 | The first hosted version | (a) `0.6.0`; (b) `0.8.0`, matching the `anc` release C1 ships in; (c) `1.0.0` | (a) | The skill repo's `RELEASES.md` § What the contract is names the install root (a `git clone` of `main`) and the update check's remote as contract, so the move is a break. Before 1.0, a break moves the middle number. The v0.5.0 note "skill version pinned to anc version" lapsed when `anc` shipped 0.6.0 and 0.7.0 with no skill release. |
| OD2 | How `anc skill install|update` learns what to download | (a) At run time: it reads `https://anc.dev/skill.json` for the package fields, and destinations stay compiled in. (b) At build time: each `anc` release bakes one version's URL and digest. | (a) | (a) amends the CLI rule "no `skill.json` parsing in production" (`CLAUDE.md` § Skill Install Verb), but keeps that rule's purpose: the record cannot name a destination. (b) needs an `anc` release for every skill release and forces D3's alternative. |
| OD3 | Public URLs | (a) `/.well-known/agent-skills/agent-native-cli/<version>.tar.gz` with the version pointer at `/.well-known/agent-skills/agent-native-cli/VERSION`; (b) `/skill/agent-native-cli-<version>.tar.gz` and `/skill/VERSION`; (c) an unversioned `/.well-known/agent-skills/agent-native-cli.tar.gz`, purged on release | (a) | The RFC hosts skill files under `/.well-known/agent-skills/` by convention. A versioned name caches as immutable. Under (c), the 24-hour `s-maxage` can pair an old archive with a new digest until the purge lands (§ How the decisions combine). |
| OD4 | Disposition of `brettdavies/agentnative-skill` | (a) bridge release, then archive in place; (b) bridge, then delete; (c) bridge, then leave it unarchived with a moved notice; (d) archive with no bridge | (a) | Every released `anc` (0.5.x to 0.7.x) updates by re-cloning that repo's `main`. An archived repo stays cloneable, while a deleted one answers 404. 0 issues, 0 open PRs, 0 forks. |
| OD7 | List the third-party installer on `/skill` | (a) list `npx skills add https://anc.dev --skill agent-native-cli -g -a <agent> -y`; (b) do not list it | (a) | The vercel `skills` CLI reads the same index, checks the same digest, refuses link entries, and extracts the same archive. It runs third-party code on the reader's machine. Without `-g` and `-y` it installs into the current project and prompts for agents and install method (vercel-labs/skills `docs/commands.md`, read 2026-11-14). |
| OD8 | When the MCP server serves the skill, and at which server version | (a) S4 after the op-layer `0.2.0` release (stack plus PR9), with `MCP_SERVER_VERSION` `0.3.0`; (b) S4 inside the `0.2.0` release; (c) not now | (a) | SEP-2640 is Final, with the extension at Beta, and SDK 2.4.0 ships `ext/skills`. No tool is added. Under (b), the release that OD17 of the op-layer plan holds for PR9 would also wait on S4. None of the hosts `anc skill install` maps consumes skills over MCP today. |
| OD10 | The six local commits on `feat/testing-guidance` in the skill repo's prime checkout (`d85cb8e`, `057cbc7`, `9a7cf18`, `2d3d498`, `f36e61b`, `31e27f8`) and its uncommitted `.gitignore` edit | (a) merge them on the skill repo before the freeze, so S1 imports them; (b) discard them; (c) freeze now and carry them into the site after S1 as PR S1b | (c) | (c) lets the freeze start at once, and the work gets the same review and version rule as every later skill change. `origin/dev` already holds a testing guide. A `revert/pr-34-testing-guidance` branch shows an earlier round was reverted, so the content needs Brett's read either way. |

### How the decisions combine

- **OD2 with D3.**
  - Under OD2 (a), `anc skill update` installs whatever the record names, so only the current archive is served.
  - Under OD2 (b), every `anc` binary ever released installs the version it was built with. Each released archive must therefore stay served at its URL for as long as those binaries run. That is D3's alternative, worked out in § Option variants, OD2 (b).
  - OD2 (b) also changes the update-check text (F7): a newer skill needs a newer `anc`.
- **OD3 with cache and purge.**
  - **(a) and (b):** the archive URL is versioned, so it is cached as `IMMUTABLE_CACHE` and never purged. The release purge covers the mutable documents only: `/skill.json`, `/skill`, `/skill.md`, `/.well-known/agent-skills/index.json`, and the version pointer.
  - **The stale window under (a) and (b):** until the purge lands, a client can still read the old record or index. That record names the old versioned archive, which the edge still holds, so the client gets a valid older package and never a digest mismatch.
  - **The old archive after deploy:** D3 drops it from `dist`, so a cache miss on its URL answers 404 and the client re-reads the index. Immutable edge copies may serve it until they are evicted, and those bytes still match the old digest.
  - **(c):** the archive URL is mutable. It needs a new cache class, `public, max-age=60, s-maxage=300`, on the record, the index, the archive, and the version pointer, so a mismatch window lasts at most 5 minutes. The operator's manual purge covers six URLs right after deploy: the five that (a) purges, plus the archive. Postflight's digest check retries once, 30 seconds later.
- **OD4 with the bridge and the CLI's update path.**
  - Under (a) and (c), every released `anc` re-clones the bridge.
  - Under (b), a re-clone fails with `git-clone-failed`. `replace_bundle` puts the old install back, and the user stays on the old version until they install an `anc` that includes C1.
  - Under (d), there is no bridge: re-clones and `git pull` land on 0.5.0 forever, and the 0.5.0 `bin/check-update` keeps comparing against GitHub `main`, so it never prompts.
  - Under every option, an `anc` that includes C1 moves any install to the hosted package. § Existing installs has the full table.
- **OD4 with OD1 and OD3.**
  - The bridge tag and its `VERSION` take OD1's value.
  - The bridge's `bin/check-update` takes OD3's version-pointer URL.
  - The bridge's `references/update-check.md` takes OD2's upgrade instruction.
- **OD8 with the op-layer releases.**
  - S3 (the package) ships in R1 and does not depend on the op-layer plan.
  - Under (a), S4 is cut from `dev` after the op-layer `0.2.0` release (the stack plus PR9, per that plan's OD17). It ships in R2 at `MCP_SERVER_VERSION` `0.3.0`.
  - Under (b), S4 is stacked on the op-layer stack's top. It merges before that release is cut and ships at `0.2.0`, and the op-layer release then waits on S4 as well as PR9.
  - Under (c), S4 is not built, and F4 drops out of S2, because no copy is served over MCP.
- **OD8 with OD1.** F4 is a package byte change.
  - If Brett picks (a) or (b) before S2 is built, F4 rides S2 and the first hosted version covers it.
  - If OD8 is answered after R1 ships, F4 lands in S4 with a patch bump. Under the skill contract, the `SKILL.md` body wording is a `Changed` entry, so a patch.
- **OD10 with S1 and OD1.**
  - Under (a), S1 imports the merged commits from the skill repo's `dev`.
  - Under (c), S1b lands before S2, so the first hosted version includes them.
  - Under (b), nothing changes downstream.

### Public names this plan adds or changes

| Surface | Name | Change | Status |
| --- | --- | --- | --- |
| URL | `/.well-known/agent-skills/agent-native-cli/<version>.tar.gz` | new: the archive | OD3 |
| URL | `/.well-known/agent-skills/agent-native-cli/VERSION` | new: the version pointer `bin/check-update` reads | OD3 |
| `/skill.json` | `source.type`, `source.url`, `install.<host>`, `update` | values change (D1) | decided |
| `/skill.json` | `source.digest`, `source.size`, `source.media_type`, `source.files`, `destinations` | new keys (D1) | decided |
| Index | entry `agent-native-cli`, `type: archive` | new | decided |
| MCP | capability `extensions["io.modelcontextprotocol/skills"]` with `directoryRead: true`; `skills/list`, `skills/get`, `resources/directory/read`; resources `skill://agent-native-cli/<path>`, with `SKILL.md` in `resources/list`; one resource template | new (S4) | OD8 |
| MCP | `MCP_SERVER_VERSION` `0.3.0` | bump (S4) | OD8 |
| WebMCP | `get_skill_package` | new tool (S5) | decided |
| CLI | `ANC_SKILL_RECORD_URL` | new environment variable (C1) | OD2 |
| CLI | envelope keys `url`, `digest`, `version` | new (D2) | decided |
| CLI | reasons `curl-not-found`, `download-failed`, `digest-mismatch`, `package-invalid` | new | decided: both OD2 options download |
| CLI | reasons `record-unreadable`, `record-invalid` | new | OD2 (a) |
| CLI | reasons `git-not-found`, `git-clone-failed` | removed; a breaking change, so `anc` 0.8.0 moves the middle number | decided: both OD2 options drop git |
| CLI | `destination_status` value `current` | new: `anc skill update` answers `status: "success"` and exits 0 when the installed `VERSION` equals the baked one | OD2 (b) only |
| CLI | `ANC_SKILL_TEST_PIN` | new, read only in debug builds and only for a loopback URL: the OD2 (b) test seam | OD2 (b) only |
| Release script | `PRODUCTION_URL` (default `https://anc.dev`) | new `scripts/release/preflight.sh` environment variable, beside `STAGING_URL` and `LOCAL_URL`, so the gate tests can stub production | decided |
| Bundle | `bin/check-update` default remote | becomes OD3's version pointer | OD3 |
| Bundle | `VERSION` | `0.5.0` to OD1's value | OD1 |

### The package

- **Tree:** every tracked file under `skill/agent-native-cli/`. Today that is 33 files:
  - `SKILL.md`, `VERSION`, `LICENSE-MIT`, `LICENSE-APACHE`, `bin/check-update`, `getting-started.md`;
  - `references/` (6 files);
  - `templates/` (8 files, `templates/tests/` included);
  - `spec/`: `CHANGELOG.md`, `README.md`, `VERSION`, `reading-the-spec.md`, and `principles/` (9 files).
  The skill repo's `spec/.markdownlint-cli2.yaml` is not imported. The site's own markdownlint config takes over its job (U2).
- **Archive:** `<version>.tar.gz` under OD3 (a), built per KTD4, `Content-Type: application/gzip`.
- **Version pointer:** the bytes of `skill/agent-native-cli/VERSION` (one SemVer line and a newline), served at OD3's URL.
- **Record:** `dist/skill.json`, pretty-printed with sorted keys and kept byte-stable (`PRESERVE_PRETTY`, `src/build/12-minify-dist.mjs`). Under the recommended options (the figures are those of `origin/dev` before F1 to F9):

```json
{
  "description": "<the record's one-sentence description>",
  "destinations": {
    "claude_code": "~/.claude/skills/agent-native-cli",
    "codex": "~/.codex/skills/agent-native-cli",
    "cursor": "~/.cursor/skills/agent-native-cli",
    "factory": "~/.factory/skills/agent-native-cli",
    "kiro": "~/.kiro/skills/agent-native-cli",
    "opencode": "~/.config/opencode/skills/agent-native-cli"
  },
  "install": { "claude_code": "anc skill install claude_code", "...": "one per destination" },
  "license": "MIT OR Apache-2.0",
  "name": "agent-native-cli",
  "principles_url": "https://anc.dev/p1",
  "schema_version": 1,
  "skill_page_html": "https://anc.dev/skill",
  "source": {
    "digest": "sha256:<64 lowercase hex>",
    "files": [{ "digest": "sha256:<hex>", "path": "LICENSE-APACHE", "size": 10759 }, "..."],
    "media_type": "application/gzip",
    "size": 273963,
    "type": "archive",
    "url": "https://anc.dev/.well-known/agent-skills/agent-native-cli/0.6.0.tar.gz"
  },
  "type": "agent-skill",
  "uninstall": "rm -rf <install-dir>",
  "update": "anc skill update <host>",
  "version": "0.6.0"
}
```

- **Index entry:** `{"name": "agent-native-cli", "type": "archive", "description": <the SKILL.md frontmatter description>, "url": source.url, "digest": source.digest}`, added to the existing `$schema` 0.2.0 index beside `anc-mcp` and the `web-audit-fix-*` entries.
- **MCP file bytes:** `dist/_internal/skill/agent-native-cli/<path>`, a copy of each package file. The existing `/_internal/*` guard keeps it private.

### Forced bundle changes

Each change below is forced by the move. Nothing else in the bundle changes.

| # | File | Change | Why it is forced |
| --- | --- | --- | --- |
| F1 | `SKILL.md` frontmatter `description` | Cut from 1,363 to at most 1,024 characters, keeping every trigger term the skill is found by (draft in U4) | The Agent Skills spec and the RFC index allow 1,024 at most. The SDK's `validateSkillEntry` drops a longer entry. The skill contract treats the wording as non-contract "while it keeps the skill findable". |
| F2 | `SKILL.md:190` | The `--dry-run` comment "print resolved git command without spawning" now describes the D2 dry run | C1's install runs no git. |
| F3 | `SKILL.md:203` | The "`agentnative-skill`: this repo (MIT)" source line points at `https://anc.dev/skill` and the source directory in `brettdavies/agentnative-site` | The repo is retired. |
| F4 | `SKILL.md` § First action: update check | One sentence: "If you read this file through a `skill://` URI, skip the update check: the server always serves the current version." The test is how the file was read, because the server also lists `bin/check-update` as a resource, and `$(dirname "$0")` can match a project's own `bin/` | SEP-2640 forbids served content from causing host-side execution without per-skill approval. A served copy has no local script, and an update check means nothing for it. Applies under OD8 (a) or (b) only. |
| F5 | `getting-started.md:80-81, 91-92, 107` | The dry-run comments describe D2. The manual fallback becomes the verifying download from `/skill`. The skill-bundle issue link goes to the site repo's issue chooser. | The git clone and the repo go away. |
| F6 | `bin/check-update:22-23, 30` | The default `REMOTE_URL` becomes OD3's version pointer, and the comment says the bundle installs from the anc.dev package | The GitHub `main` copy freezes once the repo is retired. |
| F7 | `references/update-check.md` | The first paragraph (line 3) and the `UPGRADE_AVAILABLE` row (line 12, "A newer release is on `main`") name the anc.dev version pointer. "Yes, upgrade now" runs `anc skill update <host>`, where `<host>` is the slug whose destination equals this bundle's root, from a six-row table of `destinations` (`~/.claude/skills/agent-native-cli` is `claude_code`, and so on). It never runs `--all`, which installs a fresh copy into every host that lacks one. Under OD7 (a), a copy `npx skills` installed updates with `npx skills update -g -y` instead. When `VERSION` then does not equal the version the prompt named, `anc` predates the hosted package (an older `anc` re-clones the bridge, which leaves `VERSION` unchanged or lower), so upgrade `anc` first (`brew upgrade agentnative` or `cargo install agentnative`) and run it again. Hosts `anc` does not map get the manual line on `https://anc.dev/skill`. The `git pull` instruction goes. | A hosted install has no `.git`, so `git pull` fails. |
| F8 | `spec/README.md`: the resync section and the Layout row for `.markdownlint-cli2.yaml` | The resync section names `scripts/sync-spec.sh` in `brettdavies/agentnative-site`, which writes both copies and generates `reading-the-spec.md` (KTD3). The Layout row goes. The text names the repo, because the same bytes ship in the archive, where "this repo" names nothing, and in the bridge, where it names the wrong repo. | The skill repo's sync script goes away, and the import leaves out the file the row describes (§ The package). |
| F9 | `VERSION` | `0.5.0` to OD1's value | R2: the package bytes change. |

### Existing installs

How each kind of install reaches the hosted package. "C1 `anc`" means an `anc` release that includes C1 (0.8.0 under OD1 (a)). "Older `anc`" means 0.5.x to 0.7.x.

| Install today | What runs next | Result under OD4 (a) and (c) | Under (b) | Under (d) |
| --- | --- | --- | --- | --- |
| Any git install | `anc skill update <host>` with a C1 `anc` | `holds_bundle` passes, the install moves aside, the package is downloaded, checked, and extracted, and the rename swaps it in. `.git` is gone, and local edits are lost, as with a re-clone today. | same | same |
| Any git install | `anc skill update <host>` with an older `anc` | Moves aside, then a hardened `git clone` of `main` lands the bridge: the hosted package files, plus `.git` and the repo files U15 lists | `git-clone-failed`; `replace_bundle` restores the install | lands 0.5.0 again |
| A 0.5.0 git install that never updated | its `bin/check-update` compares GitHub `main`'s `VERSION` | `UPGRADE_AVAILABLE 0.5.0 0.6.0`, then the 0.5.0 instruction `git -C <dir> pull --ff-only` lands the bridge | the fetch fails, so the check stays silent forever | `main` stays 0.5.0, so the check stays silent forever |
| A bridge install, once a newer hosted version ships | the bridge's `bin/check-update` reads the anc.dev pointer | prompt; the bridge's F7 text runs `anc skill update <host>`; an older `anc` re-clones the bridge, so `VERSION` does not equal the prompted version, and F7 says to upgrade `anc` first | n/a | n/a |
| A manual clone with local edits | `git pull --ff-only` | refused, and the error is shown verbatim, as the 0.5.0 text already says | n/a | n/a |
| A hosted install (C1 `anc`) | `bin/check-update` reads the anc.dev pointer, then `anc skill update` | the next hosted version | same | same |
| A copy served over MCP (S4) | F4 skips the check | the server serves the current version | same | same |

A fresh `anc skill install` on an older `anc` after the archive clones the bridge under (a) and (c), fails under (b), and lands 0.5.0 under (d).

### The skill release flow inside the site's release flow

1. **The PR.** A PR that changes anything under `skill/agent-native-cli/` bumps `skill/agent-native-cli/VERSION` by the skill's SemVer contract. That contract moves, nearly verbatim, into `RELEASES.md` § Skill releases, with one change: the install-root contract becomes the archive and its root `SKILL.md`. The PR files its change in the PR body's `## Changelog` section and uses the commit scope `skill`, as in `feat(skill): ...` or `fix(skill): ...`.
2. **Staging.** Merging to `dev` deploys the candidate package to staging, which sits behind Cloudflare Access.
3. **Preflight.** The release from `dev` to `main` (`RELEASES.md` § Releasing dev to main) runs `scripts/release/preflight.sh`:
   - the `build` group's package-identity gate (KTD8), run on the build that group just made, against production's `/skill.json`;
   - the `dist` group, which compares the deployed release build on staging with source: the served record's version and the served archive's SHA-256.
4. **Deploy and purge.** After the deploy, the operator purges `/skill.json`, `/skill`, `/skill.md`, `/.well-known/agent-skills/index.json`, and the version pointer through the Cloudflare API, per `RELEASES.md` § Skill releases. The purge stays a manual step with its token in 1Password; no repo script calls `purge_cache`. Postflight's `purge` group then checks that:
   - the served record's version equals the release build's;
   - the archive at `source.url` hashes to `source.digest`, with no `Content-Encoding`;
   - the index entry equals the record;
   - the version pointer equals the version.
5. **MCP smoke.** Once S4 ships, the MCP smoke checks that `skills/list` lists `skill://agent-native-cli/SKILL.md` with resources equal to `source.files`.

The skill gets no GitHub releases or tags of its own. Its version lives in its `VERSION`, its release notes are the site release's `skill`-scoped bullets, and the `/changelog` page shows them.

### High-Level Technical Design

```text
skill/agent-native-cli/**            src/data/skill/skill.json (stable fields)
          \                             /
           src/build/skill-package.mjs   one pass: walk, read bytes, digest each file,
           |                             tar (ustar), gzip (stored blocks), digest the archive
           v
      package record (in memory): version, source{type,url,digest,size,media_type,files},
                                  destinations, install, update
           |
   +-------+-----------+------------------+----------------------+-----------------------------+
   v                   v                  v                      v                             v
dist/skill.json   index.json entry   /skill + /skill.md   dist/.well-known/agent-skills/   dist/_internal/skill/
                                                          agent-native-cli/{<v>.tar.gz,     agent-native-cli/**
                                                          VERSION}
   |                                                                                      |
   +--> anc skill install|update (C1): GET record, GET archive, sha256, extract, rename     |
   +--> WebMCP get_skill_package (S5): GET record                                         |
   +--> MCP SkillsExtension (S4): record + _internal bytes via ASSETS  <-------------------+
```

### Assumptions

- **Workers Static Assets serves a `.tar.gz` byte for byte.** The Worker's header policy then sets the type, and U9 and postflight check that no encoding is applied.
- **`curl` is where `anc` runs.** It is preinstalled on macOS, mainstream Linux distributions, and Windows 10 and later. Where it is missing, the install reports `curl-not-found`, as `git-not-found` is reported today.
- **The skill repo stays frozen from O3 until K1 merges.**

### Risks

| Risk | Mitigation |
| --- | --- |
| Every CLI PR fails the drift gate from S3's merge until C1 merges, because the fixture is a verbatim copy of site `dev`'s `src/data/skill/skill.json` | C1 is built and reviewed in advance against S3's branch (`SKILL_SITE_REF=<S3 branch> scripts/sync-skill-fixture.sh`). S3 merges, then C1 merges straight after. Stop condition: one working day. |
| The edge or a client decompresses the archive in transit, and the digest check fails | KTD7 sets no `Content-Encoding`; U9 tests it on the local Worker; postflight checks it on production |
| A builder change moves the archive bytes with no content change | `tests/build-skill-package.test.ts` pins a golden digest for a fixed fixture tree, so any byte change in the builder fails the PR gate |
| A skill change merges to `dev` without a `VERSION` bump | Preflight refuses the release (KTD8). Staging, where it shows first, is not public. |
| A git install with local edits loses them on `anc skill update` | Unchanged from today: the update re-clones in place. The `/skill` page and the CLI's help say that update replaces the directory. |
| The first R1 deploy serves the old v1 `/skill.json` from cache for up to 24 hours | The existing purge step in `RELEASES-POSTFLIGHT.md` runs; postflight checks the served version |
| Between R1 and the `anc` 0.8.0 and bridge releases, an older `anc` still clones the skill repo's 0.5.0 `main` | `/skill` names the minimum `anc` version and gives the `anc --version` check (U10); O6 runs in the same operator session, right after R1's postflight, and K1 follows; nothing breaks, the window only delays the hosted bytes |
| The vercel extractor keeps file content but drops modes | `SKILL.md` already runs `bash .../bin/check-update`, so the mode does not matter |

### Documentation and operational notes

- **This repo, edited together with the code that changes the contract:**
  - `DESIGN.md` §3.9;
  - `RELEASES.md` § Skill releases (with the skill's SemVer contract) and § Skill-availability probe (removed);
  - `RELEASES-PREFLIGHT.md`, `RELEASES-POSTFLIGHT.md`, `RELEASES-RATIONALE.md`;
  - `AGENTS.md` § Structure and § MCP server.
- **This repo, in S6:** `README.md`, `CONTRIBUTING.md`, `content/contribute.md`, `BRAND.md`, `scripts/SYNCS.md`, `scripts/prose-check.sh`'s channel list, `src/data/spec/README.md:93`, and the issue templates.
- **The CLI:** `CLAUDE.md` § Skill Install Verb, `AGENTS.md`, `README.md`, the `RELEASES*.md` files, and the issue routing, all in C1.
- **The spec repo:** issue routing and channel lists, in P1.
- **Solutions:** `best-practices/agentnative-version-model-2026-05-01.md` (the skill row) is refreshed through `sd-commit-doc` after R1.

---

## Implementation Units

### Unit Index

| Unit | Title | Files | Depends on |
| --- | --- | --- | --- |
| U1 | Import the bundle tree | `skill/**` | O3 (and O2 under OD10 (a)) |
| U2 | The site's gates around the tree | `bunfig.toml`, `.markdownlint-cli2.yaml`, `scripts/prose-check.sh`, `tests/skill-source.test.ts` | U1 |
| U3 | One spec sync for both copies | `scripts/sync-spec.sh`, `tests/skill-spec-copy.test.ts` | U1 |
| U3b | Carry the testing-guidance commits (OD10 (c) only) | `skill/agent-native-cli/references/`, `skill/agent-native-cli/templates/`, `skill/evals/`, `SKILL.md` | U1 |
| U4 | Description within 1,024 characters (F1) | `skill/agent-native-cli/SKILL.md`, `tests/skill-source.test.ts` | U2 |
| U5 | Install and update prose (F2 to F5, F7) | `SKILL.md`, `getting-started.md`, `references/update-check.md` | U4 |
| U6 | Update-check remote, spec resync note, version (F6, F8, F9) | `bin/check-update`, `spec/README.md`, `VERSION`, `tests/skill-check-update.test.ts` | U4 |
| U7 | Deterministic package builder | `src/build/skill-package.mjs`, `src/build/build.mjs`, `tests/build-skill-package.test.ts`, `tests/helpers/ustar.ts` | U6 |
| U8 | The record | `src/data/skill/skill.json`, `src/build/skill.mjs`, `src/build/08-scorecards-emit.mjs`, `tests/build.test.ts`, `tests/regression.test.ts` | U7 |
| U9 | Index entry, headers, `llms.txt`, JSON-LD | `src/build/11a-discovery-emit.mjs`, `src/worker/headers.ts`, `src/build/09-llms-emit.mjs`, `src/build/shell.mjs`, tests | U8 |
| U10 | `/skill`, its twin, and the skill e2e project | `src/build/skill.mjs`, `src/build/08-scorecards-emit.mjs`, `tests/e2e/skill.e2e.ts`, `tests/build.test.ts` | U8 |
| U11 | Release gates and the release documents | `scripts/release/{preflight,postflight}.sh`, `tests/preflight-release-gates.test.ts`, `.github/workflows/skill-availability.yml` (deleted), `RELEASES*.md`, `DESIGN.md`, `AGENTS.md` | U9, U10 |
| U12 | CLI: record, download, verification, extraction | `src/skill_install.rs`, `src/skill_install/archive.rs`, `Cargo.toml`, `tests/skill_install.rs` | site S3 on `dev` |
| U13 | CLI: host map from `destinations`, fixture resync | `build.rs`, `src/skill_install/skill.json` | U12 |
| U14 | CLI: envelope, reasons, docs | `src/skill_install.rs`, `src/cli.rs`, `CLAUDE.md`, `AGENTS.md`, `README.md`, `RELEASES*.md`, `.github/ISSUE_TEMPLATE/config.yml` | U12, U13 |
| U15 | Skill repo: bridge release | the skill repo's bundle files, `README.md`, `.github/ISSUE_TEMPLATE/`, `scripts/release/preflight.sh` | R1 on anc.dev |
| U16 | MCP skills extension | `src/worker/mcp/skills.ts`, `src/worker/index.ts`, `src/worker/mcp/server.ts`, `src/shared/mcp-discovery.ts`, `src/worker/mcp/instructions.ts`, `content/mcp-skill.md`, `scripts/release/mcp-smoke.sh`, tests | OD8 |
| U17 | WebMCP `get_skill_package` | `src/client/webmcp-orientation.ts`, `src/client/webmcp-lib.ts`, `src/build/08-scorecards-emit.mjs`, `tests/webmcp.test.ts`, `tests/build.test.ts` | U8 |
| U18 | Site references and issue routing | `README.md`, `CONTRIBUTING.md`, `content/contribute.md`, `BRAND.md`, `scripts/SYNCS.md`, `scripts/prose-check.sh`, `src/data/spec/README.md`, `.github/ISSUE_TEMPLATE/`, `skill/AGENTS.md` | U11 |
| U19 | Spec repo routing and channel lists | spec repo `.github/ISSUE_TEMPLATE/`, `README.md`, `AGENTS.md`, `BRAND.md`, `RELEASES.md`, `docs/architecture/voice-enforcement.md` | O7 |

### PR sequence

| Order | PR | Repo | Units | Waits on | Release it needs | Reviews |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S1 | site | U1 to U3 | O2, O3 | none: nothing served changes | `ce-code-review` |
| 1b | S1b | site | U3b | S1 (OD10 (c) only) | none | `ce-code-review` |
| 2 | S2 | site | U4 to U6 | S1 (and S1b) | rides R1 | `ce-code-review`, `/devex-review` (the install and update instructions and the update prompt are setup steps an agent follows) |
| 3 | S3 | site | U7 to U11 | S2, with C1 ready for review | R1: the site release from `dev` to `main` carrying S1 to S3, S5, and S6 | `ce-code-review`, `/devex-review` (new URLs, the record shape, `/skill`, the release commands), `/cso` (the download, integrity, and headers on an artifact that hosts execute) |
| 4 | S5 | site | U17 | S3 | rides R1 | `ce-code-review`, `/devex-review` (a new WebMCP tool's output) |
| 5 | S6 | site | U18 | S3 | rides R1 | `ce-code-review` |
| 6 | C1 | CLI | U12 to U14 | S3 merged to site `dev` (the drift gate) | `anc` 0.8.0, cut after R1 is live on anc.dev | `ce-code-review`, `/devex-review` (changed verbs, envelope, reasons, prerequisite), `/cso` (download, digest check, extraction of untrusted bytes, a new environment variable) |
| 7 | K1 | skill | U15 | R1 live on anc.dev | the skill repo's release of the bridge (`v0.6.0` under OD1 (a)) | `ce-code-review`, `/devex-review` (the update path for every git install) |
| 8 | O7 | skill | archive | K1 released | none | none: an operator step, no diff |
| 9 | P1 | spec | U19 | O7 | none: docs only; spec releases trigger on principles or `VERSION` | `ce-code-review` |
| 10 | S4 | site | U16 | OD8 (a): the op-layer `0.2.0` release on `main` | R2: the next site release | `ce-code-review`, `/devex-review` (a new MCP capability and methods), `/cso` (`resources/read` and `resources/directory/read` on caller-supplied URIs against ASSETS) |

Every review runs one round on Opus, with its verdict in a PR comment and its start and end logged in this plan's Review log.

### S1: Import

#### U1. Import the bundle tree

- **Goal:** the bundle lives in this repo byte-identical to the skill repo's `origin/dev` at the frozen SHA (R3, KTD1, KTD2).
- **Requirements:** R3, R14.
- **Files:**
  - `skill/agent-native-cli/`: the package. `SKILL.md`, `VERSION`, `LICENSE-MIT`, `LICENSE-APACHE`, `bin/check-update` with mode `100755`, `getting-started.md`, `references/`, `templates/`, and `spec/` without its `.markdownlint-cli2.yaml`.
  - `skill/`: `evals/`, `PRODUCT.md`, `CHANGELOG.md` (the frozen 0.1.0 to 0.5.0 record).
- **Approach:**
  - `git -C <skill clone> archive <frozen sha> <paths> | tar -x -C skill/agent-native-cli`, then move `evals/`, `PRODUCT.md`, and `CHANGELOG.md` up into `skill/`.
  - The commit body names `https://github.com/brettdavies/agentnative-skill` and the frozen SHA.
  - No byte changes in this PR.
- **Test scenarios:** in `tests/skill-source.test.ts` (U2).
- **Verification:** `git diff --no-index` shows each imported file byte-equal to `git show <frozen sha>:<path>` (a scripted loop, quoted in the PR body).

#### U2. The site's gates around the tree

- **Goal:** the tree sits in the repo without the site's gates checking it as site code, and the gates that should cover it do.
- **Requirements:** R3.
- **Files:**
  - `bunfig.toml`: `[test] pathIgnorePatterns = ["skill/**", "dist/**"]`. The second pattern matters from S3 on: U7 copies `templates/tests/worker.test.ts` into `dist/_internal/skill/`, the build runs before the tests, and Bun 1.4.4 collects a test file under `dist/` that `skill/**` does not cover.
  - `.markdownlint-cli2.yaml`: `ignores` gains `skill/agent-native-cli/spec/CHANGELOG.md` and `skill/CHANGELOG.md`, the way `src/data/spec/CHANGELOG.md` is ignored.
  - `scripts/prose-check.sh` (its site-local divergence block): `skill/` joins the `src/data/spec/` exclusion in the changed-only filter (line 181) and the full-scope `find` (line 198). Measured 2026-11-14 on a scratch import of the frozen tree, the gate reports 120 blocking findings in 15 files: 99 `Vale.Spelling` hits on tool and crate names such as `argparse`, `yargs`, `oclif`, and `serde`, 9 `proselint.Cliches` hits, and 6 LanguageTool grammar hits. Fixing any of them changes imported bytes (R3), so the imported tree is excluded the way the vendored spec is. S2's reviews read the F1 to F9 prose instead.
  - `tests/skill-source.test.ts`.
- **Approach:**
  - `biome.json`, `tsconfig*.json`, `knip.json`, and Playwright already scope away from `skill/`. The test pins that.
  - The bundle's markdown is linted under the site's root config. Its rules are the skill repo's canonical set plus `MD060: false`, and the bundle, `evals/`, and `PRODUCT.md` lint clean under it today (0 issues in 27 files, checked 2026-11-14). A finding that appears at import time stops the PR: fixing it would change bundle bytes.
- **Test scenarios:**
  - Every path under `skill/agent-native-cli/` is a regular file, with no symlink and no dotfile.
  - Every path is ASCII and at most 100 bytes long, so it fits the ustar `name` field with no prefix.
  - The executable set equals `git ls-files -s skill/agent-native-cli` mode `100755`, which is `bin/check-update` alone.
  - At most 512 files and 16 MiB in total.
  - `SKILL.md` frontmatter `name` equals the directory name.
  - `bunfig.toml` ignores `skill/**` and `dist/**`.
  - `scripts/prose-check.sh` excludes `skill/` from both of its file lists.
  - `biome.json` `files.includes`, `tsconfig.json` `include`, and `knip.json` `project` contain no pattern that matches `skill/`.
- **Verification:**
  - Run `bun test` before the `bunfig.toml` change. It collects `skill/agent-native-cli/templates/tests/worker.test.ts` and fails, and that failure is quoted in the PR body.
  - After the change: `bun run build`, `bun test`, `bun run lint`, and `bun run typecheck` all pass.

#### U3. One spec sync for both copies

- **Goal:** the bundle's vendored spec and the site's stay byte-equal (KTD3).
- **Requirements:** R2, R3.
- **Files:** `scripts/sync-spec.sh`, `tests/skill-spec-copy.test.ts`, `src/data/spec/README.md` (the sync section only).
- **Approach:**
  - `sync-spec.sh` writes `VERSION`, `CHANGELOG.md`, and `principles/*.md` to both `src/data/spec/` and `skill/agent-native-cli/spec/`. Stale orphans are removed in both, the way the existing script handles them.
  - Its flags and output stay as they are.
  - `spec/README.md` is not touched, because it is skill-only.
  - `spec/reading-the-spec.md` is generated into the bundle copy only, as the skill repo's sync generates it: the spec README's `## Reading the spec` section, from its heading to the next level-2 heading, with each relative link rewritten to `https://github.com/<spec repo>/blob/<resolved ref>/<path>`. `src/data/spec/` has no counterpart.
- **Test scenarios:**
  - For every file in `src/data/spec/principles/`, plus `VERSION` and `CHANGELOG.md`, the bundle copy is byte-equal.
  - The two `principles/` directories hold the same set of names.
- **Verification:** edit one byte in `skill/agent-native-cli/spec/principles/p1-*.md` and the test fails (quoted). Run `scripts/sync-spec.sh --ref v0.7.0` and the tree has no diff, `reading-the-spec.md` included. Delete `reading-the-spec.md`, run the sync again, and the file comes back byte-identical.

### S1b: Testing guidance (OD10 (c) only)

#### U3b. Carry the testing-guidance commits

- **Goal:** Brett's six local commits land in the bundle through the site's review flow.
- **Files:** whatever the commits touch, mapped the way U1 maps the import. Paths outside the bundle and the producer files are dropped.
- **Approach:**
  - Brett exports the patches from the skill prime checkout with `git format-patch origin/dev..feat/testing-guidance` (O2). The building session reads them; it does not check out the skill prime.
  - The session applies them with `git am` in a scratch clone of the skill repo at the frozen SHA, where their paths resolve as written. Applying them in this repo with `git am --directory=skill/agent-native-cli` would fail on any patch that edits `evals/`, `PRODUCT.md`, or `CHANGELOG.md`, which U1 moved up into `skill/`.
  - It carries the result over with U1's mapping. `git diff --name-status <frozen sha>..HEAD` in the scratch clone names every changed path, deletions and renames included. Bundle paths land under `skill/agent-native-cli/`. `evals/`, `PRODUCT.md`, and `CHANGELOG.md` land under `skill/`. Any other path, such as a `docs/` or `scripts/` file, is dropped and listed in the PR body.
  - S1b is one squash commit, like S1, and its body names the six source SHAs.
  - No `VERSION` change here: S2 sets the first hosted version.
  - If a carried commit touches the `SKILL.md` frontmatter, U4 measures its description on S1b's tree, not S1's.
- **Test scenarios:** `tests/skill-source.test.ts` and `tests/skill-spec-copy.test.ts` stay green, so no carried path breaks a package rule.
- **Verification:** the PR body lists each source commit SHA, the resulting paths, and the dropped paths.

### S2: Forced bundle changes

#### U4. Description within 1,024 characters (F1)

- **Goal:** the bundle meets the Agent Skills description limit, so the index and the SDK accept it.
- **Requirements:** R3, R6, R9.
- **Files:** `skill/agent-native-cli/SKILL.md` (frontmatter only), `tests/skill-source.test.ts`.
- **Approach:** replace the description with the draft below (1,006 characters, measured on the YAML-parsed value). The implementer may adjust the wording, under three rules:
  - it keeps every trigger term but four: `CLI standard` and `CLI for agents` duplicate other terms, `anc` is a prefix of the four `anc ...` terms that stay, and `audit-profile` stays in the prose as `--audit-profile human-tui`; the two markdown link targets also go, and their names stay as plain text;
  - it keeps the literal `scorecard schema 0.9`, which the version model treats as a hand-edited literal;
  - it stays at or under 1,024 characters.

  > Guide to designing, building, and auditing CLI tools for use by AI agents. Pairs with `anc` (the compliance auditor) and the agentnative spec (vendored at `spec/`). Provides starter templates, idioms for Rust/clap, Python Click and argparse, Go Cobra, JS Commander/yargs/oclif, and Ruby Thor, and a getting-started guide for `anc audit --output json` (scorecard schema 0.9) and `anc skill install <host>`. Use when designing a new CLI tool, building a Rust/clap binary for agents, reviewing one for agent-readiness, claiming the agent-native badge (≥70% credit-weighted score), or remediating `anc` findings. Triggers on agentic CLI, agent-native, CLI design, agent-first, agent-friendly CLI, CLI compliance, agent-readiness, anc audit, anc emit schema, anc skill install, anc skill update, agent-native badge, scorecard, audit_id, opt_out, n_a, Rust CLI, clap derive. SKIP for a TUI app meant for humans (use `--audit-profile human-tui`), a non-CLI library, or Rust questions unrelated to agent-readiness.

- **Test scenarios:**
  - The parsed `description` is 1 to 1,024 characters.
  - `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and is at most 64 characters.
  - The frontmatter holds only keys the Agent Skills spec defines.
- **Verification:** the length test fails on S1's tree at 1,363 characters (quoted).

#### U5. Install and update prose (F2, F3, F5, F7, and F4 under OD8 (a) or (b))

- **Goal:** the bundle's instructions describe the hosted install and update.
- **Requirements:** R3, R8.
- **Files:**
  - `skill/agent-native-cli/SKILL.md`: line 190, line 203, and § First action under OD8 (a) or (b).
  - `skill/agent-native-cli/getting-started.md`: lines 80 and 81, 91 and 92, and 107.
  - `skill/agent-native-cli/references/update-check.md`: lines 3, 12, and 20 to 21.
- **Approach:**
  - Write the text the Forced bundle changes table names, and nothing else.
  - The F7 fallback names the exact `anc` upgrade commands from the CLI README's install section.
  - Every URL in the new text is one this plan publishes or one that already resolves.
- **Test scenarios:** `tests/skill-source.test.ts`:
  - No bundle file contains `git clone`, `git pull`, `git -C`, `raw.githubusercontent.com`, or `github.com/brettdavies/agentnative-skill`.
  - The one allowed `agentnative-skill` mention is the spec-owned text in `spec/`.
  - Every `destinations` key in `src/data/skill/skill.json` appears in `references/update-check.md` beside its path.
  - Under OD8 (a) or (b), the F4 sentence names `skill://`.
- **Verification:** that test fails on S1's tree, listing the 9 lines (quoted). `/devex-review` walks the update prompt as an agent would.

#### U6. Update-check remote, spec resync note, version (F6, F8, F9)

- **Goal:** installed copies compare their version with anc.dev, and the bundle carries its first hosted version.
- **Requirements:** R2, R8.
- **Files:**
  - `skill/agent-native-cli/bin/check-update`: lines 22 and 23, and line 30.
  - `skill/agent-native-cli/spec/README.md`: the resync section and the Layout row (F8).
  - `skill/agent-native-cli/VERSION` (OD1).
  - `tests/skill-check-update.test.ts`.
- **Approach:** a literal change to `REMOTE_URL`. The script's output, its exit code, its three environment overrides, and its state files are untouched, because they are contract.
- **Test scenarios:**
  - The default `REMOTE_URL` equals OD3's version-pointer URL.
  - With `AGENTNATIVE_SKILL_REMOTE_URL` pointing at a local `Bun.serve` that answers `0.9.9`, and empty `AGENTNATIVE_SKILL_STATE_DIR` and `HOME` in a temp dir, the script prints `UPGRADE_AVAILABLE <VERSION> 0.9.9` and exits 0.
  - When the server answers the same version, it prints nothing and exits 0.
  - When the server is unreachable, it prints nothing and exits 0.
  - `VERSION` is one SemVer line plus a newline.
- **Verification:** the default-URL test fails on S1's tree (quoted). The script runs under `bash` with no exec bit, the way the vercel extractor leaves it.

### S3: Package, record, surfaces, and gates

#### U7. Deterministic package builder

- **Goal:** one build pass turns the tree into the archive, the per-file digests, and the private file copy (KTD4, KTD6).
- **Requirements:** R1, R2, R4.
- **Files:** `src/build/skill-package.mjs`, `src/build/build.mjs` (one stage, run before stage 8), `tests/build-skill-package.test.ts`, `tests/helpers/ustar.ts` (a test-only reader that applies KTD11).
- **Approach:**
  - List the package with `git ls-files -z -s skill/agent-native-cli`, take each file's mode from the index, and sort paths by byte order. The build already needs git for page dates (`src/build/build.mjs:33`).
  - Refuse, by failing the build with the offending path:
    - an index entry whose mode is not `100644` or `100755` (a symlink is `120000`);
    - a dotfile;
    - a path over 100 bytes;
    - a file on disk under the package directory that the index does not list, such as a `__pycache__/` left by running the Python template. So the operator's build and CI's build package the same files, and preflight's identity gate digests what deploy publishes.
  - Read the bytes and take the SHA-256 of each file.
  - Write the ustar archive and wrap it in stored-block gzip with a CRC-32 trailer (Bun's `zlib.crc32`, or a 20-line table implementation).
  - Return `{version, files, archiveBytes, digest, size}`.
  - Empty `dist/.well-known/agent-skills/agent-native-cli/` and `dist/_internal/skill/`, because builds do not wipe `dist/` (`src/build/11a-discovery-emit.mjs:398-401`), so no earlier version's files survive a local rebuild.
  - Emit:
    - `dist/.well-known/agent-skills/agent-native-cli/<version>.tar.gz`;
    - the version pointer;
    - `dist/_internal/skill/agent-native-cli/<path>`.
- **Test scenarios:**
  - Two builds of the same tree give identical bytes.
  - A fixed fixture tree in `tests/fixtures/skill-package/` (three files, one executable) hashes to a golden digest written in the test.
  - The KTD11 reader extracts every file byte-equal to the source, with modes `0644` and `0755` as KTD4 says.
  - The system `tar -tzvf` lists the same paths with no wrapper directory, and `tar -xzf` extracts equal bytes.
  - The gzip header's mtime is 0 and its OS byte 255.
  - In a temp git repo holding the fixture tree, a committed symlink fails the build, naming the path.
  - In the same repo, an untracked file and an ignored file under the package directory each fail the build, naming the path.
  - The archive digest equals `sha256` of the emitted file.
- **Verification:** the golden-digest test fails against a builder that writes the real mtime (quoted). `bun run build` emits the three outputs, and `bun run build && bun test` passes with the private copy in `dist/` (quoted), which proves U2's `dist/**` ignore.

#### U8. The record

- **Goal:** `dist/skill.json` is the one record, shaped per D1 (KTD5).
- **Requirements:** R1, R5, R13.
- **Files:**
  - `src/data/skill/skill.json`: drops `version`, `source`, `install`, and `update`, and gains `destinations`.
  - `src/build/skill.mjs`: `loadSkillData` validates the new source; `buildSkillRecord` builds the record.
  - `src/build/08-scorecards-emit.mjs`, `src/build/12-minify-dist.mjs` (the `PRESERVE_PRETTY` entry stays).
  - `tests/build.test.ts`, `tests/regression.test.ts`.
- **Approach:** `loadSkillData` fails fast on any of:
  - a missing stable key;
  - an empty `destinations`;
  - a destination that does not start with `~/` or does not end with `/agent-native-cli`;
  - any of `version`, `source`, `install`, or `update` present in the source, since each now has one home.

  The record adds:
  - `version` from `VERSION`;
  - `source` from U7, with `url` built by `resolveBaseUrl()` (`src/build/util.mjs:166`), as every navigational link is, so a build with `PUBLIC_BASE_URL` set (staging, or `http://localhost:<port>` for local checks) names its own archive;
  - `install.<host>` = `anc skill install <host>` for each destination;
  - `update` = `anc skill update <host>`.
- **Test scenarios:**
  - The `loadSkillData` fixtures in `tests/build.test.ts` move to the new source shape, with one case per rejection above.
  - `dist/skill.json` keeps every schema_version 1 key with its JSON type, and adds the D1 keys.
  - Keys are sorted at every level.
  - `source.files` equals U7's list.
  - `version` equals `VERSION`.
  - `source.digest` equals the archive's SHA-256.
  - The bytes are pretty-printed and stable.
  - With `PUBLIC_BASE_URL=http://localhost:8787`, `source.url`'s origin is `http://localhost:8787`; with it unset, `https://anc.dev`.
- **Verification:** the regression test's old git-shape assertions fail against the new build until updated; the PR body quotes the first one.

#### U9. Index entry, headers, `llms.txt`, JSON-LD

- **Goal:** the discovery surfaces name the package (R1, R6, KTD7).
- **Requirements:** R1, R6.
- **Files:**
  - `src/build/11a-discovery-emit.mjs`: `buildAgentSkillsIndex` and its human twin `buildAgentSkillsIndexMd` (`/.well-known/agent-skills/index.md`, lines 272 to 293) take the record.
  - `src/worker/headers.ts`: a `gz` file class and a version-pointer rule, both in `isSingleRepresentation`, with their cache classes.
  - `src/build/09-llms-emit.mjs`: the Skill section names the archive and the record, and names `/skill.md` as the manual verifying install for agents without `anc`, since every `install.<host>` value in the record needs `anc` (D1).
  - `src/build/shell.mjs`: the JSON-LD `codeRepository` becomes `https://github.com/brettdavies/agentnative-site/tree/main/skill/agent-native-cli`, and the footer source link at line 125 points at that tree. `downloadUrl` stays `${base}/skill.json`, the stable record. The node is in `emitShell`, which every page calls, starting with the principle pages before stage 8 builds the record. A versioned archive URL there would change every page's bytes on each skill release and leave edge-cached pages naming an archive D3 removes.
  - Tests: `tests/build-discovery-emit.test.ts`, `tests/agent-readiness-discovery.test.ts`, `tests/worker.test.ts`.
- **Test scenarios:**
  - The index entry for `agent-native-cli` has `type` `archive`, and its `url` and `digest` equal the record's.
  - Its `description` equals the `SKILL.md` frontmatter description.
  - `$schema` is unchanged.
  - The other entries are unchanged.
  - On the local Worker, the archive answers `GET` and `HEAD` with `Content-Type: application/gzip`, no `Content-Encoding`, `Cache-Control: public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`, `X-Robots-Tag: noindex`, no `Link`, and no `X-Llms-Txt`.
  - `Accept: text/markdown` on the archive returns the archive.
  - The version pointer answers its bytes as `text/plain; charset=utf-8` with `SHORT_CACHE` under no `Accept` header, under `Accept: */*` (what `bin/check-update`'s `curl` sends), and under `Accept: text/markdown`. Production answers that path 404 `text/markdown` today, so negotiation must never rewrite it.
  - The index twin lists `agent-native-cli` with the archive URL.
  - A version that does not exist answers 404.
  - The site's own web audit check `agent-skills` still passes on the built index.
- **Verification:** each header test fails against the unchanged `headers.ts` (quoted). On `PUBLIC_BASE_URL=http://localhost:8787 bun run dev`, `curl -sI` on both URLs shows the headers, and `curl -s <archive> | shasum -a 256` equals `source.digest`.

#### U10. `/skill`, its twin, and the skill e2e project

- **Goal:** the human page and its twin show the hosted install from the record (R1).
- **Requirements:** R1, R7.
- **Files:** `src/build/skill.mjs` (`buildSkillMarkdown`, `renderSkillPage`), `src/build/08-scorecards-emit.mjs` (the `/skill` `fileDate` inputs gain `skill/agent-native-cli/VERSION`, so a skill release moves the page date and the sitemap `lastmod`), `tests/build.test.ts`, `tests/e2e/skill.e2e.ts`, `playwright.config.ts` (the `skill` project's webServer builds with `PUBLIC_BASE_URL` set to its own localhost origin, so the record names the local archive and the project needs no network beyond localhost).
- **Approach:** the page holds:
  - `anc skill install <host>` and `--all`, and `anc skill update <host>`;
  - the version and the digest;
  - a manual verifying install for hosts `anc` does not map, rendered from the record as this block, with `<url>` and `<hex>` filled in and `<dest>` left for the reader:

    ```bash
    curl -fsSL -o agent-native-cli.tar.gz <url>
    echo "<hex>  agent-native-cli.tar.gz" | shasum -a 256 -c -    # Linux: sha256sum -c -
    rm -rf <dest> && mkdir -p <dest> && tar -xzf agent-native-cli.tar.gz -C <dest>
    ```

    The `rm -rf` clears an older install first, so no file a newer version deleted stays behind;
  - under OD7 (a), `npx skills add https://anc.dev --skill agent-native-cli -g -a <agent> -y` as a second path, with a note that `<agent>` is the vercel CLI's agent name (`claude-code` for Claude Code). `-g` installs at user scope, where `/skill`'s destinations are, and `-y` answers the prompts an agent cannot;
  - a trust paragraph: the digest and the archive both come from anc.dev over HTTPS, the check proves the archive is the one the record names, and it adds no second root of trust.

  The page states that `anc skill install` installs the hosted package from `anc` 0.8.0 on, and gives the check: "Run `anc --version`. Below 0.8.0, use the manual install below." It also states that `anc skill update` replaces the install directory, so local edits there are lost. The `git checkout <tag>` pinning text goes (D3).
- **Test scenarios:**
  - `/skill.md` and `/skill` carry the version, digest, and URL exactly as the record has them.
  - Each host's install line is present.
  - The manual line's URL and hex equal the record's.
  - No `git clone`.
  - Under OD7 (a), the `npx` line names `--skill agent-native-cli`, `-g`, and `-y`.
  - The page carries the `anc --version` check and the sentence that update replaces the directory.
  - The page names the minimum `anc` version, 0.8.0.
  - The e2e pulls the manual block out of `/skill.md` on the local Worker, fills `<dest>` with each host's destination, and runs it with `sh` in a sandbox HOME, once fresh and once over a seeded older install that holds an extra file. Each time the extracted tree equals `source.files`, with no extra paths.
- **Verification:** both themes on `/skill` in a browser, with a screenshot in the PR body, because the page's HTML changes (`AGENTS.md` § Browser-verify).

#### U11. Release gates and the release documents

- **Goal:** releases enforce R2, postflight confirms R11, and the documents describe the hosted package.
- **Requirements:** R2, R11, R13, R14, R15.
- **Files:**
  - `scripts/release/preflight.sh`:
    - `coord`: the skill-repo release check at lines 328 to 341 goes;
    - `build`: the package-identity gate runs right after `bun run build` succeeds (lines 456 to 460);
    - `dist`: extended at lines 660 to 668 to check the archive digest.
  - `scripts/release/postflight.sh` (`purge`: lines 479 to 489 extended).
  - `tests/preflight-release-gates.test.ts`.
  - `.github/workflows/skill-availability.yml`: deleted.
  - `RELEASES.md` § Skill releases: rewritten, including the SemVer contract (R15), and its purge step's URL list gains `/.well-known/agent-skills/index.json` and the version pointer; § Skill-availability probe goes.
  - `RELEASES-PREFLIGHT.md` (its group table, line 45, moves the skill row from `coord` to `build`), `RELEASES-POSTFLIGHT.md`, `RELEASES-RATIONALE.md` § Skill releases.
  - `DESIGN.md` §3.9.
  - `AGENTS.md` § Structure.
- **Approach:**
  - **The preflight gate:**
    - It reads `jq -r '.version, .source.digest'` from `dist/skill.json` and from `curl -fsSL "$PRODUCTION_URL/skill.json"`. `PRODUCTION_URL` defaults to `https://anc.dev`, beside the script's `STAGING_URL` and `LOCAL_URL`, and the gate tests point it at their stub.
    - It passes when the versions are equal and the digests are equal, or when the release version is greater by SemVer.
    - It fails with a named reason when the versions are equal and the digests differ, or when the version decreases. Each failure's detail names the fix: bump `skill/agent-native-cli/VERSION` by the skill SemVer contract in a `fix(skill)` PR to `dev`, then run preflight again (`RELEASES.md` § Skill releases).
    - Before it reads anything, it requires `git diff --quiet HEAD -- skill/agent-native-cli`, and fails with reason `skill-tree-dirty`, naming the paths, when the package has uncommitted edits.
    - It skips with a reason when production is unreachable, the way the existing gate skips.
  - **The postflight checks:** per § The skill release flow, step 4.
- **Test scenarios:** `tests/preflight-release-gates.test.ts`, with production stubbed by a local server through `PRODUCTION_URL`:
  - same version, same digest: pass;
  - same version, different digest: fail with reason `skill-package-changed-without-version-bump`;
  - higher version: pass;
  - lower version: fail with `skill-version-decreased`;
  - production without `source.digest`, at a lower version: pass;
  - production unreachable: skip;
  - a stale `dist/skill.json` with another digest left in place: the gate still compares the fresh build;
  - an uncommitted edit under `skill/agent-native-cli/`: fail with `skill-tree-dirty`, naming the path;
  - each failure's detail names the `VERSION` bump fix.
- **Verification:**
  - The gate tests fail against the unchanged script (quoted).
  - `scripts/release/preflight.sh build` on the PR branch runs the new gate against production with a plain GET and passes.
  - After merge, `gh workflow list` shows no `skill-availability` workflow.

### C1: The CLI's download install

#### U12. Record, download, verification, extraction

- **Goal:** `anc skill install|update` installs the hosted package (R7, KTD9 to KTD11).
- **Requirements:** R7, R8.
- **Files:** `src/skill_install.rs`, `src/skill_install/archive.rs` (the ustar reader and the KTD11 rules), `Cargo.toml` (`sha2`, `flate2` with the pure-Rust `miniz_oxide` backend), `tests/skill_install.rs`.
- **Approach:**
  - **Read the record.** `curl` fetches the record into memory, capped at 1 MiB. The CLI parses only `name`, `version`, `source.type`, `source.url`, `source.digest`, and `source.size`, and refuses with `record-invalid` unless:
    - the name is `agent-native-cli`;
    - the type is `archive`;
    - the URL has the record's origin, so it is HTTPS unless the record URL is a loopback override (KTD10);
    - the digest matches `^sha256:[0-9a-f]{64}$`;
    - the size is at most 16 MiB.
  - **Download and check.** The CLI first creates the destination's parent directory (`create_dir_all`): a host that never had a skill has none, and `git clone` creates it today. `curl` downloads the archive to a temp file in that directory. The CLI checks that the length equals `size` and the SHA-256 equals `digest`. Only then does it extract, under KTD11, into `.<name>.anc-install-<pid>` beside the destination.
  - **Swap in.** Install removes an empty destination first, because a rename onto an existing directory fails on Windows, a release target, and then renames the staging directory in. Update keeps today's aside-and-restore shape: the install moves aside, staging is renamed in, and the aside copy is deleted. On any failure the staging directory is deleted and the aside copy is restored.
  - **Cleanup.** The temp file is always deleted.
  - **`--all`.** The record and the archive are fetched and verified once per invocation and extracted once per host.
- **Test scenarios:** `tests/skill_install.rs`, with a `std::net::TcpListener` server thread on `127.0.0.1` and `ANC_SKILL_RECORD_URL` pointing at it.
  - Install lands `SKILL.md` and `bin/check-update` with mode `0755` at the destination.
  - Update over a git-clone install removes `.git` and lands the package.
  - Update over a hosted install lands the newer version.
  - Digest mismatch: `digest-mismatch`, the destination is untouched, and no staging or temp file is left.
  - Each `package-invalid` case is refused before any byte reaches the destination: a symlink entry, a hard-link entry, `../x`, `/abs`, a duplicate path, no root `SKILL.md`, `name: other`, and more than 512 files.
  - An archive URL on another origin: `record-invalid`.
  - A redirect from the record URL: `record-unreadable`, because `--max-redirs 0` applies.
  - `curl` missing from `PATH`: `curl-not-found`.
  - The exact `curl` argument vectors are pinned for both cases, an `https://` URL and the loopback `http://` override, the way the git one is.
  - Install into a temp HOME with no host directories succeeds for every host.
  - `--all` sends one record request and one archive request to the test server.
- **Verification:**
  - The tests run against the unchanged module and fail (quoted).
  - `cargo test`, `cargo clippy -- -D warnings`, and `cargo deny check` pass.
  - The release binary's size change is reported in the PR body.
  - A local smoke against a site built with `PUBLIC_BASE_URL=http://localhost:8787`: `ANC_SKILL_RECORD_URL=http://localhost:8787/skill.json anc skill install claude_code` in a temp HOME installs the package.

#### U13. Host map from `destinations`, fixture resync

- **Goal:** the build-time host map reads the new source shape (R13).
- **Requirements:** R13.
- **Files:** `build.rs` (`emit_skill_hosts`), `src/skill_install/skill.json` (resynced with `SKILL_SITE_REF=<S3 branch> scripts/sync-skill-fixture.sh`, then again against `dev` once S3 merges).
- **Approach:**
  - `emit_skill_hosts` reads the `destinations` map: keys are host slugs, values are destination templates.
  - It applies the site's checks from U8, so both binaries reject the same inputs.
  - Under OD2 (a), the record URL is a constant in `src/skill_install.rs`, not in the fixture.
- **Test scenarios:**
  - `resolve_host` returns the fixture's destination for every host.
  - A destination without `/agent-native-cli` fails the build, naming the key.
- **Verification:** `scripts/sync-skill-fixture.sh --check` passes against site `dev` once S3 is merged.

#### U14. Envelope, reasons, and docs

- **Goal:** the envelope and the docs describe the download install (D2).
- **Requirements:** R7, R14.
- **Files:**
  - `src/skill_install.rs`: the `command` value, the new `url`, `digest`, and `version` keys, and the reason set.
  - `src/cli.rs:388-413`: the help. The `install` fallback paragraph points at the manual verifying install on `https://anc.dev/skill` in place of its `git clone` line, the dry-run example comment describes D2, and the `update` help says that update replaces the install directory, so local edits there are lost.
  - `CLAUDE.md` § Skill Install Verb: the rule amended per OD2 (a); the git hardening section replaced by the `curl` hardening and the KTD11 rules. It documents `ANC_SKILL_RECORD_URL` as a test and mirror override: an `https://` URL, or a loopback `http://` one, whose archive shares its origin.
  - `AGENTS.md:55-90`, `README.md:54-86` (which also lists `ANC_SKILL_RECORD_URL` with its accepted schemes).
  - `RELEASES.md:546-547`, `RELEASES-PREFLIGHT.md:16,175,213-214`: the live install smoke installs from anc.dev into a clean HOME for each host.
  - `.github/ISSUE_TEMPLATE/config.yml:10`: routes to site issues.
  - `CONTRIBUTING.md:122`, `BRAND.md:87`.
- **Approach:**
  - A dry run reads the record (one GET) and writes nothing.
  - `would_succeed` covers both the record and the destination.
  - The two removed reasons are listed under Breaking in the CLI changelog, and `anc` takes 0.8.0.
  - `exit_code` carries curl's exit status on `record-unreadable` and `download-failed`, and is absent on every other reason, as it carries git's status today only when git ran. curl's codes tell a retryable failure (6, 7, 28: DNS, connect, timeout) from a final one (22: an HTTP error).
  - The docs give each new reason a retry answer and the next command:
    - `curl-not-found`: no retry; install curl, then run the command again.
    - `record-unreadable`, `download-failed`: retry when `exit_code` is 6, 7, or 28; on 22, report it on the site repo's issues.
    - `record-invalid`: no retry; upgrade `anc`, or fix `ANC_SKILL_RECORD_URL`.
    - `digest-mismatch`: no retry under OD3 (a) or (b), because a versioned archive never changes; report it on the site repo's issues. OD3 (c) changes this row.
    - `package-invalid`: no retry; report it on the site repo's issues.
- **Test scenarios:**
  - The dry-run envelope's `command` equals `anc skill install claude_code`, and it carries `url`, `digest`, and `version` from the record.
  - `eval "$(anc skill install --dry-run claude_code)"` in a temp HOME installs.
  - Every error envelope carries a reason from the closed set.
  - A `download-failed` envelope carries curl's `exit_code`, and a `digest-mismatch` envelope carries none.
  - `anc skill update --help` carries the sentence that update replaces the directory.
  - The README names `ANC_SKILL_RECORD_URL` with both accepted schemes.
- **Verification:** `/devex-review` walks `anc skill install --help`, a dry run, an install, and an update.

### K1: The skill repo's bridge release

#### U15. Bridge release

- **Goal:** every git install's next pull or re-clone holds the hosted version (R8, R12, KTD14).
- **Requirements:** R8, R12.
- **Files (skill repo):**
  - every bundle file at the root, copied from the site's `main` at R1's commit;
  - `README.md`: a moved notice pointing at `https://anc.dev/skill` and the site repo's `skill/` directory;
  - `.github/ISSUE_TEMPLATE/config.yml`: routes to the site repo's issues, with blank issues off.
  - `scripts/release/preflight.sh`: `CHECK_UPDATE_URL` (line 71) becomes OD3's version pointer, so `smoke_check_update` (lines 283 to 310) compares against anc.dev. A 0.0.0 install then prints `UPGRADE_AVAILABLE 0.0.0 <hosted version>`, and an install at the hosted version stays quiet. With the GitHub URL both checks fail before the bridge merges, because the candidate's `bin/check-update` reads anc.dev while GitHub `main` still holds 0.5.0.

  Everything else stays as the archived record. So the bridge's `main` also carries files a host never loads: `AGENTS.md`, `BRAND.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `PRODUCT.md`, `README.md`, `RELEASES.md`, `RELEASES-PREFLIGHT.md`, `RELEASES-POSTFLIGHT.md`, `RELEASES-RATIONALE.md`, `SECURITY.md`, `cliff.toml`, `.editorconfig`, `.gitattributes`, `.gitignore`, `.markdownlint-cli2.yaml`, `spec/.markdownlint-cli2.yaml`, `.github/`, `docs/`, `evals/`, and `scripts/`.
- **Approach:**
  - A `fix/` branch from the skill repo's `dev`, PR'd to `dev`, then the skill repo's own release flow (`scripts/release/cut-release-branch.sh`, PR to `main`, the tag at OD1's value, a GitHub release).
  - The skill repo's preflight install smoke (`docs/solutions/logic-errors/preflight-install-smoke-that-clones-published-main-tests-the-previous-release.md`) runs on the candidate tree.
- **Test scenarios:**
  - A script in the PR body downloads `https://anc.dev`'s archive, checks the digest, and extracts it. Every path in the extraction is byte-equal on the release branch, and every branch path missing from the extraction is on the list of repo files above.
  - `bin/check-update` against the live pointer prints nothing.
- **Verification:** after the release, run a `git clone --depth 1` of `main` into a temp dir and apply the same comparison: every archive path is byte-equal in the clone, every other clone path is on the list above, and the clone's `bin/check-update` default URL is OD3's pointer.

### S4: MCP skills extension (OD8 (a))

#### U16. Serve the skill over SEP-2640

- **Goal:** MCP clients that implement the extension list, get, and read the package's files with digests equal to the record (R9, KTD12).
- **Requirements:** R1, R9.
- **Files:**
  - `src/worker/mcp/skills.ts`: the `SkillFiles` adapter, `loadSkills(env)` with its success-only per-isolate cache, `getWarmSkills()`, and `attachSkills(server)`.
  - `src/worker/index.ts`: the dispatch shell awaits `loadSkills(env)` beside `loadCatalog(env)`.
  - `src/worker/mcp/server.ts`: `createAncServer` attaches the warm skills catalog. `buildMcpHandler` is marked deprecated and kept for test migration, so it gets no new wiring.
  - `src/shared/mcp-discovery.ts`: `MCP_SERVER_CAPABILITIES.extensions`, and `MCP_SERVER_VERSION` `0.3.0`.
  - `src/worker/mcp/instructions.ts`: one sentence naming `skill://agent-native-cli/SKILL.md` and `/skill.json`, within `client-limits.ts`.
  - `content/mcp-skill.md`, `docs/runbooks/mcp-wire-protocol.md` (the extension methods, `resources/directory/read` included, and their errors).
  - `scripts/release/mcp-smoke.sh` (a `skills/list` check).
  - `AGENTS.md` § MCP server: the resource count gains the skills template and the `SKILL.md` resource, and the section names `skills/list`, `skills/get`, and `resources/directory/read`. U16 edits that line as the op-layer `0.2.0` release leaves it and quotes no tool count, because that release changes the tool set.
  - Tests: `tests/mcp-capabilities.test.ts`, `tests/worker-mcp.test.ts`, `tests/mcp-client-limits.test.ts`, `tests/e2e/mcp.e2e.ts`.
- **Approach:**
  - `SkillsExtension.load(adapter, { strict: true, cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' } })`.
  - The adapter's root is the skills folder: `list('')` returns `agent-native-cli`, deeper listings derive from `source.files`, and `read(path)` fetches `/_internal/skill/<path>` through ASSETS.
  - A load failure (a missing record, or a strict-mode warning) fails the request the way a `loadCatalog` failure does, so a bad build cannot serve a partial skill. As with `loadCatalog`, only a success is cached, so the next request loads again.
- **Test scenarios:**
  - `skills/list` on the modern lane returns one entry, `skill://agent-native-cli/SKILL.md`, whose `frontmatter` deep-equals the parsed `SKILL.md` frontmatter.
  - That entry's `resources` (uri, digest, size) equal `source.files` mapped to `skill://agent-native-cli/<path>`.
  - `skills/get` of that URI returns the same entry.
  - `resources/read` of each URI returns bytes whose SHA-256 is the listed digest.
  - `resources/read` of `skill://agent-native-cli/../x`, `skill://agent-native-cli/missing.md`, and `skill://other/SKILL.md` answers the SDK's not-found error, never another `/_internal/` file.
  - `resources/list` holds `skill://agent-native-cli/SKILL.md` and every resource it held before.
  - `resources/directory/read` of the skill root and of `references/` lists exactly the children `source.files` implies.
  - Capabilities on both lanes and on the SEP-1649 card deep-equal the constant, `extensions` with `directoryRead: true` included.
  - A skills load failure answers the request as a catalog load failure does, and the next request loads again.
  - The `tools` array's bytes are unchanged.
  - The instructions are within the `cut` record.
- **Verification:**
  - The capability and `skills/list` tests fail against the unchanged server (quoted).
  - On the local Worker with `MCP_ENABLED="true"`, `scripts/release/mcp-smoke.sh` passes its new check.

### S5: WebMCP

#### U17. `get_skill_package`

- **Goal:** a browser agent on anc.dev gets the package record's summary (R10, KTD13).
- **Requirements:** R1, R10.
- **Files:** `src/client/webmcp-orientation.ts`, `src/client/webmcp-lib.ts` (`/skill` joins the orientation paths), `src/build/08-scorecards-emit.mjs` (the `/skill` shell gains `extraScripts: [WEBMCP_SCRIPT]`, since the bundle loads today only on `/`, `/audit`, `/mcp-docs`, and the principle pages), `tests/webmcp.test.ts`, `tests/webmcp-source-guard.test.ts`, `tests/build.test.ts`.
- **Approach:**
  - `execute` fetches `/skill.json` same-origin and returns a short text: name, version, digest, archive URL, `anc skill install <host>`, and `/skill`.
  - It returns a fixed message when the fetch fails.
  - The tool has `annotations.readOnlyHint: true`.
- **Test scenarios:**
  - The tool is registered on `/`, `/mcp-docs`, `/p1` to `/p8`, and `/skill`.
  - The built `dist/skill.html` references `WEBMCP_SCRIPT`.
  - Its output is at most 1,500 characters and carries the record's version and digest verbatim.
  - When the fetch fails, it returns the fixed message.
  - It sends no request to another origin.
- **Verification:** in a browser on the local Worker, `navigator.modelContext` lists the tool on `/skill`, and calling it returns the record's version.

### S6: Site references

#### U18. Site references and issue routing

- **Goal:** the site's documents and issue routing describe the present state (R14).
- **Requirements:** R12, R14.
- **Files:**
  - `README.md:18,90,119`, `CONTRIBUTING.md:137`, `content/contribute.md:54,59`, `BRAND.md:8,88,100`;
  - `scripts/SYNCS.md`: the skill flow and the CLI fixture flow;
  - `scripts/prose-check.sh:16`: the channel list;
  - `src/data/spec/README.md:93`;
  - `.github/ISSUE_TEMPLATE/`: a `skill` template adapted from the skill repo's `bug-report.yml` and `bundle-proposal.yml`, and routing in `config.yml`;
  - `skill/AGENTS.md`: the bundle rules from the skill repo's `AGENTS.md`, stated for this repo.
- **Test scenarios:** `rg -n 'agentnative-skill' --glob '!docs/**' --glob '!CHANGELOG.md' --glob '!content/changelog.md' --glob '!skill/CHANGELOG.md' --glob '!src/data/spec/**' --glob '!skill/agent-native-cli/spec/**'` returns only lines that name the archived repo as history.
- **Verification:** `scripts/prose-check.sh --changed-only` reports 0 blocking.

### P1: Spec repo

#### U19. Spec repo routing and channel lists

- **Goal:** the spec repo routes skill issues to the site, and its channel lists name the site as the skill's home (R14).
- **Requirements:** R14.
- **Files (spec repo):** `.github/ISSUE_TEMPLATE/config.yml:10`, `00-blank.yml:31`, `README.md:20,136,178`, `AGENTS.md:16,120`, `BRAND.md:8,88,100`, `RELEASES.md:449`, `docs/architecture/voice-enforcement.md:253,259`.
- **Approach:**
  - Docs and templates only.
  - `principles/p8-discoverable-skill-bundle.md:94` stays (Deferred).
  - No spec release follows, because releases trigger on principles or `VERSION`.
- **Verification:** the spec repo's prose gate passes, and no principle file changes.

### Operator steps

These are Brett's: each is a GitHub setting, a release, or a decision on his own work.

- **O1. Answer the open owner decisions** (OD1, OD2, OD3, OD4, OD7, OD8, OD10).
- **O2. The local testing-guidance commits, per OD10.**
  - (a) Push the branch and open, review, and merge its PR on the skill repo's `dev`.
  - (b) Delete the local branch.
  - (c) Run `git format-patch origin/dev..feat/testing-guidance -o <dir>` in the skill prime checkout, and hand the directory to the S1b session.
- **O3. Freeze the skill repo.** Merge nothing to `dev` or `main` except K1, and give S1 the frozen `origin/dev` SHA. The three open remote branches (`feat/revendor-canons`, `feat/vendor-editorconfig`, `fix/vendor-spec-v0.7.0`) stay unmerged.
- **O4. Merge each PR in § PR sequence order.**
- **O5. Run R1** (`RELEASES.md` § Releasing dev to main) with preflight and postflight, including the purge.
- **O6. Cut `anc` 0.8.0 after R1 is live.** Run the CLI's release flow, the Homebrew tap chain, and its live install smoke, in the same operator session, right after R1's postflight, because `/skill` names 0.8.0 from R1 on.
- **O7. Retire the skill repo, per OD4, after K1's release.**
  - (a) `gh repo edit brettdavies/agentnative-skill --description "Moved: the agent-native-cli skill is published at https://anc.dev/skill; source in brettdavies/agentnative-site under skill/"`, then `gh repo archive brettdavies/agentnative-skill --yes`.
  - (b) The same description, then `gh repo delete brettdavies/agentnative-skill --yes` after a waiting period of Brett's choosing.
  - (c) The description, then `gh repo edit brettdavies/agentnative-skill --enable-issues=false`; the repo is left writable.
  - (d) Archive after K1's README-only release (§ Option variants, OD4 (d)), with no bridge.
- **O8. Reinstall locally.** Run `anc skill update --all` on Brett's own machines, then `bin/check-update` in one host's install. It prints nothing.

### Option variants

Each subsection lists what changes when Brett picks an option other than the recommendation. A unit not named stays as written.

#### OD1: first version

- **(a) `0.6.0`** is as written.
- **(b) `0.8.0`:**
  - U6 sets `VERSION` to `0.8.0`.
  - U15 tags `v0.8.0`.
  - The archive URL becomes `.../agent-native-cli/0.8.0.tar.gz`.
  - § Existing installs reads 0.8.0 for 0.6.0.
  - `RELEASES.md` § Skill releases records that the first hosted version matched `anc` 0.8.0, and that later versions follow the SemVer contract on their own cadence.
  - Tests are unchanged; they read `VERSION`.
- **(c) `1.0.0`:**
  - The same literal changes as (b), at `1.0.0`.
  - The SemVer contract text in `RELEASES.md` drops its pre-1.0 rule, so from here a break moves the major.

#### OD2: what the CLI reads

- **(a)** is as written.
- **(b) Build-time pin:**
  - **U13.** The fixture becomes the built record, synced from `https://anc.dev/skill.json` at CLI release prep. `scripts/sync-skill-fixture.sh` gains a `--record` mode. `skill-fixture-drift.yml` checks only the fixture's stable fields against site `dev`'s source, so a skill release does not turn every CLI PR red. The CLI's release preflight checks the fixture's `version` and `source.digest` against production's record (a plain GET).
  - **U12.** No record fetch at run time. `build.rs` emits the URL, digest, size, and version as constants, and `ANC_SKILL_RECORD_URL` is not added.
    - The test seam is `ANC_SKILL_TEST_PIN`, `<url> <digest> <size> <version>`, which overrides the four constants. It is read only in debug builds (`cfg(debug_assertions)`, which `cargo test` uses) and only for a loopback `http://` URL, so a release binary reads no new variable.
    - The record scenarios drop: another origin, the record redirect, and `record-invalid`. A loopback archive whose bytes differ from the pinned digest takes their place and answers `digest-mismatch`. The other U12 scenarios run against the seam.
    - The D2 dry run reads the baked constants and sends no request; its `url`, `digest`, and `version` are the baked ones.
  - **U14.** Update installs the baked version. When the installed `VERSION` equals it, update answers `status: "success"`, exit 0, and `destination_status: "current"` with no download, and text mode prints `agent-native-cli <version> is current at <destination>`. `CLAUDE.md`'s rule stays as it is.
  - **D3 alternative (the archives stay served).**
    - U7 and U8: every released archive stays served at its URL. A committed `skill/released/<version>.tar.gz` holds each released archive's bytes. It lands after the site release that published the version, as a `feat(skill)` PR to `dev` that downloads the archive from production and checks it against the record's digest, and it reaches `main` with the next release, like any `dev` change.
    - The build builds the current version's archive from the tree and copies every committed archive into `dist`. When a committed archive exists for the current `VERSION`, the build checks that it is byte-equal to the one it just built, fails otherwise, and writes one file. The record gains `releases: [{version, url, digest}]`.
    - U11's preflight also checks that no committed archive changed (`git diff --diff-filter=MD` on `skill/released/` against `main` is empty).
  - **U5.** F7's text says that a newer skill arrives with a newer `anc`: upgrade `anc`, then run `anc skill update <host>`. If update then reports the install current, the `anc` that carries the new version has not shipped yet, so choose "Not now".
  - **Release order.** The `anc` release that bakes a skill version follows the site release that publishes it, because U13 bakes from production's record. `RELEASES.md` § Skill releases says to cut it in the same operator session. Until it ships, the version pointer names a version no `anc` installs, which F7's "Not now" line covers.
  - **Risks.** Every skill release needs an `anc` release before installs see it. The repo grows by about 274 KB per skill release.
  - **Reviews.** Unchanged.

#### OD3: URLs

- **(a)** is as written.
- **(b) `/skill/`:**
  - U7 emits to `dist/skill/agent-native-cli-<version>.tar.gz` and `dist/skill/VERSION`.
  - U9 adds a Worker test proving those two paths are served as files and never fall through to the `/skill` page route or a trailing-slash redirect.
  - U6's default URL is `https://anc.dev/skill/VERSION`.
  - The postflight purge list names `/skill/VERSION`.
- **(c) An unversioned archive:**
  - U7 emits `dist/.well-known/agent-skills/agent-native-cli.tar.gz`.
  - U9 adds a cache class, `public, max-age=60, s-maxage=300, stale-while-revalidate=0`. It applies to the archive, the version pointer, `/skill.json`, and the index.
  - The purge stays the operator's manual step, and its URL list in `RELEASES.md` § Skill releases gains the archive, for six URLs. U11's postflight retries its digest check once, 30 seconds later.
  - § How the decisions combine gives the stale window: at most 5 minutes.
  - U14's docs row for `digest-mismatch` becomes: retry after 5 minutes, because the edge can pair a new record with the old unversioned archive until the purge lands.
  - Under OD2 (b), (c) cannot serve the baked versions, so OD2 (b) requires OD3 (a) or (b).

#### OD4: the skill repo

- **(a)** is as written.
- **(b) Delete:**
  - U15 as written, then O7 (b) after a waiting period.
  - Deleting the repo makes its 72-commit history unreachable. S1's commit body still names the source repo and SHA, and neither resolves (KTD2).
  - The spec's `principles/p8-discoverable-skill-bundle.md:94` then names a repo that is gone, so that Deferred item moves into P1. P1 rewrites the sentence to point at the hosted package on `https://anc.dev/skill`. A principle edit triggers a spec release. `scripts/sync-spec.sh` then resyncs both spec copies, which changes package bytes, so a skill `VERSION` bump by the SemVer contract rides the same site PR (KTD3), and the next site release ships it.
  - § Existing installs, column (b), applies after deletion.
  - The CLI README and `/skill` tell a user on an older `anc` to upgrade `anc` before updating.
- **(c) Leave unarchived:**
  - U15 as written.
  - O7 (c).
  - The moved notice stays at the top of the README.
  - Risk: a later push to that repo's `main` reaches every older `anc`. Branch protection on `main` stays as it is.
- **(d) No bridge:**
  - K1 shrinks to one README-only PR on the skill repo's `dev`, released to `main` the way U15 is: the moved notice replaces the `git clone` install text, so the archived README describes the present state (Definition of Done). U15's bundle copy is dropped, and O7 (d) runs after that release.
  - § Existing installs, column (d), applies.
  - `/skill` and the CLI README both tell git installs to run `anc skill update <host>` with a C1 `anc`.
  - Nothing reaches an install whose `anc` is older.

#### OD7: the third-party installer

- **(a)** is as written (U10).
- **(b)** U10 drops the `npx` line and its test. Nothing else changes; the index still serves every RFC client.

#### OD8: MCP timing

- **(a)** is as written.
- **(b) Inside `0.2.0`:**
  - S4 is stacked on the op-layer stack's top branch with `gh stack`, and merges with the stack.
  - S4 waits on S3 merged to `dev`, because U16 reads the record's `source.files` and the `dist/_internal/skill/` copy S3 builds. A stack cut before S3 merged is restacked onto that `dev` first.
  - Release order: each release carries all of `dev`, so whichever ships first carries the other's merged work. R1 ships first, so the package does not wait on PR9, and the op-layer release then carries S4. One combined release is the alternative.
  - `MCP_SERVER_VERSION` stays `0.2.0`.
  - The op-layer plan's PR6 test fixtures for capabilities gain `extensions`.
  - The op-layer release waits on S4 as well as PR9.
  - F4 rides S2.
  - Reviews are unchanged.
- **(c) Not now:**
  - S4 and U16 are dropped, and F4 drops out of U5.
  - R9 moves to Deferred.
  - `AGENTS.md` § MCP server is unchanged.

#### OD10: local commits

- **(a)** S1 imports from the skill repo's `dev` after O2 (a); S1b is dropped.
- **(b)** O2 (b); S1b is dropped.
- **(c)** is as written.

---

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Build before tests | `bun run build`, then `bun test` (`AGENTS.md` § Repo conventions) | every site PR |
| Lint and types | `bun run lint`, `bun run typecheck` | every site PR |
| Prose | `scripts/prose-check.sh --changed-only`, 0 blocking (run `vale sync` once in a fresh clone); the imported `skill/` tree is excluded (U2) | every PR touching markdown |
| Observed failing | each new test runs against the unfixed code, and the failure is quoted in the PR body | every code PR |
| Package determinism | `tests/build-skill-package.test.ts`: the golden digest, and two builds producing equal bytes | S3 onward |
| Record coherence | `version` equals `VERSION`; `source.digest` equals the archive's SHA-256; the index entry equals the record; `source.files` equals the archive's files | S3 onward |
| Spec copy | `tests/skill-spec-copy.test.ts` | S1 onward |
| Local Worker | `bun run dev` on port 8787. When another session's server holds 8787, run `bun run build && wrangler dev -c wrangler.jsonc -c src/og-render/wrangler.jsonc --env staging --local --port <free port>`. A check that downloads the archive builds with `PUBLIC_BASE_URL=http://localhost:<port>`, so the record names the local archive | S3, S4, S5, C1 |
| Browser | both themes on `/skill`, with a screenshot in the PR body | S3 |
| CLI | `cargo test`, `cargo clippy -- -D warnings`, `cargo deny check`; `scripts/sync-skill-fixture.sh --check` | C1 |
| Release gates | `scripts/release/preflight.sh all` against the deployed release build, then postflight with the purge (operator) | R1, R2 |
| Bridge equality | every path in the extracted hosted archive is byte-equal in the bridge, and every other bridge path is on U15's list of repo files | K1 |

## Definition of Done

- `https://anc.dev/skill.json`, the index entry, `/skill`, `/skill.md`, the version pointer, the WebMCP tool, and (under OD8 (a) or (b)) the MCP skills entry all name one version and one digest, and the archive at the record's URL hashes to that digest.
- `anc skill install <host>` with `anc` 0.8.0 installs the package into a clean HOME for every mapped host, and `anc skill update <host>` moves a git-clone install to it.
- A `git clone` of the skill repo's `main` holds the hosted version's package files byte for byte (OD4 (a), (b), (c)), and the repo is in OD4's state.
- No document in the four repos describes the skill as installed by `git clone` or sourced from the skill repo, except history and change records.
- Every unit's tests pass and were observed failing against the unfixed code.
- Each PR's reviews ran one round each, with verdicts in PR comments, and every in-brief finding is fixed.

---

## Appendix

### Migration checklist

Every place that names the skill repo, its location, the git install, or the skill's version, read 2026-11-14 at each repo's `origin/dev`, with the unit that changes it.

| Repo | Where | Unit |
| --- | --- | --- |
| site | `src/data/skill/skill.json`; `src/build/skill.mjs`; `src/build/build.mjs:75`; `src/build/08-scorecards-emit.mjs:345` | U8, U10 |
| site | `src/build/11a-discovery-emit.mjs`; `src/build/09-llms-emit.mjs:99`; `src/build/shell.mjs:125,376-379`; `src/worker/headers.ts` | U9 |
| site | `.github/workflows/skill-availability.yml`; `scripts/release/preflight.sh:328-341,660-668`; `scripts/release/postflight.sh:42,479-489` | U11 |
| site | `RELEASES.md:1060-1092`; `RELEASES-PREFLIGHT.md:45,49,91,196-202,517-525`; `RELEASES-POSTFLIGHT.md:55,146-153`; `RELEASES-RATIONALE.md:542-560`; `DESIGN.md:492-563`; `AGENTS.md` § Structure | U11 |
| site | `tests/build.test.ts:35,542,2243-2305`; `tests/regression.test.ts:167-279,681`; `tests/worker.test.ts:812-816,1048-1084`; `tests/e2e/skill.e2e.ts`; `tests/e2e/agents.e2e.ts:157-158` | U8 to U10 |
| site | `README.md:18,90,119`; `CONTRIBUTING.md:137`; `content/contribute.md:54,59`; `BRAND.md:8,88,100`; `scripts/SYNCS.md`; `scripts/prose-check.sh:16`; `src/data/spec/README.md:93`; `.github/ISSUE_TEMPLATE/` | U18 |
| site | `src/build/shell.mjs:138,398`; `src/build/12-minify-dist.mjs:6-15`; `src/worker/index.ts:866`; `content/_use.md:3`; `content/install.md:39` | stay |
| bundle | `SKILL.md` description, `:37`, `:190`, `:203`; `getting-started.md:80-81,91-92,107`; `bin/check-update:22-23,30`; `references/update-check.md`; `spec/README.md`; `VERSION` | U4 to U6 |
| skill repo | bundle files, `README.md`, `.github/ISSUE_TEMPLATE/`, `scripts/release/preflight.sh:71` | U15 |
| CLI | `src/skill_install.rs`; `src/skill_install/skill.json`; `build.rs:5,128-248`; `tests/skill_install.rs` | U12, U13 |
| CLI | `CLAUDE.md:322-368`; `AGENTS.md:55-90`; `README.md:54-86`; `RELEASES.md:546-547`; `RELEASES-PREFLIGHT.md:16,175,213-214`; `RELEASES-RATIONALE.md:338`; `.github/ISSUE_TEMPLATE/config.yml:10`; `CONTRIBUTING.md:122`; `BRAND.md:87` | U14 |
| spec | `.github/ISSUE_TEMPLATE/config.yml:10`; `00-blank.yml:31`; `README.md:20,136,178`; `AGENTS.md:16,120`; `BRAND.md:8,88,100`; `RELEASES.md:449`; `docs/architecture/voice-enforcement.md:253,259` | U19 |
| spec | `principles/p8-discoverable-skill-bundle.md:94` | Deferred |
| solutions | `best-practices/agentnative-version-model-2026-05-01.md` (the skill row) | after R1, through `sd-commit-doc` |

The `/web-audit/skill/...` lines (`content/web-scorecard-schema.md:418`, `src/data/web-audit/remediation.yaml:5`, `src/worker/audit-web/antecedents/api.ts:20`, `tests/no-funnel-path-literals.test.ts:63`) name the web-audit fix skills, not this bundle.

### Sources

All read 2026-11-14.

| Source | Status | URL |
| --- | --- | --- |
| SEP-2640 Skills Extension | Final; the extension is at Beta | <https://modelcontextprotocol.io/seps/2640-skills-extension>; <https://github.com/modelcontextprotocol/ext-skills> |
| Agent Skills Discovery via Well-Known URIs | Draft, v0.2.0 (published 2026-01-17, updated 2026-03-12) | <https://github.com/cloudflare/agent-skills-discovery-rfc> |
| Agent Skills specification | living | <https://agentskills.io/specification> |
| mcp-use Skills over MCP | vendor docs, tracking the SEP | <https://docs.mcp-use.com/typescript/server/skills> |
| MCP TypeScript SDK `ext/skills` | shipped in 2.4.0, the version this repo resolves | `@modelcontextprotocol/server` |
| Agentic Resource Discovery | Proposal, v0.91 | <https://github.com/ards-project/ard-spec/blob/main/spec/ard.md> |
| vercel-labs `skills` CLI | shipping | <https://github.com/vercel-labs/skills> |
| `gh skill install` | shipping | <https://cli.github.com/manual/gh_skill_install> |
| Codex skills | shipping host docs | <https://developers.openai.com/codex/skills/> |
| Claude Code plugin marketplaces | shipping host docs | <https://code.claude.com/docs/en/plugin-marketplaces> |
| `skills` field in `package.json` | community convention | <https://github.com/antfu/skills-npm/blob/main/SPEC.md> |

### Probe evidence (plain public GETs, 2026-11-14)

- `GET https://anc.dev/.well-known/agent-skills/index.json`:
  - 200, `application/json; charset=utf-8`, `cf-cache-status: HIT`;
  - `Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=60`;
  - `$schema` 0.2.0, with entries `anc-mcp` and `web-audit-fix-*`, all `skill-md`.
- `GET https://anc.dev/skill.json`: version `0.5.0`, `source.type` `git`.
- The skill repo through the GitHub API: public, 1 star, 0 forks, 0 issues, 0 open PRs, releases `v0.1.0`, `v0.2.0`, `v0.5.0`.

---

## Review log

- 2026-11-14: plan written.
- 2026-11-14: `/plan-eng-review` round 1 started on 3e2b4d7, in its own process from a clone of the pushed plan.
- 2026-11-14: `/plan-eng-review` round 1 ended: ready with fixes (P0 0, P1 4, P2 12, P3 11). All 27 findings are applied. The `/plan-eng-review` skill is not registered among the user skills on this machine, so the reviewer applied its lens (architecture, gates, tests) by hand. Decided from evidence: the MCP capability takes the SDK's `directoryRead: true` (finding 3, option (a), the smaller change); S1b applies the patches in a scratch clone of the skill repo and maps paths as U1 does (finding 14); the prose gate, measured at 120 blocking findings over the imported tree, excludes `skill/` (finding 16); the preflight override is `PRODUCTION_URL`, named after the script's `STAGING_URL` and `LOCAL_URL` (finding 23); and `message` and `next_step` on the CLI envelope go under Not in scope, with U14's docs saying which reasons a retry can help (finding 27).
- 2026-11-14: `/plan-devex-review` round 1 started on 5117aec, in its own process from a clone of the pushed plan.
- 2026-11-14: `/plan-devex-review` round 1 ended: ready with fixes (P0 0, P1 3, P2 8, P3 9). All 20 findings are applied, one with a different fix. Decided from evidence: the package-identity gate moves from `coord` to `build`, which builds before it reads (finding 1); `source.url` follows `resolveBaseUrl()`, so local checks build with `PUBLIC_BASE_URL` (finding 2); the OD2 (b) test seam is `ANC_SKILL_TEST_PIN`, read only in debug builds, and an up-to-date update answers `destination_status: "current"`, which replaces the eng round's `already-current` (finding 3); under OD2 (b) the `anc` release follows the site release it bakes from, because U13 bakes from production's record, so the reviewer's reverse release order is not taken and F7's "Not now" line covers the gap (finding 9); and `ANC_SKILL_RECORD_URL` is documented in the CLI's `CLAUDE.md` and README as a test and mirror override (finding 20).
- 2026-11-14: `/compound-engineering:ce-doc-review` round 1 started on 8677b1e, in its own process from a clone of the pushed plan.
