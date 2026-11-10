---
artifact_contract: ce-unified-plan/v1
execution: code
product_contract_source: ce-plan-bootstrap
title: "Fold www and apex into one site at the start of every web audit - Plan"
type: feat
status: proposed
date: 2026-11-10
topic: www-apex-site-fold
---

# Fold www and apex into one site at the start of every web audit - Plan

## Goal Capsule

- **Objective:** a website whose `www.` host and apex redirect to each other has one scorecard, under the apex name, on every surface an agent or a person reads, and its audit never reports its own www or apex host as a third party. A `www.` host that does not redirect to or from its apex stays a site of its own.
- **Means:** each audit observes the www/apex redirect as its first step and records the fold in the apex's stored scorecard (KTD1, KTD3); every entry point reads that record before its cache read to choose the name (KTD2).
- **Authority:** Product Contract requirements win on behavior, Key Technical Decisions win on mechanism, and units override neither.
- **Execution profile:** code. One PR from a `feat/` branch to `dev`, holding U1 to U7; U8 runs on staging after the `dev` deploy. The agentnative-cli port follows in its own repo (Deferred to Follow-Up Work).
- **Stop conditions:**
  - The fold needs a change to how any check scores beyond which host it probes and which hosts count as the site. Stop and report: that is a scoring-rule change outside this plan.
  - The pair resolution cannot run inside the per-audit deadline on staging without starving later probes. Stop and re-size.
  - A curated site's score moves on staging for a reason U8 cannot attribute to the fold. Stop and report before release.
- **Who finishes:** an agentnative-site session builds the PR, runs `ce-code-review` and `/devex-review` (it changes MCP output and the scorecard JSON), verifies on staging (U8), and hands the PR to Brett for merge approval.

---

## Product Contract

### Summary

Every web audit starts by asking whether the audited host and its www sibling redirect to each other. When they do, the pair is one site named by its apex: the checks probe the host the redirect lands on, both hosts count as the audited site, and the apex's stored scorecard records the fold. Every entry point reads that record before its cache read, so `www.<apex>` resolves to the apex's scorecard, page, board row, og card, and MCP answer. When they do not, the two hosts are separate sites with separate scorecards.

### Problem Frame

A production audit of `cnn.com` lists `www.cnn.com` under "Declared hosts", as "redirect from /mcp" and "redirect from /sse", each "not confirmed by www.cnn.com". The site's own www host is reported as a third party that failed to consent, and the MCP rows never reach the server that answers at `www.cnn.com/mcp`. The cause is that every same-origin decision in the engine compares against the exact origin typed (`declaresHost` in `src/worker/audit-web/follow-trail.ts` is `!sameOrigin(url, base)`), while the root fetch follows the apex-to-www redirect silently.

The same split shows in naming: `prepareWebTarget` (`src/worker/audit-web/core.ts`) and `canonicalTargetOf` (`src/worker/audit-web/cache.ts`) key the target by the host as typed, so `www.x` and `x` are two scorecards, two result pages, and two possible board rows for one site. The only `www.` handling that ships is the og card's wordmark initials (`src/shared/score-og.ts`).

Thirteen of the 53 curated board sites redirect apex to www (firecrawl.dev, twilio.com, intercom.com, anthropic.com, hubspot.com, notion.so, paypal.com, openapis.org, shopify.com, prisma.io, postman.com, microsoft.com, mintlify.com; root redirects read 2026-11-10). Their stored scorecards carry the same false declared host: production's `hubspot.com` scorecard lists `www.hubspot.com` for `/mcp` and `/sse` (reciprocity refused) and `/message` (budget exceeded). The board research that chose apex names for these entries treated the redirect as cosmetic; the engine does not.

Brett decided the fold in the og:video planning session (D24, D25 in `docs/plans/2026-10-26-2253-feat-scorecard-og-video-plan.md`, Key Decisions and Deferred to Follow-Up Work), confirmed the design on 2026-11-10, and answered this plan's decisions D1 to D8 the same day.

### Requirements

**Observing and recording the fold**

- R1. Every web audit starts by resolving its pair. For an audited host `www.<a>`, where `<a>` is a dotted domain name, the pair is `<a>` and `www.<a>`; for any other domain name `<h>`, it is `<h>` and `www.<h>`. IP literals and `localhost` have no pair. The pair folds when the root of either host answers its first request with a redirect to a URL on the other host.
- R2. A folded audit's site is the apex. The scorecard is stored under the apex, the checks probe the host the redirect lands on, and both hosts count as the audited site for every check: discovery, endpoint resolution, redirect hops, API targets, and the declared-hosts trail.
- R3. An unfolded pair is two sites. An audit of either host probes that host alone, is stored under that host, and treats the other host like any other host. An apex that does not answer leaves the apex unreachable, and `www.<a>` is still audited as itself.
- R4. A redirect from either host to a third host does not fold: `www.twitter.com` to `twitter.com` folds, while `twitter.com` to `x.com` and `cnn.com` to `edition.cnn.com` do not. The root fetch follows a third-host redirect as it does today.
- R5. The apex's stored scorecard records the fold. A saved audit that folds, from either host, writes the fold into the apex's scorecard; a saved audit of the apex that does not fold writes it without one. While a fold is recorded, every request for either host reaches the apex, so a fold that appears or disappears takes effect at the next saved audit of the pair.
- R6. The fold applies whatever the follow switch (`WEB_AUDIT_FOLLOW_ENABLED`) or the caller's `follow_declarations` says.

**Naming and routing**

- R7. Before its cache read, every entry point that reads a web target resolves `www.<a>` to `<a>` when the apex's record shows the pair folded, and keeps `www.<a>` otherwise: `POST /api/score`, `/score/<target>` in every representation, and the web MCP tools. The progress page at `/scoring` names the target as typed; the result forwards to the site's page.
- R8. While the pair is folded, `/score/www.<a>` answers 301 to the same representation of `/score/<a>`. Otherwise it serves `www.<a>`'s own scorecard, or its missing page.
- R9. While the pair is folded, no board and no `list_website_audits` answer lists `www.<a>`.

**What the scorecard says**

- R10. The scorecard names the site by its name (`tool.name`, `tool.url`), records the origin its checks ran against in `target_url`, and, when the pair folded, lists both hosts in an optional `site_hosts` field, apex first. `schema_version` stays `0.5`.
- R11. A folded scorecard's page and markdown twin name the site and say, in the existing website line, which host it was audited at.
- R12. Every web MCP tool's description, and the client skill, state that `www.<a>` reads as `<a>` when the two redirect to each other, and as its own site otherwise.

**Parity**

- R13. The conformance corpus has one scenario per pair outcome (R1 to R4), so the CLI port can reproduce the fold byte for byte.

### Acceptance Examples

- AE1. Covers R1, R2, R5, R8, R10. **Given** `cnn.com` answers `/` with a 301 to `https://www.cnn.com/`, **when** anyone audits `cnn.com`, **then** the checks run against `https://www.cnn.com/`, the declared-hosts trail never names `www.cnn.com`, and the stored `cnn.com` scorecard says `tool.name: "cnn.com"`, `target_url: "https://www.cnn.com/"`, `site_hosts: ["cnn.com", "www.cnn.com"]`. A later request for `/score/www.cnn.com` gets a 301 to `/score/cnn.com`.
- AE2. Covers R1, R2, R7. **Given** no record of `stripe.com` yet and `www.stripe.com` answers `/` with a 301 to `https://stripe.com/`, **when** a visitor audits `www.stripe.com` from the homepage form, **then** the audit folds, the scorecard is stored under `stripe.com`, the terminal envelope names `stripe.com` with `scorecard_url` `/score/stripe.com`, and the progress page forwards there.
- AE3. Covers R4. **Given** `www.twitter.com` redirects to `twitter.com`, which redirects to `x.com`, **when** anyone audits `www.twitter.com`, **then** the pair folds through the www-to-apex hop, the scorecard is stored under `twitter.com`, and the root fetch follows `twitter.com` on to `x.com` exactly as an audit of `twitter.com` does today.
- AE4. Covers R3. **Given** `example.org` does not resolve and `www.example.org` answers 200, **when** anyone audits `example.org`, **then** the audit ends unreachable; **when** anyone audits `www.example.org`, **then** it is audited and stored as `www.example.org`, a site of its own.
- AE5. Covers R5, R8. **Given** the stored `a.test` scorecard lists `site_hosts: ["a.test", "www.a.test"]`, **when** a later audit of `a.test` sees no redirect between the two hosts, **then** `a.test` is stored without `site_hosts`, and `/score/www.a.test` serves `www.a.test`'s own scorecard or its missing page once the cached redirect expires.

### Key Decisions

- **The fold happens at the audit, for the whole audit.** (session-settled: user-directed, chosen over a render-time display check on the og card: `www.python.org` becomes `python.org` from the first step, so boards never carry both names.) Governs R1, R2.
- **The apex is the folded site's name everywhere it is shown or keyed.** (session-settled: user-directed, chosen over keeping each typed host as its own scorecard: no board or store carries both names of one site.) Governs R7, R8, R9, R10.
- **The fold gets its own plan, coordinated with the agentnative-cli web-audit port.** (session-settled: user-directed, chosen over folding it into the og:video work.) Governs R13.
- **A redirect, in either direction, is what makes two hosts one site, and a redirect to a third host is not a fold.** (session-settled: user-directed, chosen over also folding hosts that serve matching content without a redirect. Brett: "for cnn.com -> edition.cnn.com we should treat them as separate.") Governs R1, R4.
- **No redirect, no fold: an unfolded `www.` host is its own site, and the system records which pairs folded.** (session-settled: user-directed, chosen over renaming every `www.` host to its apex by a text rule. Brett: "if `www.x.com` does not redirect to `x.com` then they must be two separate sites in our system.") Governs R3, R5, R7.
- **Names are the apex; provenance stays the host actually requested; `site_hosts` records the fold; the website line says where the audit ran.** (session-settled: user-approved, chosen over rewriting row hosts, evidence URLs, `remediation.host`, and `target_url` to the apex, which would point fix prompts at a host that only redirects.) Governs R10, R11.
- **No data migration: an existing `www.` scorecard is a separate site unless a fold is recorded for its pair.** (session-settled: user-directed, chosen over deleting or re-auditing stored `www.` records.) Governs R8, R9.
- **The site ships first; the CLI follows in its pin-bump PR.** (session-settled: user-approved, chosen over lockstep PRs.) Governs R13.

### Scope Boundaries

- Hosts other than the www sibling (`m.`, `www2.`, `docs.` aliases, `edition.cnn.com`) do not fold. The board's own alias choices stay curated in the seed.
- A root that redirects to a third host keeps today's behavior: the root fetch follows it and its content is scored under the audited name (R4). Brett's "treat them as separate" for `cnn.com` and `edition.cnn.com` is read here as "not folded, two names"; whether an audit should stop following a root redirect to a third host is a scoring-rule question outside this plan.
- Considered and not built: deciding sameness by comparing the two roots' content. Pages differ per request (timestamps, nonces, A/B variants), so the rule would flake; a redirect is the operator's own statement.
- Considered and not built: a fold store of its own (a KV key or an R2 object per pair). The apex's stored scorecard already holds the observation (KTD1), and a second store could disagree with it. A need to know a fold for a site whose apex has no stored scorecard would change this call.
- Considered and not built: resolving the fold before admission, so rate-limit and in-flight keys for `www.<a>` and `<a>` match (KTD9). It would put an unmetered R2 read ahead of the limiter, and the per-IP and hourly limits already bound a client that alternates names.
- Considered and not built: a guard rejecting `www.` domains in `src/data/web-audit/seed.yaml`. No seed row starts with `www.`, rows land by reviewed PR, and the seed's own header requires each row to name the host an agent reaches. A `www.` seed row that folds would show as a missing curated row after the next rescore.
- Considered and not built: a field on MCP answers echoing the input host that was folded. The envelope's `target` and `scorecard_url` already name the site, and the tool descriptions state the rule (R12). Agents re-asking for the www host in a loop would change this call.
- Considered and not built: removing the `www.` strip in `wordmarkInitials` (`src/shared/score-og.ts`). It is harmless; deleting it is cleanup outside the brief.

#### Deferred to Follow-Up Work

- **The agentnative-cli web-audit port** (`brettdavies/agentnative-cli`, its own plan and PR). It bumps `src/web_audit/vendored/SITE_SHA` to the commit that lands this plan, then mirrors the engine half: the pair resolution in `src/web_audit/engine/waves.rs` before the root fetch, naming the site by the apex when the pair folds (`anc www.cnn.com` reports `cnn.com`; `anc www.x.test` with no redirect reports `www.x.test`); the on-site set in place of `same_origin` at its call sites (`follow_trail.rs`, `discovery_posts.rs`, `discovery.rs`, `discovery_documents.rs`, `api_targets.rs`, `handlers/api_probe_url.rs`, `handlers/shared.rs`); the redirect-hop rule in its fetch layer; and `site_hosts` in the strict scorecard mirror (`src/web_audit/scorecard.rs`) and its committed JSON Schema. The CLI keeps no record across runs, so it needs nothing from U2. The fold scenarios from U6 must pass with no divergence-ledger entry.

### Success Criteria

- A fresh staging audit of `cnn.com` shows no declared host, and its MCP rows report what `https://www.cnn.com/mcp` answers.
- After that audit, `/score/www.cnn.com`, `get_website_audit("www.cnn.com")`, and `audit_website("https://www.cnn.com/")` all answer with the site `cnn.com`.
- A staging audit of a `www.` host that does not redirect to or from its apex is stored and shown under its `www.` name.
- Every curated score move after the staging rescore is attributed in U8's table to a row the fold changed.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The fold record is the apex's stored scorecard.** A folded audit stores `site_hosts` in the apex's scorecard, and `boardMetadataOf` (`src/worker/audit-web/cache.ts`) mirrors it into the record's R2 custom metadata, so the board listing sees it without reading bodies. An unfolded saved audit of the pair writes the apex's scorecard without it. No new store or binding: R2 reads are strongly consistent after a write, a `www.<a>` request needs the apex's record anyway when the pair folded, and the scorecard and the record of the fold cannot disagree. A transient run (follow opt-out, held run) saves nothing and records nothing, as it does today.
- KTD2. **Each entry point resolves the name before its cache read.** A new resolver in `src/worker/audit-web/core.ts` takes a classified web host. For a host that is not `www.<a>` with a dotted `<a>`, the name is the host and nothing extra is read. For `www.<a>`, it reads the stored record of `<a>`; when that record's `site_hosts` contains `www.<a>`, the name is `<a>` and that record is the cache read. Otherwise the name is `www.<a>` and the usual read of its own record follows, so an unfolded `www.` target costs one extra R2 read. `handleWeb` (`src/worker/audit/api.ts`), `siteTarget` (`src/worker/mcp/tools/web-audit.ts`), and `serveWeb` (`src/worker/audit/result.ts`) call it; `serveWeb` answers a resolved `www.<a>` with the result route's existing 301 helper. The classifier (`src/shared/audit-routes.ts`) stays syntactic and gains only the pair helper (U1).
- KTD3. **Pair resolution reads both roots at the start, concurrently.** The audited host's root fetch already runs first and doubles as the reachability probe; it now records its first hop. The other host's root is requested once with redirects not followed, in parallel, so the audit's wall clock does not grow. The pair folds when either first hop lands on a URL whose host is the other host of the pair. The probe origin is the host that hop lands on; with no fold it is the audited host. A redirect is any status in `REDIRECT_STATUSES` (`src/worker/audit-web/ssrf.ts`): mintlify.com's temporary 307 folds like a 301, because the question is where the content lives, not whether the move is permanent. Every request goes through `guardedFetch`, so the SSRF guard and the https-only rule apply to the sibling as to any probe.
- KTD4. **One on-site predicate replaces exact-origin comparison wherever the audit's own origin is compared.** The audit carries a site: the probe origin plus, when folded, the other host's origin. The comparisons at `discovery-documents.ts` (endpoint resolution), `discovery.ts` (card fetch and catalog entries), `discovery-posts.ts` (`offOriginRedirect`), `follow-trail.ts` (`declaresHost`), `api-targets.ts` (audited-origin and declared grouping), and `handlers/api-description.ts` (`off_origin`) ask "on site?" instead of "same origin as base?". `guardedFetch` gains a site-origins entry in its options, read where it decides a hop is off-origin, so a POST that the apex redirects to www is followed under `crossOriginRedirects: 'refuse'` and `'return'` like any same-origin hop; `validatePublicUrl` still runs on every hop. Comparisons against a declared host's own origin (reciprocity, the follow slice) are untouched.
- KTD5. **The site name is fixed when the audit completes.** The engine reports the fold and the site name. When an audit requested as `www.<a>` folds, `runWebAuditStream` writes under `<a>`: it resolves the listing against `<a>`'s stored record and the caller's explicit choice, meters the listing-flip budget on `<a>`, runs `heldRun` against `<a>`, and purges the domain tags of both hosts. When an audit of `<a>` finds no fold where the stored record had one, the rewrite drops `site_hosts` and purges `www.<a>`'s domain tag, so `/score/www.<a>` stops redirecting. A request for `www.<a>` resolved to `<a>` whose audit finds the fold gone returns `<a>`'s scorecard once; the next request for `www.<a>` audits it as its own site.
- KTD6. **The record, the envelope, and the cache key carry the name; the scorecard records where the checks ran.** `CachedWebAudit.target_url` stays the key URL, because `patchStoredPublicListing` rebuilds the key from it and the board metadata and listing backfill read the domain from it. The scorecard's `tool` comes from the name, its `target_url` from the probe origin, and `site_hosts` appears only on a fold. Row provenance keeps reading the entry host from `target_url`, so rows probed at the sibling read as the audited host with no change; a row whose evidence names the other host of a folded pair also reads as the audited host. Precedent for an optional field without a schema bump: `follow_declarations` (#395) under `0.5`.
- KTD7. **No migration.** A stored `www.<a>` scorecard stays a valid separate site. `listAllWebAudits` (`src/worker/audit-web/cache.ts`), which both the board (`src/worker/audit-web/board.ts`) and `list_website_audits` call, drops a `www.<a>` row when the listing holds an `<a>` row whose `site_hosts` metadata names it. Records written before this change carry no `site_hosts`, so their pairs read as unfolded until the next saved audit of either host. The post-deploy curated pass re-audits every seeded site, which records the folds of the 13 curated apex-to-www sites on the deploy that ships this plan.
- KTD8. **The fold is not following.** `effectiveFollow` and the declared-domain budget gate requests to hosts a site declares. The sibling is either the site or a host the pair rule ignores, so neither gate applies to the sibling's root request, no budget unit is drawn for it, and a run with following off still folds (R6).
- KTD9. **Rate-limit and in-flight keys use the target as requested.** Admission (`src/worker/audit/admit.ts`) runs before any cache read, keyed `<sid>:<sha256(target)>`, and the in-flight lock is taken on the requested target. Resolving first would put an unmetered R2 read ahead of the limiter; the per-IP and hourly limits bound a client alternating `www.<a>` and `<a>`. The declared-domain budget keys on registrable domains and is unaffected.
- KTD10. **Corpus scenarios name every request.** Each new fold scenario lists its sibling-root exchange. The four existing scenarios with `allow_unmatched: false` gain an explicit sibling exchange answering 404, which is what the other 134 already receive from their unmatched policy; their goldens do not change, because `site_hosts` appears only on a fold.

### High-Level Technical Design

Pair resolution, the engine's first step (KTD3). `H` is the audited host and `S` the other host of its pair:

```mermaid
flowchart TB
  A[Audit of host H] --> P{H has a pair?}
  P -->|no: IP literal or localhost| N[Probe H. No fold]
  P -->|yes| R[Request H root, followed, first hop recorded; S root, not followed; in parallel]
  R --> X{H first hop lands on S?}
  X -->|yes| F1[Fold. Probe S. Name = apex]
  X -->|no| Y{S first hop lands on H?}
  Y -->|yes| F2[Fold. Probe H. Name = apex]
  Y -->|no| U[No fold. Probe H. Name = H]
  U --> Z{H answered?}
  Z -->|no| UR[Unreachable, as today]
```

A first hop that lands on a third host fails both redirect tests, so a third-host redirect never folds (R4). The pair's apex is the shorter host; when `H` is `www.<a>` and the pair folds, the name is `<a>`.

Name resolution at an entry point, and the record write at completion (KTD2, KTD5):

```mermaid
flowchart TB
  Q[Request for host T] --> W{T is www.a?}
  W -->|no| K[Name T. Read record T]
  W -->|yes| RA[Read record a]
  RA --> FA{record a site_hosts names T?}
  FA -->|yes| KA[Name a. Record a is the cache read]
  FA -->|no| KT[Name T. Read record T]
  K --> T1[Serve, patch, or audit]
  KA --> T1
  KT --> T1
  T1 --> C{Audit ran and saved?}
  C -->|folded| WA[Write record a with site_hosts. Purge both hosts' tags]
  C -->|not folded| WT[Write record of the audited host without site_hosts. Purge www.a's tag if record a lost its fold]
```

Which field carries which host after a fold of `cnn.com` (KTD6):

| Field | Value | Role |
| --- | --- | --- |
| envelope `target`, `scorecard_url` | `cnn.com`, `/score/cnn.com` | name |
| record `target_url`, cache key, board metadata `domain` | `https://cnn.com/`, `cnn.com` | name |
| board metadata `site_hosts` | `cnn.com www.cnn.com` | the fold, for the listing |
| scorecard `tool.name`, `tool.url` | `cnn.com`, `https://cnn.com/` | name |
| scorecard `target_url` | `https://www.cnn.com/` | where the checks ran |
| scorecard `site_hosts` | `["cnn.com", "www.cnn.com"]` | the fold |
| row hosts, evidence URLs, `remediation.host` | `www.cnn.com` | where each answer came from |
| purge tags, og card and clip | `cnn.com` | name |

### Assumptions

- `isWebHostname` (`src/shared/audit-routes.ts`) admits `localhost`, IPv4 literals, and bracketed IPv6 literals as website targets, so the pair helper checks the host itself: a host has a pair only when it passes the classifier's dotted-domain test (`DOMAIN_RE`) and is not an IPv4 literal. A host such as `www.1.2.3.4` never reaches the helper, because the URL parser rejects it.
- No caller outside `src/worker/audit-web/` compares an audit's origin for same-site meaning; the call-site list in KTD4 is complete. U4 confirms it with a repository search before changing the predicate.
- The CLI's drift workflow checks the vendored files against the pinned `SITE_SHA` only, so landing this plan does not break agentnative-cli CI before it bumps the pin.

### Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Curated scores move for the 13 apex-to-www sites at their next rescore. | U8 records before and after per row on staging and attributes every move before release. |
| A fold that disappears keeps `/score/www.<a>` redirecting for up to the redirect's cache lifetime (`max-age=300` today). | U2 purges `www.<a>`'s domain tag when the fold is dropped; Deferred to Implementation settles whether the 301 carries that tag. |
| A request for `www.<a>`, resolved to `<a>` by a recorded fold that has since disappeared, returns `<a>`'s fresh scorecard once. | Accepted: the same audit drops the fold, and the next request audits `www.<a>` as its own site (KTD5). |
| Following a POST across the pair re-sends its body to the other host. | Same treatment as a same-origin hop today, on a host the site's own redirect named; `validatePublicUrl` runs on the hop. |
| The sibling request adds one request per audit against the per-audit deadline. | It runs in parallel with the existing root fetch, under the same per-check timeout. Stop condition if staging shows starvation. |
| The CLI port lags the site. | The site is the reference; the CLI's pinned corpus keeps it green until it bumps. |

### Deferred to Implementation

- Whether the first-hop observation comes from a `guardedFetch` option that returns the hop chain or from a non-following first request whose redirect the engine then follows. Either satisfies KTD3; pick the one the request memo dedupes cleanly.
- Whether the fold's 301 from `serveWeb` is tagged with `www.<a>`'s domain tag or carries a shorter `max-age`, so a dropped fold stops redirecting promptly.
- The exact names of the pair helper and the resolver.

---

## Implementation Units

### U1. Pair helper in the shared hostname rules

**Goal:** one pure function names a host's www/apex pair, for the engine and the resolver (R1).

**Requirements:** R1. KTD2, KTD3.

**Dependencies:** none.

**Files:**
- `src/shared/audit-routes.ts`
- `tests/audit-routes.test.ts`

**Approach:**
1. Export a pure helper that returns a host's pair (apex, www) or null. `www.<a>` with `<a>` passing `DOMAIN_RE` and not an IPv4 literal pairs as (`<a>`, `www.<a>`); any other host passing that test pairs as (host, `www.` + host); everything else returns null. Case-insensitive; a non-default port is kept on both hosts.
2. `classifyTarget` and every existing classification stay unchanged.

**Patterns to follow:** `isWebHostname` and `webHostOf` in the same file.

**Test scenarios:**
- `www.cnn.com` pairs as (`cnn.com`, `www.cnn.com`); `cnn.com` pairs the same way.
- `docs.stripe.com` pairs as (`docs.stripe.com`, `www.docs.stripe.com`).
- `www.cnn.com:8443` pairs as (`cnn.com:8443`, `www.cnn.com:8443`).
- `localhost`, `1.2.3.4`, and `[::1]` have no pair.
- `www.co` pairs as (`www.co`, `www.www.co`), because `co` alone is not a dotted domain.
- `classifyTarget("www.cnn.com")` still returns web target `www.cnn.com`.

**Verification:** the classifier suite passes with no change to existing expectations.

### U2. Name resolution, record write, and listing guard

**Goal:** every entry point names a site from the recorded fold, and every saved audit keeps that record current (R5, R7, R8, R9).

**Requirements:** R5, R7, R8, R9. KTD1, KTD2, KTD5, KTD7, KTD9.

**Dependencies:** U1, U3, U5.

**Files:**
- `src/worker/audit-web/core.ts`
- `src/worker/audit-web/cache.ts`
- `src/worker/audit/api.ts`
- `src/worker/audit/result.ts`
- `src/worker/mcp/tools/web-audit.ts`
- `tests/audit-api.test.ts`
- `tests/audit-result-route.test.ts`
- `tests/web-audit-mcp-tools.test.ts`
- `tests/web-audit-cache.test.ts`

**Approach:**
1. Add the resolver to `core.ts` (KTD2) and call it from `handleWeb`, `siteTarget`, and `serveWeb`, before each one's cache read.
2. `serveWeb` answers a resolved `www.<a>` with a 301 to the same representation of `/score/<a>`.
3. In `runWebAuditStream`, write under the site name the engine reports, with the listing, flip budget, held-run, purge, aggregate, and render steps keyed on it (KTD5).
4. `boardMetadataOf` adds a `site_hosts` value when the scorecard carries one; `listAllWebAudits` drops a `www.<a>` row when an `<a>` row's `site_hosts` names it (KTD7).
5. Confirm by reading, not new code, that limiter and in-flight keys stay on the requested target (KTD9).

**Patterns to follow:** `readStoredWebAudit` and `readWebTier` in `core.ts`; the `redirect` helper in `result.ts`; `isBoardListable` as the shape of a listing predicate.

**Test scenarios:**
- Covers AE1. With a stored `cnn.com` record whose `site_hosts` names `www.cnn.com`, `/score/www.cnn.com`, `/score/www.cnn.com/md`, and `/score/www.cnn.com/json` answer 301 to the matching `/score/cnn.com` path.
- With a stored `cnn.com` record lacking `site_hosts`, `/score/www.cnn.com` serves the stored `www.cnn.com` record, or the missing page when there is none.
- `get_website_audit({ url: "https://www.cnn.com/" })` with a folded `cnn.com` record answers `found: true`, `target: "cnn.com"`.
- `get_website_audit({ url: "www.x.test" })` with no `x.test` record and no `www.x.test` record answers `found: false` naming `www.x.test`.
- Covers AE2. `POST /api/score` for `www.stripe.com` with no stored records, whose stubbed audit folds, writes under `stripe.com`, ends on an envelope with `target: "stripe.com"`, and queues purges for both hosts' domain tags.
- Covers AE5. A saved audit of `a.test` with no fold, where the stored record had `site_hosts`, writes `a.test` without `site_hosts` and queues a purge of `www.a.test`'s domain tag.
- A listing holding `www.a.test` and an `a.test` row whose `site_hosts` metadata names it returns only `a.test`; with no such `a.test` row it returns both.
- A listing-only patch on a folded record keeps `site_hosts` in its metadata.

**Verification:** the API, result-route, MCP, and cache suites pass, and a local `bun run dev` request for `/score/www.<a>` against a seeded local record returns 301.

### U3. Pair resolution as the engine's first step

**Goal:** the engine decides the fold, the probe origin, and the site name before discovery (R1 to R4, R6).

**Requirements:** R1, R2, R3, R4, R6. KTD3, KTD8.

**Dependencies:** U1.

**Files:**
- `src/worker/audit-web/engine.ts`
- `src/worker/audit-web/site-pair.ts` (new; name per Deferred to Implementation)
- `src/worker/audit-web/ssrf.ts`
- `tests/web-audit-site-pair.test.ts` (new)
- `tests/web-audit-antecedents-engine.test.ts`

**Approach:**
1. Before `readDiscoveryDocuments`, resolve the pair from the audited host's root fetch (first hop recorded) and the other host's root (one request, redirects not followed), in parallel.
2. Apply KTD3 and the first HTD flowchart; return the fold, the probe origin, the site's origin set, and the site name.
3. Set `base`, `host`, and the root response from the probe origin; hand the origin set to the U4 predicate and to `fetchOptions`; carry the site name to the scorecard build (U5).
4. The unreachable test keeps its current wording, naming the audited host's origin.
5. The pair resolution reads no follow switch and draws no domain-budget unit (KTD8).

**Execution note:** write the pair-resolution tests against a stub fetch first; they are the contract U6 records into the corpus.

**Patterns to follow:** the existing root fetch in `auditWith`; stub-fetch tests in `tests/web-audit-antecedents-engine.test.ts`.

**Test scenarios:**
- Covers AE1. Audit of `n.test` whose root answers 301 to `https://www.n.test/`: folded, probe origin `https://www.n.test/`, name `n.test`.
- Covers AE2. Audit of `www.n.test` whose root answers 301 to `https://n.test/`: folded, probe origin `https://n.test/`, name `n.test`.
- Audit of `n.test` whose root answers 200 while `www.n.test`'s root answers 301 to `https://n.test/`: folded, probe origin `https://n.test/`, name `n.test`.
- Audit of `n.test` whose root redirects to `https://www.n.test/en-us/`: folded, probe origin `https://www.n.test/`.
- Covers AE3. Audit of `www.n.test` whose root redirects to `https://n.test/`, which redirects to `https://third.test/`: folded, name `n.test`, and the root response is the one followed to `third.test`.
- Audit of `n.test` whose root redirects to `https://third.test/` while `www.n.test`'s root answers 404: not folded, name `n.test`.
- Covers AE4. Audit of `n.test` that gets a transport failure or a 530 while `www.n.test` answers 200: not folded, unreachable.
- Covers AE4. Audit of `www.n.test` answering 200 while `n.test` fails: not folded, name `www.n.test`, probe origin `https://www.n.test/`.
- Both roots answer 200 with no redirect: not folded, name is the audited host.
- Audit of `n.test` whose root redirects to `http://www.n.test/`: the existing insecure-scheme refusal fires; no fold.
- With `followDeclarations: false`, a folding pair still folds and the declared-domain budget's `reserve` is never called for the sibling.

**Verification:** the new suite passes, and an engine run over each stub yields the expected `target_url` and `tool.name` in its scorecard.

### U4. On-site comparisons and redirect hops

**Goal:** both hosts of a folded pair are the audited site at every comparison (R2).

**Requirements:** R2. KTD4.

**Dependencies:** U3.

**Files:**
- `src/worker/audit-web/discovery-documents.ts`
- `src/worker/audit-web/discovery.ts`
- `src/worker/audit-web/discovery-posts.ts`
- `src/worker/audit-web/follow-trail.ts`
- `src/worker/audit-web/api-targets.ts`
- `src/worker/audit-web/handlers/api-description.ts`
- `src/worker/audit-web/handlers/shared.ts`
- `src/worker/audit-web/ssrf.ts`
- `tests/web-audit-discovery.test.ts`
- `tests/web-audit-follow.test.ts`
- `tests/web-audit-ssrf.test.ts`
- `tests/web-audit-api-anchors.test.ts`

**Approach:**
1. Search the repository for `sameOrigin(` and `.origin ===` / `.origin !==` comparisons against the audit's base, and list each one; KTD4 names the expected set.
2. Replace each with the on-site predicate over the site's origin set; a site with one origin behaves exactly as today.
3. In `guardedFetch`, a hop whose origin is in the site-origin option counts as on-origin for `crossOriginRedirects`.
4. Leave reciprocity, the follow slice, and comparisons against a declared host's origin unchanged.

**Patterns to follow:** `sameOrigin` in `discovery-documents.ts` as the shape of the predicate; the `crossOriginRedirects` handling in `guardedFetch`.

**Test scenarios:**
- Covers AE1. A folded site probed at `www.n.test` whose server card names `https://n.test/mcp`: the endpoint resolves as the site's own endpoint, not a declaration.
- A folded site probed at `www.n.test` whose common-path POST to `/mcp` redirects to `https://n.test/mcp`: no redirect declaration is recorded and the POST is followed.
- An unfolded site whose POST to `/mcp` redirects to `https://www.n.test/mcp`: recorded as a declaration exactly as today.
- `declaresHost` for a URL on the other host of a folded pair returns false; for a third host it returns true.
- An api-catalog anchor on the other host of a folded pair groups as `audited-origin`.
- `guardedFetch` with site origins `{n.test, www.n.test}` follows a 308 from `n.test` to `www.n.test` under `crossOriginRedirects: 'refuse'`, and still refuses a hop to `evil.test`.
- A hop from `n.test` to `www.n.test` that resolves to a blocked address is still refused by `validatePublicUrl`.

**Verification:** the discovery, follow, ssrf, and api-anchor suites pass; the declared-hosts trail of a folded stub audit never names the other host.

### U5. Scorecard fields, page line, and schema doc

**Goal:** the scorecard and both page representations name the site and say where it was audited (R10, R11).

**Requirements:** R10, R11. KTD6.

**Dependencies:** U3.

**Files:**
- `src/worker/audit-web/scorecard.ts`
- `src/worker/audit-web/engine.ts`
- `src/worker/audit-web/provenance.ts`
- `src/worker/audit-web/summary-model.ts`
- `src/worker/audit-web/summary-render.ts`
- `src/worker/audit-web/summary-markdown.ts`
- `content/web-scorecard-schema.md`
- `tests/web-audit-scorecard-format.test.ts`
- `tests/web-audit-provenance-render.test.ts`
- `tests/web-audit-transient-summary.test.ts`

**Approach:**
1. The engine's scorecard build takes the site name for `tool.name` and `tool.url`, the probe origin for `target_url`, and `site_hosts` (apex first) only on a fold.
2. Row provenance treats a host in `site_hosts` as the audited host.
3. The website line in `summary-render.ts` and its twin in `summary-markdown.ts` add the audited-at clause only when `site_hosts` is present and `target_url`'s host differs from `tool.name`.
4. The schema doc's top-level table gains `site_hosts`, and its `tool.url` row states that it matches `target_url` except when the pair folded and the checks ran at the www host.

**Patterns to follow:** the optional `follow_declarations` and `declared_hosts` fields in `WebScorecard`; the existing website clause in `summary-render.ts`.

**Test scenarios:**
- A folded apex-to-www scorecard serializes `tool.name` as the apex, `target_url` as the www origin, and `site_hosts` with the apex first.
- A folded www-to-apex scorecard has `target_url` equal to `tool.url` and still carries `site_hosts`.
- An unfolded `www.n.test` scorecard names `www.n.test` in `tool` and has no `site_hosts` key.
- An unfolded scorecard's JSON is byte-identical to a pre-change scorecard for the same exchanges.
- The HTML page of a folded apex-to-www scorecard shows the apex and the audited-at clause; the markdown twin carries the same clause.
- A row whose evidence came from the other host of a folded pair renders as evaluated at the audited host.

**Verification:** the scorecard, provenance, and transient-summary suites pass; the page is checked in a browser per U8.

### U6. Conformance corpus scenarios

**Goal:** the corpus pins every pair outcome for the CLI port (R13).

**Requirements:** R13. KTD10.

**Dependencies:** U3, U4, U5.

**Files:**
- `scripts/web-audit/conformance-scenarios.ts`
- `tests/fixtures/web-audit-conformance/scenarios/` (new scenario directories, plus sibling exchanges in the four strict scenarios)
- `tests/fixtures/web-audit-conformance/scores.json`
- `tests/fixtures/web-audit-conformance/README.md`
- `tests/web-audit-conformance-corpus.test.ts`

**Approach:**
1. Add scenarios for: an apex-to-www fold with an MCP endpoint on www; a www-to-apex fold audited from the www host; an apex that does not answer, audited from the apex (unreachable) and from www (its own site); a third-host redirect, not folded; both roots 200, not folded; a folded site whose common-path POST redirects across the pair.
2. Give the four `allow_unmatched: false` scenarios an explicit sibling-root exchange answering 404 (KTD10).
3. Regenerate with `scripts/web-audit/gen-fixtures.ts`; existing goldens must not change.
4. The README's scenario section notes that every run with a pair requests the other host's root.

**Patterns to follow:** existing scenarios such as `alias-redirect-pass` and the discovery scenarios.

**Test scenarios:**
- Each new scenario's golden carries the expected `tool.name`, `target_url`, and `site_hosts` for its outcome.
- Every pre-existing golden `scorecard.json` is byte-identical after regeneration.
- The completeness gate still passes.

**Verification:** `tests/web-audit-conformance-corpus.test.ts` passes with the regenerated corpus.

### U7. MCP descriptions and agent-facing docs

**Goal:** an agent learns the fold from the surfaces it reads (R12).

**Requirements:** R12.

**Dependencies:** U2, U5.

**Files:**
- `src/worker/mcp/tools/web-audit.ts`
- `content/mcp-skill.md`
- `content/_audit-web.md`
- `CONCEPTS.md`
- `tests/web-audit-mcp-tools.test.ts`

**Approach:**
1. The `url` input description on `get_website_audit` and `audit_website` states that `www.<a>` reads as `<a>` when the two redirect to each other, and as its own site otherwise.
2. `list_website_audits` states that a folded site is listed under its apex.
3. `content/mcp-skill.md` and `content/_audit-web.md` state the rule once each, with the `target_url` and `tool.url` distinction (KTD6).
4. `CONCEPTS.md` gains an entry for the site fold if no existing entry carries it.

**Test scenarios:**
- The registered tool descriptions for `get_website_audit` and `audit_website` contain the fold sentence.

**Verification:** the MCP tools suite passes; `bun run build` regenerates `llms-full.txt` with the new skill text.

### U8. Staging verification and score attribution

**Goal:** prove the fold on the deployed staging Worker and attribute every curated score move (Success Criteria).

**Requirements:** R1 to R11.

**Dependencies:** U1 to U7 merged to `dev` and deployed to staging.

**Files:**
- none in the repository; the attribution table goes in the PR description.

**Approach:**
1. Before the merge, record the staging scorecards of the 13 apex-to-www curated sites named in the Problem Frame.
2. After the `dev` deploy, let the curated pass rescore them, or trigger the staging rescore per `docs/runbooks/web-audit-operations.md`.
3. For each site, list every row whose status changed and the fold behavior that changed it (a declared host gone, an MCP probe now reaching www).
4. Check `/score/www.cnn.com` (301 after `cnn.com` is audited), the `cnn.com` page in both themes, `get_website_audit("www.cnn.com")` through the staging MCP endpoint, and an audit of a `www.` host with no redirect to or from its apex, using the Cloudflare Access service-token headers.

**Test expectation:** none -- live verification of deployed behavior; the unit suites carry the logic.

**Verification:** the PR description holds the before-and-after table with every move attributed, and the checks in step 4 pass.

---

## Verification Contract

| Gate | Command or check | Proves |
| --- | --- | --- |
| Lint and types | `bun run lint`, `bun run typecheck` | style and types across touched files |
| Build first | `bun run build` | `dist/` matches the branch before tests read it (AGENTS.md gate order) |
| Unit and corpus | `bun test` | U1 to U7 scenarios, the regenerated corpus, and unchanged goldens |
| Local Worker | `bun run dev`, then `/score/www.<a>` against a folded local record and an MCP `get_website_audit` for it | the resolver, the redirect, and the MCP answer through the real Worker |
| Browser | the folded scorecard page in light and dark themes | R11's clause renders legibly (AGENTS.md "Browser-verify before declaring done") |
| Staging | U8 | live fold, redirect, MCP answer, an unfolded `www.` site, attributed score moves |
| Reviews | `ce-code-review`, `/devex-review` | code and agent-facing output |

## Definition of Done

- R1 to R13 hold, each covered by a U1 to U7 test scenario or by U8.
- Every pre-existing conformance golden is byte-identical; the new scenarios pass.
- The PR carries U8's attribution table, with no unexplained curated score move.
- The agentnative-cli follow-up is filed as its own plan or brief, naming the commit this PR lands as the pin.
- No dead-end code from abandoned approaches remains in the diff.

---

## Review log

- 2026-11-10: plan written at 96549a9.
- 2026-11-10: `/plan-eng-review` round 1 started at ccd44e6 and was stopped before it reported, because the owner's answer to D3 replaced the naming design it was reviewing.
- 2026-11-10: plan reworked to the owner's answers to D1 to D8: folding needs an observed redirect, and the apex's stored scorecard records it.
- 2026-11-10: `/plan-eng-review` round 1 started on the reworked plan at 5c62277 (Opus, effort high).
