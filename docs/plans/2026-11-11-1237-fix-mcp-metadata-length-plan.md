---
artifact_contract: ce-unified-plan/v1
execution: code
product_contract_source: ce-plan-bootstrap
title: "Fit the MCP server instructions and tool descriptions inside client truncation limits - Plan"
type: fix
status: active
date: 2026-11-11
topic: mcp-metadata-length
---

# Fit the MCP server instructions and tool descriptions inside client truncation limits - Plan

## Goal Capsule

- **Objective:** an agent connected to `https://anc.dev/mcp` on current Claude Code receives the whole server instructions and the whole of every tool description. An agent on an older client, or reading through a tool-registry check, still receives the critical items: what the server is for, where the full guide lives, which tool to call first, and what an audit sends to third-party hosts.
- **Means:** rewrite the instructions as a lead-first summary, give `audit_website` a short disclosure and its `follow_declarations` parameter the full one, record every known client limit in one module, and enforce those limits with a test against the strings the server sends (KTD1 to KTD7).
- **Authority:** Product Contract requirements win on behavior, Key Technical Decisions win on mechanism, and units override neither. The owner decisions D1 to D3 bind both.
- **Execution profile:** code. One PR from a `fix/` branch cut from `dev` (which holds #557 at `082d380`), built alongside the hints PR (`fix/mcp-read-tool-hints`). Units U1 to U5 land in that PR.
- **Stop conditions:**
  - A critical item cannot stay inside every critical-window limit (KTD2) without removing a fact that no published surface carries. Stop and report.
  - The `follow_declarations` parameter description cannot hold the full disclosure and still describe the parameter. Stop and report: that reopens D2.
- **Who finishes:** an agentnative-site session builds the PR, runs `ce-code-review` and `/devex-review`, and hands it to Brett for merge approval to `dev`.

---

## Product Contract

### Summary

The MCP server's instructions run to 5,759 characters at `https://anc.dev`, past the 4,096-character cut current Claude Code applies, and the `audit_website` description runs to 2,458 UTF-8 bytes, past the 2,048-byte point a tool-registry check warns at. This plan rewrites the instructions to fit 4,096 characters with the critical items inside the first 2,048 bytes. It gives `audit_website` a short third-party disclosure, moves the full disclosure to the `follow_declarations` parameter, records each client limit with its source in code, and adds a test that fails when a served string breaks a recorded limit.

### Problem Frame

A tool-registry check of `https://anc.dev/mcp` warns `claude-code-metadata-length`: two strings pass 2,048 bytes. Its fix line reads "Keep each tool description and the server instructions field at or below 2 KB, and put critical guidance first".

The strings were measured on `dev` at `082d380` (#557 merged) through `bun run dev` with `MCP_ENABLED="true"`, one `initialize`, one modern `server/discover`, and one `tools/list` against `http://localhost:8787/mcp`. Origin-bearing text was then re-based to each served origin.

| String | `https://anc.dev` | Staging origin | Notes |
| --- | --- | --- | --- |
| Server instructions | 5,759 chars (all ASCII) | 6,005 chars | the origin appears 6 times; `server/discover` returns the same string as `initialize` |
| `audit_website` description | 2,458 bytes, 2,454 chars | same | 1,059 chars of the tool's own text, then `FOLLOW_DISCLOSURE` (1,395 chars); two em-dashes |
| `get_website_audit` description | 1,049 bytes | same | next longest |
| `score_cli` description | 1,021 bytes, 1,017 chars | same | |
| Every other description | 187 to 852 bytes | same | no description carries the origin |
| Longest parameter description | 450 bytes (`get_website_audit.url`) | same | `follow_declarations` is 372 |

The brief's figures (5,608 bytes, disclosure at character 3,836) hold on `738d710`; #557 added 151 characters to the web-tools paragraph.

What a client loses today:

- **Current Claude Code** (4,096-character cut on instructions): the cut lands 109 characters into `FOLLOW_DISCLOSURE`, which starts at character 3,987. The agent never sees which hosts are contacted, the caps, the opt-out, the spec-revision sentence, or the "Connect now ... Full recipes at `/mcp-skill.md`" pointer. On staging the cut lands 27 characters in.
- **Claude Code before v2.1.296** (2,048-character cut on instructions and on a tool loaded upfront): the instructions stop inside the result-envelope paragraph, before the errors, the rate limits, the disclosure, and the pointer. `audit_website` loses the last 406 characters of its disclosure, including the opt-out sentence.

The instructions also break the specification's own guidance: they repeat `FOLLOW_DISCLOSURE` word for word from the `audit_website` description, and `DiscoverResult.instructions` "should not duplicate information already in tool descriptions" (Sources).

### Requirements

**Length**

- R1. The whole server instructions fit every budget limit (KTD2) at every origin the server answers on, measured in each limit's own unit.
- R2. The whole of every tool description fits every budget limit for both the upfront and the tool-search surface, because the client decides how a tool loads.
- R13. The critical items end inside every critical-window limit (KTD2). For the instructions these are the purpose sentence, the guide pointer, and the short disclosure; for `audit_website` they are the purpose sentence and the short disclosure.

**Order**

- R3. The instructions run in this order: the purpose and the guide pointer, inside every lead limit; which tool answers which question, with the cached reads before the two metered audits; the short disclosure; the tool and resource counts; the result envelope; the shared rate limit, the spec revision, and the endpoint.
- R4. `audit_website`'s description states the third-party contact directly after its one-sentence purpose.

**Facts**

- R5. Every fact removed from the instructions stays on at least one published surface: `content/mcp-skill.md`, `content/mcp-docs.md`, or a tool or parameter description (KTD6).
- R6. Text moves into a parameter's `.describe()` only when it describes that parameter.

**Disclosure**

- R7. The instructions and the `audit_website` description carry the same short disclosure: a default audit contacts third-party hosts the site declares, within stated caps, and `follow_declarations: false` audits only the site and returns a result that is never saved. The `follow_declarations` parameter description carries the full disclosure word for word. `content/mcp-skill.md` keeps its own full prose form, whose cap and plaintext sentences the existing tests pin. `src/worker/audit-web/follow-disclosure.ts` is the one source of both wire forms (KTD4).

**Limit record**

- R8. Every known client limit is one record in one source module, with the client, the string it applies to, the value and unit, the client version it applies from and until, the source URL (or a description when the source is not named) with the exact sentence quoted, and the date the source was read (KTD1).
- R9. Every budget, critical-window, and lead threshold is derived from those records. No limit value appears as a bare number in code under `src/` or `tests/` outside the limits module and its test (KTD2).

**Guard**

- R10. A test reads the served `initialize`, `server/discover`, and `tools/list` at every served origin. It fails when a string breaks a budget limit, a critical item ends outside a critical-window limit, a lead item ends outside a lead limit, or the R3 order breaks, and its message names the next step (KTD5).
- R11. The drift-gate pins follow the facts: a pinned fact that leaves the instructions is pinned on the surface that now carries it (KTD7).

**Constraints**

- R12. No wire field is added: no `outputSchema`, no `_meta` key, no new tool or resource.

### Key Decisions

- D1. **Budget: 4,096 characters for the whole string, with the critical items inside the first 2,048 bytes.** The whole-string budget is the limit current Claude Code applies to instructions and upfront tools since v2.1.296. The critical window is measured by the 2,048 records: Claude Code's 2,048-character cut before v2.1.296 and the tool-registry check's 2,048-byte warning. Both thresholds come from `CLIENT_LIMITS` (KTD2). The check may warn again if a string later grows past 2,048 bytes; the owner accepts that. At release the drafts measure 1,903 bytes (instructions) and 1,131 bytes (`audit_website`) at `https://anc.dev`, so the warning clears then. (session-settled: user-directed: chosen over 2,048 bytes for the whole string: current clients receive the whole text, older clients and the check receive the critical items, and a returning warning past 2,048 bytes is accepted.)
- D2. **Disclosure placement: the short form in the instructions and the `audit_website` description, the full form in the `follow_declarations` parameter description.** `content/mcp-skill.md` keeps its full prose form. The parameter description must still describe the parameter: what following sends, and that `false` turns it off. (session-settled: user-directed: chosen over the full form in the `audit_website` description: the owner's choice, confirmed after the 2,048-byte drafts were measured.)
- D3. **Pinned facts removed from the instructions.** Decided: remove them, and re-pin each where it already lives (KTD7). (session-settled: user-directed: chosen over keeping some named pins in the instructions: every removed fact already lives on a published surface, and each kept pin costs bytes against the critical window.)

### Scope Boundaries

- Considered and not built: a fail-fast length check at server construction. The strings vary only with the request origin, the guard covers every origin the Host allowlist admits at the longest port, and a throw would turn a truncated tail into a failed request for every client. A served origin outside `MCP_ALLOWED_HOSTNAMES` would change that call.
- Considered and not built: a script that re-fetches each record's source and checks its quote. The refresh is a manual step with named triggers (KTD1); a script is worth it once a record goes stale unnoticed.
- Considered and not built: a kill-switch paragraph in `content/mcp-skill.md`. The guide already states what each switch does to a client (the 503 row, the `-32022` row, the `audited: false` paths, the `WEB_AUDIT_ENABLED` and `WEB_AUDIT_FOLLOW_ENABLED` lines), the switch names are on the wire in the `audit_website` and `score_cli` descriptions, and AGENTS.md keeps operator material in the unpublished runbook.
- Not built: a budget on parameter descriptions. No client documents a cut on them. The `follow_declarations` description grows to about 1,726 characters under D2; a record with a parameter-description surface is appended if a client documents one.
- Not changed: what a website audit sends. Only the wording that describes it moves.
- Not handled: a user who sets `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` below the defaults. The server cannot see that setting.
- Not built: `_meta["anthropic/alwaysLoad"]`, `outputSchema`, or any other wire field (R12).
- Not changed: the `get_website_audit` and `score_cli` descriptions; both fit every budget and window today.

### Success Criteria

- The served instructions and every served tool description fit every budget limit, and the critical items sit inside every critical-window limit, at every served origin. The guard checks this, and one local `bun run dev` measurement recorded in the PR confirms it on the real Worker.
- After the release that carries the change reaches `anc.dev`, a re-run of the tool-registry check reports no `claude-code-metadata-length` warning. The owner's session runs the check. A later warning after the text grows past 2,048 bytes is accepted (D1).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One module records every client limit: `src/worker/mcp/client-limits.ts`.** It exports the types `MetadataSurface` (`server-instructions`, `tool-description-upfront`, `tool-description-tool-search`), `LimitUnit` (`characters`, `utf8-bytes`), `LimitEffect` (`cut`, `warn`, `lead`), and `ClientLimit`. It also exports the records `CLIENT_LIMITS`, the selectors `budgetLimits(surface)`, `criticalLimits(surface)`, and `leadLimits(surface)`, and the measure `measure(text, unit)`. A record carries `id`, `client`, `appliesTo`, `value`, `unit`, `effect`, `fromVersion` (inclusive), `untilVersion` (exclusive, or null), and `sources`. Each source is `{ url, described, quote, readOn }`: `url` is null only when the source is described rather than named, `quote` is the exact sentence, and `readOn` is an ISO date.

  `effect: 'cut'` means the client drops text past the value. `effect: 'warn'` means a check reports text past the value and nothing is dropped. `effect: 'lead'` means the source asks for the most important details within the value. The records, all read on 2026-11-11:

  | `id` | Client | Applies to | Value | Effect | From | Until | Role (KTD2) | Source and quote |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | `claude-code-all-2048` | Claude Code | instructions, upfront, tool search | 2,048 characters | cut | 2.1.84 | 2.1.295 | critical window | Changelog 2.1.84: "MCP tool descriptions and server instructions are now capped at 2KB to prevent OpenAPI-generated servers from bloating context". MCP docs: "Before v2.1.296, the shorter limit was 2,048 characters, and before v2.1.295 it applied to every tool description, including one loaded through tool search." |
  | `claude-code-upfront-2048` | Claude Code | instructions, upfront | 2,048 characters | cut | 2.1.295 | 2.1.296 | critical window | the same docs sentence |
  | `claude-code-tool-search-16384` | Claude Code | tool search | 16,384 characters | cut | 2.1.295 | | budget | Changelog 2.1.295: "Changed MCP tool descriptions the model loads through tool search to be cut at 16,384 characters instead of 2,048". MCP docs: "The description of a tool that Claude loads through tool search: 16,384 characters" |
  | `claude-code-upfront-4096` | Claude Code | instructions, upfront | 4,096 characters | cut | 2.1.296 | | budget | Changelog 2.1.296: "Changed the default limit on MCP tool descriptions sent up front and on MCP server instructions from 2,048 to 4,096 characters". MCP docs: "Server instructions, and the description of a tool that loads upfront: 4,096 characters" |
  | `tool-registry-check-2048` | a tool-registry check (`claude-code-metadata-length`) | instructions, upfront, tool search | 2,048 UTF-8 bytes | warn | | | critical window | described, not named: the check's fix line, "Keep each tool description and the server instructions field at or below 2 KB, and put critical guidance first", and its 2,048-byte threshold, as the coordinating session reported them on 2026-11-11; this plan's author did not read the check |
  | `chatgpt-codex-lead-512` | ChatGPT and Codex | instructions | 512 characters | lead | | | lead | OpenAI's MCP server guide: "Keep the most important details in the first 512 characters." |

  The changelog quotes "2KB" where the docs say "2,048 characters"; the record follows the docs. Characters are measured as UTF-16 code units (`String.length`), which equals the client's count if it counts code units and is never lower if it counts code points. UTF-8 bytes are at least the UTF-16 code-unit count for every string, so a prefix within 2,048 bytes is within 2,048 characters. Versions compare numerically per dotted segment with `compareVersions` from `src/build/scorecards.mjs`, because a string comparison sorts `2.1.84` after `2.1.295`.

  A record is refreshed, never rewritten or deleted. The triggers are each `SPEC_REVISION` bump and any report that a client cut anc's text. A reader fetches each `url`, finds the quoted sentence, and updates `quote` and `readOn` when the wording changed and the value did not. When a client changes a limit, the old record gets `untilVersion` and a new record is appended; the 2,048-to-4,096 change is the worked example. When a source stops stating a limit, the record stays and gains a source noting the removal. A TSDoc comment on `CLIENT_LIMITS` states these rules.

- KTD2. **Each threshold is a role the records play, selected by effect and version.**
  - **Budget** (`budgetLimits`): every `cut` record still in force (`untilVersion` null) whose `appliesTo` holds the surface. The whole string fits each. Today: 4,096 characters for the instructions, and 4,096 and 16,384 characters for a tool description.
  - **Critical window** (`criticalLimits`): every `cut` record with an `untilVersion`, and every `warn` record, whose `appliesTo` holds the surface. Each critical item (R13) ends inside each. Today: 2,048 characters and 2,048 bytes.
  - **Lead** (`leadLimits`): every `lead` record for the surface. The purpose sentence and the guide pointer end inside each. Today: 512 characters for the instructions.

  A tool description is checked against the records of both tool-description surfaces, because Claude Code loads a tool upfront or through tool search depending on the user's settings. No threshold exists outside the records.

- KTD3. **The instructions are six short paragraphs in R3's order.** The draft below is directional wording, joined by single spaces. It measures 1,903 bytes at `https://anc.dev` and 2,044 at `https://agentnative-site-staging.brettdavies.workers.dev:65535`, the longest served origin. At that origin the guide pointer ends at character 425 and the short disclosure at 1,370. `<origin>` is the request origin, minted per session as today.

  1. Purpose and pointer: "anc.dev scores CLI tools, websites, and the MCP servers websites declare against the agent-native standard: eight principles for software that AI agents operate. Search these tools when asked how well a CLI or a website works for agents, for its agent-readiness score or fixes, or what the principles and spec require. No authentication. Full guide: `<origin>/mcp-skill.md`."
  2. Routing, cached reads first: "Read the cache first; it costs no audit. get_scorecard (a CLI) and get_website_audit (a website) return { found: false, next_tool } on a miss. Only then run a metered audit: score_cli (5 fresh audits per 60 minutes per IP) or audit_website (30 fresh audits per 60 minutes per IP). Browse with list_tools, search_tools, get_tool, and list_website_audits; read the standard with list_principles, get_principle, list_spec_sections, and get_spec_section; get_web_remediation returns the fix for a failed website check."
  3. `FOLLOW_DISCLOSURE_SHORT` (KTD4).
  4. Surface: "13 tools and 5 resources (anc://registry plus 4 templates); full schemas are on tools/list and resources/templates/list."
  5. Envelope: "Scorecard tools return one envelope { kind, tier, target, scorecard_url, markdown_url, json_url, freshness, spec_version, scorecard }, the JSON json_url serves; web scorecard fields are at `<origin>/web-scorecard-schema`. Check isError first: a cache miss is isError: false with next_tool, not a failure."
  6. "Every call shares 60 requests per 60 seconds per IP; a breach returns JSON-RPC -32099. Spec revision 2026-07-28. Connect now at `<origin>/mcp`."

  The numbers stay interpolated from the constants `src/worker/mcp/instructions.ts` already holds.

- KTD4. **`src/worker/audit-web/follow-disclosure.ts` exports both disclosure forms.** `FOLLOW_DISCLOSURE` keeps its text. `FOLLOW_DISCLOSURE_SHORT` is new. Both are built from the same cap constants: the short form carries the per-audit host cap and the per-domain hourly cap, and the full form carries all four caps. The module comment says so. The short form's draft, 428 characters at today's values, reads in both the instructions and the tool description: "By default a website audit also contacts third-party hosts the site declares (its MCP server, its API host), including JSON-RPC POSTs to a declared MCP server once its own documents confirm it, at most `MAX_FOLLOWED_HOSTS` hosts per audit and about `DECLARED_DOMAIN_HOURLY_CEILING` audits per hour per declared domain; follow_declarations: false audits only the site and returns a result that is never saved. The follow_declarations parameter describes what each host receives."

  `audit_website`'s description becomes one purpose sentence, then `FOLLOW_DISCLOSURE_SHORT`, then the tool's own facts. Its draft measures 1,131 bytes, all ASCII, with the short form ending at character 597:

  > Run a fresh website agent-readiness audit and return one terminal scorecard, with no progress notifications; get_website_audit reads the cache without running an audit. `FOLLOW_DISCLOSURE_SHORT` A result under 1 minute old is returned without re-running, and a cached result is still served as-is when the audit is disabled. Results carry cached (false only when this call ran the audit), scored_at (when it ran, null on a legacy entry), and refresh_after (when the 1-minute reuse window ends: eligibility, not a promise a fresh audit will run). Disabled when WEB_AUDIT_ENABLED or MCP_ENABLED is not "true"; a per-IP burst limit and 30 fresh audits per 60 minutes per IP apply; a request without cf-connecting-ip returns -32099.

  It keeps every substring the existing description tests assert (`cached`, `scored_at`, `refresh_after`, `not a promise`) and `MCP_ENABLED`, and it closes the unbalanced parenthesis after "null on a legacy entry".

  The `follow_declarations` parameter description becomes its own first sentence, then `FOLLOW_DISCLOSURE`, then what `false` adds that the full form does not say. Its draft measures about 1,726 characters: "Follow the hosts the site declares (its MCP server, its API host) and score them with the site; defaults to true." + `FOLLOW_DISCLOSURE` + "With false the result is transient: never cached, never listed, no scorecard_url, markdown_url, or json_url, and never joined to another caller's run; a public_listing that differs from the stored choice is rejected." Every sentence says what following sends, what bounds it, or what `false` changes, so the text describes the parameter (R6, D2).

- KTD5. **The guard is `tests/mcp-client-limits.test.ts`, reading the served strings.** For each host in `MCP_ALLOWED_HOSTNAMES` (exported from `src/worker/mcp/server.ts`), the origin is `https://<host>:65535`. The Host check strips the port, and that origin is the longest one the server can mint for the host. At each origin the test calls `mcpRpcExpect200` for a legacy `initialize`, a modern `server/discover`, and `tools/list`. It checks:
  - the answers are real: the tool names equal `EXPECTED_TOOL_NAMES` from `tests/helpers/mcp-tools.ts`, the instructions and every description are non-empty, `initialize` and `server/discover` return the same instructions, and each selector returns at least one record for each surface it is asked about;
  - every string fits every budget limit for its surfaces, in each limit's unit;
  - the purpose sentence and `<origin>/mcp-skill.md` end inside every lead and critical-window limit for the instructions;
  - `<origin>/mcp-skill.md` comes before `get_scorecard`, which comes before `score_cli`;
  - the records are well formed: unique `id`s, at least one source each, a `url` or a `described` text on every source, a non-empty `quote`, an ISO `readOn`, and `fromVersion` before `untilVersion` under `compareVersions` when both are set;
  - `measure` counts an em-dash as 1 character and 3 bytes, and an astral character as 2 characters and 4 bytes.

  U2 extends the same file once `FOLLOW_DISCLOSURE_SHORT` exists:
  - the short form ends inside every critical-window limit in the instructions and in `audit_website`'s description;
  - in the instructions, `score_cli` comes before the short form, which comes before "Every call shares";
  - in `audit_website`'s description, the short form follows the first sentence directly.

  Each failure names the string, the origin, the record `id`, the measured length, and the value. It ends with the next step: "shorten it, or move a fact it carries to content/mcp-skill.md; the limits and their sources are in src/worker/mcp/client-limits.ts".

- KTD6. **Where each fact in today's instructions goes.**

  | Fact in today's instructions | Fate | Where it lives after the change |
  | --- | --- | --- |
  | What the server is; no authentication | stays | KTD3 paragraph 1 |
  | Spec revision `2026-07-28` | stays | paragraph 6 |
  | Accept negotiation, both MIME types, `*/*`, q-values, 406 with no envelope | moves out (D3) | already in `content/mcp-skill.md`: the Accept-header negotiation paragraph and table under "Wire-level reference", and the 406 row under "When things fail" |
  | 13 tools and their names | stays | paragraphs 2 and 4 name all 13 |
  | 5 resources | stays | paragraph 4 |
  | The four resource template URIs | moves out | already in `content/mcp-skill.md` under "Resources (direct URI lookup)" |
  | Schemas on `tools/list` and `resources/templates/list` | stays | paragraph 4 |
  | Web tools score a site and its MCP server on the eight principles | stays | paragraph 1 |
  | `get_website_audit` miss returns `next_tool: audit_website` | stays | paragraph 2 |
  | `audit_website` returns one terminal scorecard, no progress notifications | moves out | `audit_website` description (KTD4); `content/mcp-skill.md` under "Audit a website" |
  | `list_website_audits` curated board; `get_web_remediation` fix by check id | stays | paragraph 2 |
  | Bare and `www.` host fold rule | moves out | both web tools' `url` parameter descriptions; the "Bare and `www.` hosts" paragraph under "Audit a website" in `content/mcp-skill.md` |
  | Web scorecard shape at `/web-scorecard-schema` | stays | paragraph 5 |
  | Result envelope fields | stays | paragraph 5 |
  | Envelope equals `/score/<target>/json` | stays, shortened | paragraph 5 ("the JSON json_url serves"); the exact path is in `content/mcp-skill.md` |
  | Follow `scorecard_url`, `markdown_url`, `json_url` | moves out | `content/mcp-skill.md` under "Get a scorecard" and "Audit a website" |
  | URLs are null for an unsaved CLI run (`summary.error` above 0) or an unfollowed web run | moves out | `score_cli` description; `follow_declarations` parameter description; `content/mcp-skill.md` |
  | Two error layers; check `isError` | stays, shortened | paragraph 5; full table under "When things fail" in `content/mcp-skill.md` |
  | `-32099` for a rate-limit breach | stays | paragraph 6 |
  | `-32022`, `-32700`, `-32600`, `-32020`, `-32000` with their HTTP statuses; send no `Origin` | moves out | already in the table under "When things fail" in `content/mcp-skill.md` |
  | 60 per 60 seconds per IP on every call | stays | paragraph 6 |
  | 5 fresh `score_cli` audits per 60 minutes per IP | stays | paragraph 2 |
  | 30 fresh `audit_website` audits per 60 minutes per IP | stays | paragraph 2 |
  | Binding names `MCP_LIMITER`, `MCP_AUDIT_LIMITER`, `WEB_AUDIT_LIMITER_IP` | moves out (D3) | already in `content/mcp-skill.md` under "Rate limits you'll actually hit" and "Audit a website"; `score_cli` description |
  | Keyed on `cf-connecting-ip`; anon fallback on the read tier only | moves out | already under "Rate limits you'll actually hit" in `content/mcp-skill.md`; both audit tool descriptions |
  | The five kill switches and what each one does | moves out (D3) | effects already in `content/mcp-skill.md` (the 503 and `-32022` rows under "When things fail", the `audited: false` paths under "Get a scorecard", the `WEB_AUDIT_ENABLED` and `WEB_AUDIT_FOLLOW_ENABLED` lines under "Audit a website"); names on the wire in the `audit_website`, `score_cli`, and `follow_declarations` descriptions |
  | Full third-party disclosure | moves out (D2) | `follow_declarations` parameter description; the "Declared hosts" paragraph under "Audit a website" in `content/mcp-skill.md` |
  | Default contacts declared hosts, within caps; `follow_declarations: false` audits only the site, never saved | stays (D2) | paragraph 3 (`FOLLOW_DISCLOSURE_SHORT`) |
  | Server card advertises the same revision, bumped in lockstep | moves out | already in the "Transport" paragraph under "Wire-level reference" in `content/mcp-skill.md` |
  | `Connect now at <origin>/mcp` | stays | paragraph 6 |
  | `GET /mcp` returns 405; endpoint description at `/mcp-docs` | moves out | already in the "Endpoint" paragraph under "Wire-level reference" in `content/mcp-skill.md` |
  | Full guide at `<origin>/mcp-skill.md` | stays, moved to the lead | paragraph 1 |

  `content/mcp-skill.md` and `content/mcp-docs.md` need no change.

- KTD7. **The drift gate keeps every pinned fact; each one is asserted on the surface that carries it.**

  | Pin today | Change |
  | --- | --- |
  | `tests/worker-mcp.test.ts`: `13 tools`, `5 resources`, `60 requests per 60 seconds`, `5 fresh audits per 60 minutes`, `2026-07-28`, `https://anc.dev/mcp-skill.md`, `Connect now at https://anc.dev/mcp`, `tools/list`, `resources/templates/list` | unchanged |
  | `tests/worker-mcp.test.ts`: `application/json`, `text/event-stream` in the instructions | asserted on `content/mcp-skill.md` |
  | `tests/worker-mcp.test.ts`: `MCP_LIMITER`, `MCP_AUDIT_LIMITER` in the instructions | asserted on `content/mcp-skill.md` |
  | `tests/worker-mcp.test.ts`: `MCP_ENABLED`, `MCP_LIVE_SCORING_ENABLED` in the instructions | asserted on the `audit_website` and `score_cli` descriptions |
  | `tests/worker-mcp.test.ts`: `toContain(FOLLOW_DISCLOSURE)` and the cap sentences in the instructions | the instructions assert `FOLLOW_DISCLOSURE_SHORT` and not `FOLLOW_DISCLOSURE` |
  | `tests/worker-mcp.test.ts`: `only the following of declared hosts (WEB_AUDIT_FOLLOW_ENABLED)` | dropped; `WEB_AUDIT_FOLLOW_ENABLED` is asserted on the `follow_declarations` parameter description |
  | `tests/worker-mcp.test.ts`: the plaintext sentence in the instructions | asserted on the `follow_declarations` parameter description; the `content/mcp-skill.md` assertion stays |
  | `tests/web-audit-mcp-tools.test.ts`: the cap and probe clauses on the `audit_website` description | asserted on the `follow_declarations` parameter description, plus `toContain(FOLLOW_DISCLOSURE)` |
  | `tests/web-audit-mcp-tools.test.ts`: the fold clause in the instructions ("the session instructions carry the fold clause, both halves") | dropped; the same file already pins the fold rule on both `url` parameter descriptions |

  `tests/e2e/mcp.e2e.ts`, `tests/worker-mcp-dispatch.test.ts`, and `tests/site-origin.test.ts` pin only facts that stay, so they do not change. AGENTS.md § MCP server keeps its description of `initialize.instructions` (client-skill pointer plus a session-time summary) and its spec-revision drift-gate paragraph. It gains one sentence: `server/discover` carries the same instructions, the instructions and every tool description stay within the limits recorded in `src/worker/mcp/client-limits.ts` (which `tests/mcp-client-limits.test.ts` enforces), and those records are refreshed on each `SPEC_REVISION` bump.

### Assumptions

- The tool-registry check measures the strings the server sends at `https://anc.dev`, in UTF-8 bytes, with its threshold at 2,048 bytes as reported. Its fix line says "2 KB"; if the threshold is 2,000 bytes, the release drafts (1,903 and 1,131 bytes) still clear it.
- Claude Code counts characters as JavaScript string length. Either way, the measure in KTD1 never undercounts.
- No MCP client documents a cut on parameter descriptions. None was found in the Claude Code, OpenAI, Gemini CLI, Cursor, or VS Code documentation read for this plan.
- The hints PR changes annotations and the `content/mcp-skill.md` paragraph on tool metadata only, not description text. Verified on its branch head on 2026-11-11; re-check when implementation starts.

### Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| The instructions grow past the critical window and push the short disclosure or the guide pointer out of an older client's view. | The guard fails with the record `id` and the next step. Text after the short disclosure (counts, envelope, limits) moves to `content/mcp-skill.md` first. |
| A client starts cutting parameter descriptions, and the full disclosure sits in one. | `content/mcp-skill.md` keeps the full prose form; a record for that surface is appended and the guard picks it up. |
| An agent that read error codes or binding names from the instructions now has to fetch the guide. | Paragraph 1 points at the guide inside 512 characters, and `content/mcp-skill.md` carries every code and binding. |
| A client page changes its limit or wording. | KTD1's refresh rule and triggers. |
| The hints PR and this PR both edit `tests/worker-mcp.test.ts` and `src/worker/mcp/tools/web-audit.ts`. | Different hunks (the tools/list block and the drift block; annotation lines and the description and parameter strings). Whichever merges second rebases onto `dev` and re-runs the guard. |
| A new served host longer than the staging host. | The guard reads `MCP_ALLOWED_HOSTNAMES`, so a new host is measured the day it is added. |

### Deferred to Implementation

- The final wording of each paragraph, of `audit_website`'s own text, and of the `follow_declarations` sentences around the full form, within the limits and the facts KTD3, KTD4, and KTD6 keep.
- Whether the drift block's moved assertions live in `tests/worker-mcp.test.ts` or in the guard file.

### Sources & Research

All read on 2026-11-11.

- Claude Code MCP docs, § Tool search for MCP server authors: <https://code.claude.com/docs/en/mcp>. It sets the two default limits, the version history, `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` (v2.1.280 and later), and "Keep descriptions and instructions concise, and put critical details near the start". It asks that server instructions explain what category of tasks the tools handle, when Claude should search for them, and the key capabilities (KTD3 paragraph 1).
- Claude Code changelog entries for 2.1.84, 2.1.280, 2.1.295, and 2.1.296: <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md> (KTD1 versions).
- MCP specification 2026-07-28. `server/discover` defines `instructions` as "Optional natural-language guidance for LLMs on how to use this server effectively": <https://modelcontextprotocol.io/specification/2026-07-28/server/discover>. `basic/lifecycle` redirects to `basic/versioning` at this revision, because the handshake is gone; the legacy `InitializeResult.instructions` is defined at <https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle>. The schema's `DiscoverResult.instructions` says it "should not duplicate information already in tool descriptions", and `Tool.description` "can be thought of like a 'hint' to the model": <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts>. The specification sets no length limit on either string; only tool names SHOULD be 1 to 128 characters: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>.
- OpenAI's MCP server guide for ChatGPT and Codex: <https://developers.openai.com/plugins/build/mcp-server>. It asks for "the most important details in the first 512 characters" and says not to repeat every tool description. It documents no cut.
- No documented limit on instructions or tool descriptions was found for Gemini CLI (<https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md>, which appends instructions to the system instructions and truncates only tool names past 63 characters), Cursor (<https://cursor.com/docs/mcp>), or VS Code (<https://code.visualstudio.com/docs/copilot/customization/mcp-servers>). Reports of other clients' cuts from third-party testing are not vendor-documented and are not recorded.
- Repo precedent: `tests/webmcp.test.ts` already enforces the WebMCP name and description caps beside the tools they bound; `docs/solutions/conventions/pin-wire-contract-error-codes-per-lane-in-tests-when-swapping-sdk-majors.md` holds that wire-contract facts get pinned in tests on the surface that states them.

---

## Implementation Units

Order of work: U1, U5, U2, U3, U4. U5 comes second so it is observed failing on the unchanged strings.

### U1. Client limit records

- **Goal:** the module KTD1 describes, with its six records and the selectors and measure KTD1 and KTD2 name.
- **Requirements:** R8, R9.
- **Dependencies:** none.
- **Files:** `src/worker/mcp/client-limits.ts` (new); `src/worker/mcp/server.ts` (export `MCP_ALLOWED_HOSTNAMES`); `tests/mcp-client-limits.test.ts` (new, record and `measure` cases).
- **Approach:**
  1. Write the types and records as KTD1 lists them, quotes verbatim from Sources, `readOn` 2026-11-11.
  2. Write the three selectors as KTD2 defines them.
  3. Add the TSDoc refresh rule and its triggers on `CLIENT_LIMITS`.
  4. Export the existing Host allowlist constant; its value does not change.
- **Patterns to follow:** `WEBMCP_EXECUTE_MAX` in `src/client/webmcp-lib.ts` for a documented external cap; `compareVersions` in `src/build/scorecards.mjs`; the closed string unions in `src/worker/telemetry/log.ts`.
- **Test scenarios:**
  - Every record has a unique `id`, at least one source, a `url` or `described` on each source, a non-empty `quote`, and an ISO `readOn`.
  - `fromVersion` sorts before `untilVersion` under `compareVersions` on every record that has both.
  - A string of two ASCII letters around one U+2014 measures 3 characters and 5 bytes.
  - An astral character measures 2 characters and 4 bytes.
  - `budgetLimits('server-instructions')` includes `claude-code-upfront-4096` and excludes `claude-code-all-2048`, `claude-code-upfront-2048`, and `tool-registry-check-2048`.
  - `criticalLimits('server-instructions')` includes `claude-code-all-2048`, `claude-code-upfront-2048`, and `tool-registry-check-2048`, and excludes `claude-code-upfront-4096`.
  - `leadLimits('server-instructions')` includes `chatgpt-codex-lead-512`.
- **Verification:** the record tests pass and `bun run typecheck` is clean.

### U5. Length guard against the served strings

- **Goal:** the test KTD5 describes, failing on today's strings before U2 and U3 change them.
- **Requirements:** R1, R2, R3, R10, R13.
- **Dependencies:** U1.
- **Files:** `tests/mcp-client-limits.test.ts`; `tests/helpers/mcp-modern.ts` (a `server/discover` body and headers beside the existing `tools/list` helpers).
- **Approach:**
  1. Build one origin per allowlisted host as KTD5 states.
  2. Read `initialize`, `server/discover`, and `tools/list` through `mcpRpcExpect200` with that origin.
  3. Run KTD5's first check list, reporting every failure in one message with its next step.
- **Execution note:** run the guard against the unchanged instructions first, and quote the failure in the PR. Today's instructions measure about 6,000 characters at the staging origin, past `claude-code-upfront-4096`; the guide pointer sits past every critical-window limit and after `score_cli`.
- **Patterns to follow:** `mcpRpcExpect200` and `STAGING_TEST_ORIGIN` in `tests/helpers/mcp-rpc.ts`; the origin cases in `tests/site-origin.test.ts`; `EXPECTED_TOOL_NAMES` in `tests/helpers/mcp-tools.ts`.
- **Test scenarios:**
  - At each origin, the instructions from `initialize` equal those from `server/discover`, and both fit every budget limit for `server-instructions`.
  - Every `tools/list` description fits every budget limit for both tool-description surfaces.
  - At each origin, the purpose sentence and `<origin>/mcp-skill.md` end inside every lead and critical-window limit.
  - `<origin>/mcp-skill.md` comes before `get_scorecard`, which comes before `score_cli`.
  - The tool names equal `EXPECTED_TOOL_NAMES`, and no string under test is empty.
  - On the unchanged code, the test fails naming the instructions, the record `id`, the measured length, and the next step.
- **Verification:** observed failing before U3, passing after.

### U2. Disclosure forms, the `audit_website` description, and the `follow_declarations` parameter

- **Goal:** `FOLLOW_DISCLOSURE_SHORT`, the `audit_website` description, and the `follow_declarations` parameter description from KTD4.
- **Requirements:** R2, R4, R6, R7, R13.
- **Dependencies:** U1, U5.
- **Files:** `src/worker/audit-web/follow-disclosure.ts`; `src/worker/mcp/tools/web-audit.ts`; `tests/web-audit-mcp-tools.test.ts`; `tests/mcp-client-limits.test.ts`.
- **Approach:**
  1. Add the short form from the cap constants and update the module comment.
  2. Rewrite the `audit_website` description in KTD4's order, ASCII only.
  3. Rewrite the `follow_declarations` description as KTD4 states, and leave every other parameter description unchanged (R6).
  4. Move the disclosure assertions as KTD7 states, and add KTD5's short-form checks to the guard.
- **Patterns to follow:** the existing `FOLLOW_DISCLOSURE` construction from `MAX_FOLLOWED_HOSTS`, `MAX_FOLLOW_REQUESTS`, `FOLLOW_SLICE_MS`, and `DECLARED_DOMAIN_HOURLY_CEILING`.
- **Test scenarios:**
  - The `follow_declarations` parameter description contains `FOLLOW_DISCLOSURE` word for word, the moved cap and probe clauses, the plaintext sentence, and `WEB_AUDIT_FOLLOW_ENABLED`, and its type is still boolean.
  - The `audit_website` description holds `FOLLOW_DISCLOSURE_SHORT` directly after its first sentence and does not hold `FOLLOW_DISCLOSURE`.
  - The short form contains the fixed text `at most 4 hosts per audit`, `about 30 audits per hour per declared domain`, `JSON-RPC POSTs`, and `follow_declarations: false audits only the site`.
  - `cached`, `scored_at`, `refresh_after`, and `not a promise` still appear in both web read-tool descriptions, and `MCP_ENABLED` in the `audit_website` description.
  - In `audit_website`'s description the short form ends inside every critical-window limit.
- **Verification:** U5 and the moved disclosure tests pass for `audit_website`.

### U3. Instructions rewrite and drift gate

- **Goal:** the instructions from KTD3 and every pin move from KTD7.
- **Requirements:** R1, R3, R5, R7, R11, R13.
- **Dependencies:** U2.
- **Files:** `src/worker/mcp/instructions.ts`; `tests/worker-mcp.test.ts`; `tests/web-audit-mcp-tools.test.ts`.
- **Approach:**
  1. Rebuild `buildInstructionsText` as the six paragraphs, using `FOLLOW_DISCLOSURE_SHORT`.
  2. Rewrite the module header comment in present tense: what the string carries, that its URLs follow the request origin, and that the drift tests pin its literals. Drop the plan and unit tags.
  3. Move each pin as KTD7's table says, including the `content/mcp-skill.md` and tool-description targets.
- **Patterns to follow:** the current per-origin `siteUrl` threading in `buildInstructionsText`.
- **Test scenarios:**
  - The pins KTD7 keeps still pass.
  - The instructions contain `FOLLOW_DISCLOSURE_SHORT` and no longer contain `FOLLOW_DISCLOSURE`.
  - `content/mcp-skill.md`, whitespace-flattened, contains `application/json`, `text/event-stream`, `MCP_LIMITER`, and `MCP_AUDIT_LIMITER`.
  - The `audit_website` description contains `MCP_ENABLED`, and the `score_cli` description contains `MCP_LIVE_SCORING_ENABLED`.
  - In the instructions, the short form ends inside every critical-window limit and sits between `score_cli` and "Every call shares".
  - At the staging origin the instructions name the staging guide and endpoint URLs (the `tests/site-origin.test.ts` case still passes).
- **Verification:** U5 passes in full at every origin.

### U4. AGENTS.md

- **Goal:** AGENTS.md § MCP server names the limit records, the guard, and the refresh trigger.
- **Requirements:** R8.
- **Dependencies:** U3.
- **Files:** `AGENTS.md`.
- **Approach:** add the one sentence KTD7 gives, beside the existing description of `initialize.instructions`.
- **Test expectation:** none; prose only, checked by the pre-push prose gate.
- **Verification:** the sentence names `src/worker/mcp/client-limits.ts`, `tests/mcp-client-limits.test.ts`, and the `SPEC_REVISION` trigger.

---

## Verification Contract

| Gate | Command or check | Proves |
| --- | --- | --- |
| Lint and types | `bun run lint`, `bun run typecheck` | style, types, knip reachability of the new module |
| Build first | `bun run build` | `dist/` matches the branch before tests read it (AGENTS.md gate order) |
| Unit | `bun test` | U1 to U3 scenarios and every moved pin |
| Observed failing | U5 run against the unchanged strings, failure output quoted in the PR | the guard detects the overage it exists for |
| Local Worker | `bun run dev` with `MCP_ENABLED="true"` in `.dev.vars.staging`; one `initialize`, one `server/discover`, one `tools/list`; byte and character counts recorded in the PR | the served strings, not the builders, fit |
| Diff check | the PR diff adds no `outputSchema`, `_meta` key, tool, or resource; among parameter descriptions only `follow_declarations` changes; the diff adds no 512, 2048, 4096, or 16384 literal under `src/` or `tests/` outside `client-limits.ts` and its test | R6, R9, R12 |
| Staging | `tests/e2e/mcp.e2e.ts` after the `dev` deploy | the unchanged staging pins still hold |
| Reviews | `ce-code-review` and `/devex-review`, one round each on Opus, verdicts in PR comments | code and prose; the agent-facing instructions, descriptions, and parameter text |

`/cso` is not run: the change alters no credential, auth, request, or input handling, and what the disclosure says and where is owner-decided (D2). The PR body records that reason.

## Definition of Done

- R1 to R13 hold, each covered by a test scenario, the local Worker measurement, or the diff check.
- No limit value appears as a bare number in code under `src/` or `tests/` outside `src/worker/mcp/client-limits.ts` and its test.
- The PR's `## Changelog` carries: "Fixed: the MCP server instructions now fit the 4,096 characters Claude Code delivers whole, and lead with what the server is for, the guide link, which tool to call first, and what a website audit sends to third-party hosts. The `audit_website` description carries the short third-party disclosure, and its `follow_declarations` parameter carries the full one."
- No dead-end code from abandoned approaches remains in the diff.

---

## Review log

- 2026-11-11: plan written.
- 2026-11-11: `/plan-eng-review` round 1 started at 5a47b76 (Opus, effort high).
- 2026-11-11: `/plan-devex-review` round 1 started at 5a47b76 (Opus, effort high).
- 2026-11-11: `/compound-engineering:ce-doc-review` round 1 started at 5a47b76 (Opus, effort high, non-interactive).
- 2026-11-11: owner decision folded in: D3 (a), the pinned facts leave the instructions and are re-pinned where KTD7 says. D1 and D2 wait for the owner.
- 2026-11-11: `/plan-eng-review` round 1 ended on 5a47b76: 0 P0, 1 P1 (a fold-clause pin on the instructions that KTD7 missed), 5 P2, 3 P3. It ran as a direct engineering review on Opus, because `/plan-eng-review` is installed here only inside the gstack skill set and not as a skill of its own. All folded in: the guard checks it reads real answers, versions compare numerically, the check's record is `warn`, every origin carries port 65535, the lead check runs per origin, the short-form test asserts fixed text, and the no-literal rule covers code only.
- 2026-11-11: `/plan-devex-review` round 1 ended on 5a47b76: 0 P0, 0 P1, 6 P2, 9 P3. All folded in except naming the tool-registry check: this repo's public text does not name it, the record says its quote is reported, and Claude Code's 2,048-character records hold the same critical window. Its four questions were settled from the plan's evidence. The short form moves to paragraph 3 and names the JSON-RPC POSTs. The no-progress clause stays in `audit_website`. A record refresh runs on each `SPEC_REVISION` bump and on any report of a cut.
- 2026-11-11: `/compound-engineering:ce-doc-review` round 1 ended on 5a47b76: 0 P0, 0 P1, 7 P2, 8 P3. All folded in. Its finding 5 replaced the planned kill-switch paragraph in the guide with pins on the tool descriptions that already name the switches, because AGENTS.md keeps operator material in the unpublished runbook. Its D3 and D1 wording findings closed with the owner's answers, and the three scope cuts it rejected stay out.
- 2026-11-11: owner decisions folded in: D1, 4,096 characters for the whole string with the critical items inside the 2,048 records; D2, the short form in the instructions and the `audit_website` description and the full form in the `follow_declarations` parameter description.
- 2026-11-11: implementation of U1 to U5 pushed as PR #563 (draft) at c092602.
- 2026-11-11: `ce-code-review` round 1 started at c092602 (Opus, effort high).
- 2026-11-11: `/devex-review` round 1 started at c092602 (Opus, effort high, local Worker only).
- 2026-11-11: `/devex-review` round 1 ended at 8828429: 0 P0, 0 P1, 1 P2, 8 P3. Fixed: the `audit_website` description names the `freshness.` paths and both refusal shapes, the `follow_declarations` text states each fact once, the short disclosure's cap sentence reads as a cap across callers, the lead says "Use these tools", the browse line names the registry and the leaderboard, and the envelope sentence reads straight. Not changed: an `in_progress` sentence in the instructions (the string would pass 2,048 bytes at `https://anc.dev`, and the read-tool descriptions and the guide carry it), `Connect now at` (pinned), and text outside this change (older tool descriptions, the guide's rate-limit table).
