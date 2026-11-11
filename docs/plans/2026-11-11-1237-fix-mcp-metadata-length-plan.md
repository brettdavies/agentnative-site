---
artifact_contract: ce-unified-plan/v1
execution: code
product_contract_source: ce-plan-bootstrap
title: "Fit the MCP server instructions and tool descriptions inside client truncation limits - Plan"
type: fix
status: proposed
date: 2026-11-11
topic: mcp-metadata-length
---

# Fit the MCP server instructions and tool descriptions inside client truncation limits - Plan

## Goal Capsule

- **Objective:** an agent connected to `https://anc.dev/mcp`, on any client whose limit this plan records, receives the whole server instructions and the whole of every tool description, and reads first what the server is for, which tool to call first, what an audit sends to third-party hosts, and where the full guide lives.
- **Means:** rewrite the instructions as a lead-first summary, tighten `audit_website`, record every known client limit in one module, and enforce those limits with a test against the strings the server sends (KTD1 to KTD7).
- **Authority:** Product Contract requirements win on behavior, Key Technical Decisions win on mechanism, and units override neither. The owner decisions D1 to D3 bind both.
- **Execution profile:** code. One PR from a `fix/` branch cut from `dev` (which holds #557 at `082d380`), built alongside the hints PR (`fix/mcp-read-tool-hints`). Units U1 to U5 land in that PR.
- **Stop conditions:**
  - D1, D2, or D3 is unanswered when implementation starts. Stop: each one changes the text the units write.
  - The full follow disclosure does not fit `audit_website` under the budget once the tool's own text carries only the facts KTD4 keeps. Stop and report; the fallback is D2's option (b), an owner call.
  - Fitting a string needs a fact removed that no published surface carries after U4. Stop and report.
- **Who finishes:** an agentnative-site session builds the PR, runs `ce-code-review` and `/devex-review`, and hands it to Brett for merge approval to `dev`.

---

## Product Contract

### Summary

The MCP server's instructions run to 5,759 characters at `https://anc.dev` and the `audit_website` description to 2,458 UTF-8 bytes, past the 2,048-byte point a tool-registry check warns at and past the cut Claude Code applies. This plan shortens the instructions to a lead-first summary that points at the published guide, keeps the full third-party disclosure in `audit_website`'s description and the guide, records each client limit with its source in code, and adds a test that fails when any served string passes a recorded limit.

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
| Longest parameter description | 450 bytes (`get_website_audit.url`) | same | |

The brief's figures (5,608 bytes, disclosure at character 3,836) hold on `738d710`; #557 added 151 characters to the web-tools paragraph.

What a client loses today:

- **Current Claude Code** (4,096-character cut on instructions): the cut lands 109 characters into `FOLLOW_DISCLOSURE`, which starts at character 3,987. The agent never sees which hosts are contacted, the caps, the opt-out, the spec-revision sentence, or the "Connect now ... Full recipes at `/mcp-skill.md`" pointer. On staging the cut lands 27 characters in.
- **Claude Code before v2.1.296** (2,048-character cut on instructions and on a tool loaded upfront): the instructions stop inside the result-envelope paragraph, before the errors, the rate limits, the disclosure, and the pointer. `audit_website` loses the last 406 characters of its disclosure, including the opt-out sentence.

The instructions also break the specification's own guidance: they repeat `FOLLOW_DISCLOSURE` word for word from the `audit_website` description, and `DiscoverResult.instructions` "should not duplicate information already in tool descriptions" (Sources).

### Requirements

**Length**

- R1. The server instructions fit every limit enforced under D1, measured in each limit's own unit, at every origin the server answers on.
- R2. Every tool description fits the same limits, under both the upfront and the tool-search surface, because the client decides how a tool loads.

**Order**

- R3. The instructions lead with what the server is for, when to search its tools, and the pointer to the full guide, inside the first 512 characters. Next comes which tool answers which question, with the free cached reads before the two metered audits, then the short disclosure, then the shared rate limit and the spec revision.
- R4. `audit_website`'s description states the third-party contact directly after its one-sentence purpose.

**Facts**

- R5. Every fact removed from the instructions stays on at least one published surface: `content/mcp-skill.md`, `content/mcp-docs.md`, or a tool description (KTD6).
- R6. Text moves into a parameter's `.describe()` only when it describes that parameter.

**Disclosure**

- R7. The instructions say that a default audit contacts third-party hosts the site declares, and that `follow_declarations: false` audits only the site and returns a result that is never saved. The full disclosure stays word for word in `audit_website`'s description and in `content/mcp-skill.md` § Audit a website. Both texts come from one source module (KTD4, D2).

**Limit record**

- R8. Every known client limit is one record in one source module, with the client, the string it applies to, the value and unit, the client version it applies from and until, the source URL (or a description when the source is not named) with the exact sentence quoted, and the date the source was read (KTD1).
- R9. The budget is derived from those records. No limit value appears as a bare number anywhere else (KTD2).

**Guard**

- R10. A test reads the served `initialize`, `server/discover`, and `tools/list` at every served origin. It fails when the instructions or a tool description passes an enforced limit, in that limit's unit, or when a critical item is missing, out of order, or outside its lead window (KTD5).
- R11. The drift-gate pins follow the facts: a pinned fact that leaves the instructions is pinned on the surface that now carries it (KTD7).

**Constraints**

- R12. No wire field is added: no `outputSchema`, no `_meta` key, no new tool or resource.

### Key Decisions

Owner decisions. Each is open until the owner answers; the plan carries the recommended option, and an answer is folded in here and in the KTDs it changes.

- D1. **Budget target.** Pending owner. Recommended: (a) honor every recorded limit, which makes 2,048 UTF-8 bytes the binding limit for the instructions and every tool description. Options:
  - (a) 2,048 UTF-8 bytes. Clears the tool-registry check, fits Claude Code from v2.1.84 through v2.1.295 (2,048 characters) and v2.1.296 onward (4,096), and follows ChatGPT and Codex guidance. The instructions draft fits at 1,829 bytes at the longest origin and the `audit_website` draft at 1,956 bytes (KTD3, KTD4).
  - (b) 4,096 characters (current Claude Code). Less rewriting; the check still warns, and an older Claude Code still cuts at 2,048 characters. Requires an `enforced` flag on each record so the guard can skip the 2,048 records.
  - (c) 4,096 characters in total, with the critical items inside the first 2,048 bytes. Older clients keep the critical items; the check still warns.
- D2. **What the instructions tell agents about third-party traffic.** Pending owner. Recommended: (a). Options:
  - (a) The instructions carry a short form (about 325 characters: declared hosts contacted by default, the per-audit and per-domain caps, `follow_declarations: false` audits only the site and is never saved, and where the full form is). `audit_website`'s description keeps the full form word for word, moved to follow its purpose sentence. `content/mcp-skill.md` keeps its full form.
  - (b) The short form in both the instructions and `audit_website`'s description, with the full form only in `content/mcp-skill.md` and the `follow_declarations` parameter's own effect sentence. This leaves the most headroom, but it moves the full disclosure off the wire.
  - (c) The full form stays in the instructions. Fits only under D1 (b) or (c), and duplicates the tool description against the specification's guidance.
- D3. **Pinned facts removed from the instructions.** Pending owner. Recommended: remove them, and re-pin each where it already lives (KTD7). The pins are the Accept MIME types (`application/json`, `text/event-stream`), the binding names `MCP_LIMITER` and `MCP_AUDIT_LIMITER`, the kill-switch names `MCP_ENABLED` and `MCP_LIVE_SCORING_ENABLED` with the `WEB_AUDIT_FOLLOW_ENABLED` clause, the full disclosure with its cap sentences, and the plaintext sentence. The other pins stay in the instructions: `13 tools`, `5 resources`, both rate-limit literals, `2026-07-28`, `<origin>/mcp-skill.md`, `Connect now at <origin>/mcp`, `tools/list`, and `resources/templates/list`.

### Scope Boundaries

- Considered and not built: a fail-fast length check at server construction. The strings vary only with the request origin, the guard covers every origin the Host allowlist admits, and a throw would turn a truncated tail into a failed request for every client. A served origin outside `MCP_ALLOWED_HOSTNAMES` would change that call.
- Considered and not built: a script that re-fetches each record's source and checks its quote. The refresh is a manual step (KTD1); a script is worth it once a record goes stale unnoticed.
- Not built: a budget on parameter descriptions. No client documents a limit on them; the longest is 450 bytes.
- Not changed: what a website audit sends. Only the wording that describes it moves.
- Not handled: a user who sets `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` below the defaults. The server cannot see that setting.
- Not built: `_meta["anthropic/alwaysLoad"]`, `outputSchema`, or any other wire field (R12).
- Not changed: the `get_website_audit` and `score_cli` descriptions beyond what the guard requires; both fit every record today.

### Success Criteria

- The served instructions and every served tool description measure at or under 2,048 UTF-8 bytes at the staging origin (under D1 (a)), checked by the guard and by one local `bun run dev` measurement recorded in the PR.
- After the release that carries the change reaches `anc.dev`, a re-run of the tool-registry check reports no `claude-code-metadata-length` warning. The owner's session runs the check.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One module records every client limit: `src/worker/mcp/client-limits.ts`.** It exports the types `MetadataSurface` (`server-instructions`, `tool-description-upfront`, `tool-description-tool-search`), `LimitUnit` (`characters`, `utf8-bytes`), `LimitEffect`, and `ClientLimit`, plus the records `CLIENT_LIMITS`, the selector `limitsFor(surface, effect)`, and the measure `measure(text, unit)`. A record carries `id`, `client`, `appliesTo`, `value`, `unit`, `effect`, `fromVersion` (inclusive), `untilVersion` (exclusive, or null), and `sources`. Each source is `{ url, described, quote, readOn }`: `url` is null only when the source is described rather than named, `quote` is the exact sentence, and `readOn` is an ISO date. The records, all read on 2026-11-11:

  | `id` | Client | Applies to | Value | Effect | From | Until | Source and quote |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | `claude-code-all-2048` | Claude Code | instructions, upfront, tool search | 2,048 characters | cut | 2.1.84 | 2.1.295 | Changelog 2.1.84: "MCP tool descriptions and server instructions are now capped at 2KB to prevent OpenAPI-generated servers from bloating context". MCP docs: "Before v2.1.296, the shorter limit was 2,048 characters, and before v2.1.295 it applied to every tool description, including one loaded through tool search." |
  | `claude-code-upfront-2048` | Claude Code | instructions, upfront | 2,048 characters | cut | 2.1.295 | 2.1.296 | the same docs sentence |
  | `claude-code-tool-search-16384` | Claude Code | tool search | 16,384 characters | cut | 2.1.295 | | Changelog 2.1.295: "Changed MCP tool descriptions the model loads through tool search to be cut at 16,384 characters instead of 2,048". MCP docs: "The description of a tool that Claude loads through tool search: 16,384 characters" |
  | `claude-code-upfront-4096` | Claude Code | instructions, upfront | 4,096 characters | cut | 2.1.296 | | Changelog 2.1.296: "Changed the default limit on MCP tool descriptions sent up front and on MCP server instructions from 2,048 to 4,096 characters". MCP docs: "Server instructions, and the description of a tool that loads upfront: 4,096 characters" |
  | `tool-registry-check-2048` | a tool-registry check (`claude-code-metadata-length`) | instructions, upfront, tool search | 2,048 UTF-8 bytes | cut | | | described, not named: the check's fix line, "Keep each tool description and the server instructions field at or below 2 KB, and put critical guidance first", as the coordinating session reported it |
  | `chatgpt-codex-lead-512` | ChatGPT and Codex | instructions | 512 characters | lead | | | OpenAI's MCP server guide: "Keep the most important details in the first 512 characters." |

  `effect: 'cut'` means the client drops text past the value. `effect: 'lead'` means the source asks for the most important details within the value; nothing is dropped. The changelog quotes "2KB" where the docs say "2,048 characters"; the record follows the docs. Characters are measured as UTF-16 code units (`String.length`), which equals the client's count if it counts code units and is never lower if it counts code points. UTF-8 bytes are at least the UTF-16 code-unit count for every string, so a string within 2,048 bytes is within 2,048 characters.

  A record is refreshed, never rewritten, when its source changes. A reader fetches each `url`, finds the quoted sentence, and updates `quote` and `readOn` when the wording changed with the value unchanged. When a client changes a limit, the old record gets `untilVersion` and a new record is appended. The 2,048-to-4,096 change is the worked example. A TSDoc comment on `CLIENT_LIMITS` states that rule.

- KTD2. **The budget is every enforced `cut` record for the string's surfaces.** The instructions are checked against every `cut` record whose `appliesTo` holds `server-instructions`. A tool description is checked against every `cut` record that holds either tool-description surface, because Claude Code loads a tool upfront or through tool search depending on the user's settings. Under D1 (a) every record is enforced, so no target constant exists and 2,048 bytes binds. The `lead` record applies only through KTD5's lead window.

- KTD3. **The instructions are six short paragraphs, lead first.** The draft below is directional wording, measured at 1,747 bytes at `https://anc.dev`, 1,829 at the staging origin, and 1,761 at `http://localhost:65535`. The lead (purpose and guide pointer) ends at character 385 at the staging origin. `<origin>` is the request origin, minted per session as today.

  1. Purpose and pointer: "anc.dev scores CLI tools and websites against the agent-native standard: eight principles for software that AI agents operate. Search these tools when asked how well a CLI or a website works for agents, for its agent-readiness score or fixes, or what the principles and spec require. No authentication. Full guide: `<origin>/mcp-skill.md`."
  2. Routing, cheap first: "Read the cache first; it is free. get_scorecard (a CLI) and get_website_audit (a website) return { found: false, next_tool } on a miss. Only then run a metered audit: score_cli (5 fresh audits per 60 minutes per IP) or audit_website (30 fresh audits per 60 minutes per IP). Browse with list_tools, search_tools, get_tool, and list_website_audits; read the standard with list_principles, get_principle, list_spec_sections, and get_spec_section; get_web_remediation returns the fix for a failed website check."
  3. Surface: "13 tools and 5 resources (anc://registry plus 4 templates); full schemas are on tools/list and resources/templates/list."
  4. Envelope: "Scorecard tools return one envelope { kind, tier, target, scorecard_url, markdown_url, json_url, freshness, spec_version, scorecard }, the JSON the scorecard page serves. Check isError first: a cache miss is isError: false with next_tool, not a failure."
  5. `FOLLOW_DISCLOSURE_SHORT` (KTD4).
  6. "Every call shares 60 requests per 60 seconds per IP; a breach returns JSON-RPC -32099. Spec revision 2026-07-28. Connect now at `<origin>/mcp`."

  The numbers stay interpolated from the constants `src/worker/mcp/instructions.ts` already holds. The audit-limit constant for `audit_website` stays the one the paragraph uses today.

- KTD4. **`src/worker/audit-web/follow-disclosure.ts` exports both disclosure forms.** `FOLLOW_DISCLOSURE` keeps its text. `FOLLOW_DISCLOSURE_SHORT` is new, built from the same cap constants: "By default audit_website also contacts third-party hosts the site declares (its MCP server, its API host), at most `MAX_FOLLOWED_HOSTS` per audit and about `DECLARED_DOMAIN_HOURLY_CEILING` audits per hour per declared domain; follow_declarations: false audits only the site and returns a result that is never saved. audit_website's description lists what each host receives." That is 325 characters at today's values. The module comment states that both forms disclose the same caps.

  `audit_website`'s description becomes: one purpose sentence, then `FOLLOW_DISCLOSURE`, then the tool's own facts. Those facts are the 1-minute reuse window, `cached`, `scored_at`, and `refresh_after` with the "not a promise" caveat, the `WEB_AUDIT_ENABLED` and `MCP_ENABLED` gates, the per-IP burst limit and the 30-per-hour window, and `-32099` without `cf-connecting-ip`. The draft measures 1,956 bytes, all ASCII, with the disclosure starting at character 120. Two facts leave the description: "no progress notifications (stateless per-request)" and "still served as-is when the audit is disabled". `content/mcp-skill.md` § Audit a website and § Freshness already carry both. The rewrite also closes the unbalanced parenthesis after "null on a legacy entry".

- KTD5. **The guard is `tests/mcp-client-limits.test.ts`, reading the served strings.** For each host in `MCP_ALLOWED_HOSTNAMES` (exported from `src/worker/mcp/server.ts`), the origin is `https://<host>`, or `http://<host>:65535` for `localhost` and `127.0.0.1`. At each origin it sends a legacy `initialize`, a modern `server/discover`, and `tools/list`, then measures each string against `limitsFor(...)` in each record's unit. Each failure names the string, the origin, the record `id`, the measured length, and the value. It also checks:
  - the records are well formed: unique `id`s, at least one source each, a `url` or a `described` text on every source, a non-empty `quote`, an ISO `readOn`, and `fromVersion` before `untilVersion` when both are set;
  - the instructions' lead (the purpose sentence and `<origin>/mcp-skill.md`) ends inside every `lead` record's value;
  - `get_scorecard` and `get_website_audit` appear before `score_cli` and `audit_website` in the instructions;
  - the instructions contain `FOLLOW_DISCLOSURE_SHORT`, and `audit_website`'s description contains `FOLLOW_DISCLOSURE` directly after its first sentence;
  - `measure` counts an em-dash as 1 character and 3 bytes, and an astral character as 2 characters and 4 bytes.

  A string that fits every `cut` record and contains a critical item carries that item inside the budget, so no per-item offset check against `cut` records is needed.

- KTD6. **Where each fact in today's instructions goes.**

  | Fact in today's instructions | Fate | Where it lives after the change |
  | --- | --- | --- |
  | What the server is; no authentication | stays | KTD3 paragraph 1 |
  | Spec revision `2026-07-28` | stays | KTD3 paragraph 6 |
  | Accept negotiation, both MIME types, `*/*`, q-values, 406 with no envelope | moves out (D3) | already in `content/mcp-skill.md` § Wire-level reference (Accept table) and § When things fail (406 row) |
  | 13 tools and their names | stays | paragraphs 2 and 3 name all 13 |
  | 5 resources | stays | paragraph 3 |
  | The four resource template URIs | moves out | already in `content/mcp-skill.md` § Resources |
  | Schemas on `tools/list` and `resources/templates/list` | stays | paragraph 3 |
  | Web tools score a site and its MCP server on the eight principles | stays | paragraph 1 |
  | `get_website_audit` miss returns `next_tool: audit_website` | stays | paragraph 2 |
  | `audit_website` single terminal scorecard, no progress notifications | moves out | `audit_website` description; `content/mcp-skill.md` § Audit a website |
  | `list_website_audits` curated board; `get_web_remediation` fix by check id | stays | paragraph 2 |
  | Bare and `www.` host fold rule | moves out | both web tools' `url` parameter descriptions; `content/mcp-skill.md` § Audit a website |
  | Web scorecard shape at `/web-scorecard-schema` | moves out | `content/mcp-skill.md` links it nine times |
  | Result envelope fields | stays | paragraph 4 |
  | Envelope equals `/score/<target>/json` | stays, shortened | paragraph 4 ("the JSON the scorecard page serves"); the exact path is in `content/mcp-skill.md` |
  | Follow `scorecard_url`, `markdown_url`, `json_url` | moves out | `content/mcp-skill.md` § Get a scorecard and § Audit a website |
  | URLs are null for an unsaved CLI run (`summary.error` above 0) or an unfollowed web run | moves out | `score_cli` description; `follow_declarations` parameter description; `content/mcp-skill.md` |
  | Two error layers; check `isError` | stays, shortened | paragraph 4; full table in `content/mcp-skill.md` § When things fail |
  | `-32099` for a rate-limit breach | stays | paragraph 6 |
  | `-32022`, `-32700`, `-32600`, `-32020`, `-32000` with their HTTP statuses; send no `Origin` | moves out | already in `content/mcp-skill.md` § When things fail |
  | 60 per 60 seconds per IP on every call | stays | paragraph 6 |
  | 5 fresh `score_cli` audits per 60 minutes per IP | stays | paragraph 2 |
  | 30 fresh `audit_website` audits per 60 minutes per IP | stays | paragraph 2 |
  | Binding names `MCP_LIMITER`, `MCP_AUDIT_LIMITER`, `WEB_AUDIT_LIMITER_IP` | moves out (D3) | already in `content/mcp-skill.md` § Rate limits and § Audit a website; `score_cli` description |
  | Keyed on `cf-connecting-ip`; anon fallback on the read tier only | moves out | already in `content/mcp-skill.md` § Rate limits; both audit tool descriptions |
  | The five kill switches and what each one does | moves out (D3) | added by U4 to `content/mcp-skill.md` § When things fail; `score_cli` and `audit_website` descriptions keep their own switches |
  | Full third-party disclosure | moves out (D2) | `audit_website` description; `content/mcp-skill.md` § Audit a website (Declared hosts) |
  | Default contacts declared hosts; `follow_declarations: false` audits only the site, never saved | stays (D2) | paragraph 5 (`FOLLOW_DISCLOSURE_SHORT`) |
  | Server card advertises the same revision, bumped in lockstep | moves out | already in `content/mcp-skill.md` § Transport |
  | `Connect now at <origin>/mcp` | stays | paragraph 6 |
  | `GET /mcp` returns 405; endpoint description at `/mcp-docs` | moves out | already in `content/mcp-skill.md` § Endpoint |
  | Full guide at `<origin>/mcp-skill.md` | stays, moved to the lead | paragraph 1 |

  `content/mcp-docs.md` needs no change: it already points at `/mcp-skill`.

- KTD7. **The drift gate keeps every pin; each one is asserted on the surface that carries the fact.**

  | Pin today (`tests/worker-mcp.test.ts` drift block) | Change |
  | --- | --- |
  | `13 tools`, `5 resources`, `60 requests per 60 seconds`, `5 fresh audits per 60 minutes`, `2026-07-28`, `https://anc.dev/mcp-skill.md`, `Connect now at https://anc.dev/mcp`, `tools/list`, `resources/templates/list` | unchanged |
  | `application/json`, `text/event-stream` in the instructions | asserted on `content/mcp-skill.md` instead |
  | `toContain(FOLLOW_DISCLOSURE)` and the cap sentences in the instructions | the instructions assert `FOLLOW_DISCLOSURE_SHORT`; `tests/web-audit-mcp-tools.test.ts` adds `toContain(FOLLOW_DISCLOSURE)` beside its existing cap assertions |
  | `only the following of declared hosts (WEB_AUDIT_FOLLOW_ENABLED)` in the instructions | dropped; `WEB_AUDIT_FOLLOW_ENABLED` is already asserted on the `audit_website` description |
  | The plaintext sentence in the instructions | asserted on the `audit_website` description; the `content/mcp-skill.md` assertion stays |
  | `MCP_LIMITER`, `MCP_AUDIT_LIMITER`, `MCP_ENABLED`, `MCP_LIVE_SCORING_ENABLED` in the instructions | asserted on `content/mcp-skill.md` |

  `tests/e2e/mcp.e2e.ts`, `tests/worker-mcp-dispatch.test.ts`, and `tests/site-origin.test.ts` pin only facts that stay, so they do not change. AGENTS.md § MCP server keeps its description of `initialize.instructions` (client-skill pointer plus a session-time summary) and its spec-revision drift-gate paragraph. It gains one sentence: `server/discover` carries the same instructions, and the instructions and every tool description stay within the limits recorded in `src/worker/mcp/client-limits.ts`, which `tests/mcp-client-limits.test.ts` enforces.

### Assumptions

- The tool-registry check measures the same strings the server sends at `https://anc.dev`, in UTF-8 bytes, as its fix line says.
- Claude Code counts characters as JavaScript string length. Either way, the measure in KTD1 never undercounts.
- No MCP client documents a cut on parameter descriptions. None was found in the Claude Code, OpenAI, Gemini CLI, Cursor, or VS Code documentation read for this plan.
- The hints PR changes annotations and the `content/mcp-skill.md` § Tool metadata paragraph only, not description text. Verified on its branch head on 2026-11-11.

### Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| `audit_website` keeps 92 bytes of headroom under D1 (a), so a longer disclosure fails the guard. | The guard fails in CI with the overage and the record `id`; D2 (b) is the decided fallback shape, and taking it is an owner call. |
| An agent that read error codes or binding names from the instructions now has to fetch the guide. | Paragraph 1 points at the guide in its first 400 characters, and `content/mcp-skill.md` § When things fail and § Rate limits carry every code and binding. |
| A client page changes its limit or wording. | KTD1's refresh rule: append a record, set `untilVersion` on the old one. |
| The hints PR and this PR both edit `tests/worker-mcp.test.ts`, `content/mcp-skill.md`, and `src/worker/mcp/tools/web-audit.ts`. | Different hunks (tools/list block and the drift block; Tool metadata and When things fail; annotation lines and the description). Whichever merges second rebases onto `dev` and re-runs the guard. |
| A new served host longer than the staging host. | The guard reads `MCP_ALLOWED_HOSTNAMES`, so a new host is measured the day it is added. |

### Deferred to Implementation

- The final wording of each paragraph and of `audit_website`'s own text, within the measured budget and the facts KTD3, KTD4, and KTD6 keep.
- Whether the drift block's moved assertions live in `tests/worker-mcp.test.ts` or in the new guard file.

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

### U1. Client limit records

- **Goal:** the module KTD1 describes, with its six records and the `measure` and `limitsFor` helpers.
- **Requirements:** R8, R9.
- **Dependencies:** none.
- **Files:** `src/worker/mcp/client-limits.ts` (new); `src/worker/mcp/server.ts` (export `MCP_ALLOWED_HOSTNAMES`); `tests/mcp-client-limits.test.ts` (new, record and `measure` cases).
- **Approach:**
  1. Write the types and records as KTD1 lists them, quotes verbatim from Sources, `readOn` 2026-11-11.
  2. Add the TSDoc refresh rule on `CLIENT_LIMITS`.
  3. Export the existing Host allowlist constant; its value does not change.
- **Patterns to follow:** `WEBMCP_EXECUTE_MAX` in `src/client/webmcp-lib.ts` for a documented external cap; the closed string unions in `src/worker/telemetry/log.ts`.
- **Test scenarios:**
  - Every record has a unique `id`, at least one source, a `url` or `described` on each source, a non-empty `quote`, and an ISO `readOn`.
  - `fromVersion` sorts before `untilVersion` on `claude-code-all-2048` and `claude-code-upfront-2048`.
  - A string of two ASCII letters around one U+2014 measures 3 characters and 5 bytes.
  - An astral character measures 2 characters and 4 bytes.
  - `limitsFor('server-instructions', 'cut')` returns the four 2,048 and 4,096 records and not `claude-code-tool-search-16384`.
- **Verification:** the record tests pass and `bun run typecheck` is clean.

### U5. Length guard against the served strings

- **Goal:** the test KTD5 describes, failing on today's strings before U2 and U3 change them.
- **Requirements:** R1, R2, R3, R4, R10.
- **Dependencies:** U1.
- **Files:** `tests/mcp-client-limits.test.ts`; `tests/helpers/mcp-modern.ts` (a `server/discover` body and headers beside the existing `tools/list` helpers).
- **Approach:**
  1. Build one origin per allowlisted host as KTD5 states.
  2. Read `initialize`, `server/discover`, and `tools/list` through `mcpRpc` with that origin.
  3. Measure each string against `limitsFor` for its surfaces (KTD2), and report every overage in one failure message.
  4. Add the critical-item and order checks from KTD5.
- **Execution note:** run the guard against the unchanged instructions and `audit_website` first, and quote the failure (6,005 bytes for the instructions at the staging origin, 2,458 bytes for `audit_website`) in the PR.
- **Patterns to follow:** `mcpRpc` and `STAGING_TEST_ORIGIN` in `tests/helpers/mcp-rpc.ts`; the origin cases in `tests/site-origin.test.ts`.
- **Test scenarios:**
  - At each origin, the instructions from `initialize` equal those from `server/discover`, and both fit every `cut` record for `server-instructions`.
  - Every `tools/list` description fits every `cut` record for both tool-description surfaces.
  - The guide pointer `<origin>/mcp-skill.md` ends inside 512 characters at the staging origin.
  - `get_scorecard` and `get_website_audit` appear before `score_cli` and `audit_website` in the instructions.
  - `audit_website`'s description holds `FOLLOW_DISCLOSURE` directly after its first sentence, and the instructions hold `FOLLOW_DISCLOSURE_SHORT`.
  - On the unchanged code, the test fails naming the instructions and `audit_website`, each with its record `id` and measured length.
- **Verification:** observed failing before U2 and U3, passing after.

### U2. Disclosure short form and the `audit_website` description

- **Goal:** `FOLLOW_DISCLOSURE_SHORT` and the reordered, tightened `audit_website` description from KTD4.
- **Requirements:** R2, R4, R6, R7.
- **Dependencies:** U1.
- **Files:** `src/worker/audit-web/follow-disclosure.ts`; `src/worker/mcp/tools/web-audit.ts`; `tests/web-audit-mcp-tools.test.ts`.
- **Approach:**
  1. Add the short form from the cap constants and update the module comment.
  2. Rewrite the `audit_website` description in KTD4's order, ASCII only, keeping every substring the existing description tests assert.
  3. Leave the parameter descriptions unchanged (R6).
- **Patterns to follow:** the existing `FOLLOW_DISCLOSURE` construction from `MAX_FOLLOWED_HOSTS`, `MAX_FOLLOW_REQUESTS`, `FOLLOW_SLICE_MS`, and `DECLARED_DOMAIN_HOURLY_CEILING`.
- **Test scenarios:**
  - The `audit_website` description contains `FOLLOW_DISCLOSURE` word for word, and its existing clause assertions still pass.
  - `cached`, `scored_at`, `refresh_after`, and `not a promise` still appear in both web read-tool descriptions.
  - `FOLLOW_DISCLOSURE_SHORT` contains the values of `MAX_FOLLOWED_HOSTS` and `DECLARED_DOMAIN_HOURLY_CEILING` and the text `follow_declarations: false audits only the site`.
- **Verification:** U5's description checks pass for `audit_website`.

### U3. Instructions rewrite and drift gate

- **Goal:** the instructions from KTD3 and the drift-gate changes from KTD7.
- **Requirements:** R1, R3, R5, R7, R11.
- **Dependencies:** U2.
- **Files:** `src/worker/mcp/instructions.ts`; `tests/worker-mcp.test.ts`.
- **Approach:**
  1. Rebuild `buildInstructionsText` as the six paragraphs, using `FOLLOW_DISCLOSURE_SHORT`.
  2. Rewrite the module header comment in present tense: what the string carries, that the URLs follow the request origin, and that the drift tests pin its literals. Drop the plan and unit tags.
  3. Move each pin as KTD7's table says.
- **Patterns to follow:** the current per-origin `siteUrl` threading in `buildInstructionsText`.
- **Test scenarios:**
  - The pins that stay still pass.
  - The instructions contain `FOLLOW_DISCLOSURE_SHORT` and no longer contain `FOLLOW_DISCLOSURE`.
  - At the staging origin the instructions name the staging guide and endpoint URLs (the `tests/site-origin.test.ts` case still passes).
- **Verification:** U5 passes for the instructions at every origin.

### U4. Published surfaces and AGENTS.md

- **Goal:** every fact KTD6 moves is published, and the moved pins assert on the published page.
- **Requirements:** R5, R11.
- **Dependencies:** U3.
- **Files:** `content/mcp-skill.md`; `AGENTS.md`; `tests/worker-mcp.test.ts`.
- **Approach:**
  1. Add one paragraph under `content/mcp-skill.md` § When things fail naming the five kill switches and the answer each produces, worded from AGENTS.md § MCP server: `MCP_ENABLED` (503 with `Retry-After`), `MCP_LIVE_SCORING_ENABLED` (`audited: false` with `next_tool: get_scorecard`), `WEB_AUDIT_ENABLED` (`audited: false`, cached reads still served), `WEB_AUDIT_FOLLOW_ENABLED` (the audit stays on the site's origin and records `follow_declarations: false`), and `MCP_LEGACY_ENABLED` (`-32022` for legacy requests).
  2. Add AGENTS.md's one sentence from KTD7.
  3. Add the `content/mcp-skill.md` assertions for the MIME types, the two limiter bindings, and the two kill switches.
- **Test scenarios:**
  - `content/mcp-skill.md`, whitespace-flattened, contains `application/json`, `text/event-stream`, `MCP_LIMITER`, `MCP_AUDIT_LIMITER`, `MCP_ENABLED`, and `MCP_LIVE_SCORING_ENABLED`.
  - The existing assertions on `content/mcp-skill.md`'s follow caps and plaintext sentence still pass.
- **Verification:** `/mcp-skill` renders the new paragraph through the Worker (`Accept: text/html`), and `/mcp-skill.md` carries it.

Order of work: U1, U5, U2, U3, U4. U5 comes second so it is observed failing on the unchanged strings.

---

## Verification Contract

| Gate | Command or check | Proves |
| --- | --- | --- |
| Lint and types | `bun run lint`, `bun run typecheck` | style, types, knip reachability of the new module |
| Build first | `bun run build` | `dist/` matches the branch before tests read it (AGENTS.md gate order) |
| Unit | `bun test` | U1 to U5 scenarios and every moved pin |
| Observed failing | U5 run against the unchanged strings, failure output quoted in the PR | the guard detects the overage it exists for |
| Local Worker | `bun run dev` with `MCP_ENABLED="true"` in `.dev.vars.staging`; one `initialize`, one `server/discover`, one `tools/list`; byte and character counts recorded in the PR | the served strings, not the builders, fit |
| Staging | `tests/e2e/mcp.e2e.ts` after the `dev` deploy | the unchanged staging pins still hold |
| Reviews | `ce-code-review` and `/devex-review`, one round each on Opus, verdicts in PR comments | code and prose; the agent-facing instructions, description, and guide |

`/cso` is not run: the change alters no credential, auth, request, or input handling, and what the disclosure says is owner-decided (D2). The PR body records that reason.

## Definition of Done

- D1 to D3 are answered and folded into this plan.
- R1 to R12 hold, each covered by a U1 to U5 test scenario or the local Worker measurement.
- No limit value appears outside `src/worker/mcp/client-limits.ts`.
- The PR's `## Changelog` carries: "Fixed: the MCP server instructions and the `audit_website` description now fit within 2,048 bytes, so clients that cut long metadata receive the whole text. The instructions lead with what the server is for and point to `/mcp-skill.md`; the full third-party disclosure stays in `audit_website`'s description."
- No dead-end code from abandoned approaches remains in the diff.

---

## Review log

- 2026-11-11: plan written.
- 2026-11-11: `/plan-eng-review` round 1 started at 5a47b76 (Opus, effort high).
- 2026-11-11: `/plan-devex-review` round 1 started at 5a47b76 (Opus, effort high).
- 2026-11-11: `/compound-engineering:ce-doc-review` round 1 started at 5a47b76 (Opus, effort high, non-interactive).
