---
artifact_contract: ce-unified-plan/v1
execution: code
product_contract_source: ce-plan-bootstrap
title: "Fold www and apex into one site at the start of every web audit - Plan"
type: feat
status: active
date: 2026-11-10
topic: www-apex-site-fold
---

# Fold www and apex into one site at the start of every web audit - Plan

## Goal Capsule

- **Objective:** a website whose `www.` host or apex redirects to the other has one scorecard, under the apex name, on every surface an agent or a person reads, and its audit never reports its own www or apex host as a third party. A `www.` host that does not redirect to or from its apex stays a site of its own.
- **Means:** each audit observes the www/apex redirect as its first step and records the fold in the apex's stored scorecard (KTD1, KTD3); every entry point reads that record before its cache read to choose the name (KTD2).
- **Authority:** Product Contract requirements win on behavior, Key Technical Decisions win on mechanism, and units override neither.
- **Execution profile:** code. One PR from a `feat/` branch to `dev`, holding U1 to U7; U8 runs on staging after the `dev` deploy. The agentnative-cli port follows in its own repo (Deferred to Follow-Up Work).
- **Stop conditions:**
  - The fold needs a change to how any check scores beyond which host it probes and which hosts count as the site. Stop and report: that is a scoring-rule change outside this plan.
  - The pair resolution cannot run inside the per-audit deadline on staging without starving later probes. Stop and re-size.
  - A curated site's score moves on staging for a reason U8 cannot attribute to the fold. Stop and report before release.
- **Who finishes:** an agentnative-site session builds the PR, runs `ce-code-review`, `/devex-review` (it changes MCP output and the scorecard JSON), and `/cso` (a new request to a host the caller did not type, redirect `Location` values as trust decisions), and hands it to Brett for merge approval to `dev`. After the staging deploy it runs U8 and puts the attribution table in the `release/*` PR to `main`; a move it cannot attribute stops the release.

---

## Product Contract

### Summary

Every web audit starts by asking whether the audited host or its www sibling redirects to the other. When one does, the pair is one site named by its apex: the checks probe the host the redirect lands on, both hosts count as the audited site, and the apex's stored scorecard records the fold and is the site's one stored record. Every entry point reads that record before its cache read, so `www.<apex>` resolves to the apex's scorecard, page, board row, and MCP answer, and the page it lands on carries the apex's og card. When neither does, the two hosts are separate sites with separate scorecards.

### Problem Frame

A production audit of `cnn.com` lists `www.cnn.com` under "Declared hosts", as "redirect from /mcp" and "redirect from /sse", each "not confirmed by www.cnn.com". The site's own www host is reported as a third party that failed to consent, and the MCP rows never reach the server that answers at `www.cnn.com/mcp`. The cause is that every same-origin decision in the engine compares against the exact origin typed (`declaresHost` in `src/worker/audit-web/follow-trail.ts` is `!sameOrigin(url, base)`), while the root fetch follows the apex-to-www redirect silently.

The same split shows in naming: `prepareWebTarget` (`src/worker/audit-web/core.ts`) and `canonicalTargetOf` (`src/worker/audit-web/cache.ts`) key the target by the host as typed, so `www.x` and `x` are two scorecards, two result pages, and two possible board rows for one site. The only `www.` handling that ships is the og card's wordmark initials (`src/shared/score-og.ts`).

Thirteen of the 53 curated board sites redirect apex to www (firecrawl.dev, twilio.com, intercom.com, anthropic.com, hubspot.com, notion.so, paypal.com, openapis.org, shopify.com, prisma.io, postman.com, microsoft.com, mintlify.com; root redirects read 2026-11-10). Their stored scorecards carry the same false declared host: production's `hubspot.com` scorecard lists `www.hubspot.com` for `/mcp` and `/sse` (reciprocity refused) and `/message` (budget exceeded). The board research that chose apex names for these entries treated the redirect as cosmetic; the engine does not.

Brett decided the fold in the og:video planning session (D24, D25 in `docs/plans/2026-10-26-2253-feat-scorecard-og-video-plan.md`, Key Decisions and Deferred to Follow-Up Work), confirmed the design on 2026-11-10, and answered this plan's decisions D1 to D8 the same day.

### Requirements

**Observing and recording the fold**

- R1. Every web audit starts by resolving its pair. For an audited host `www.<a>`, where `<a>` is a dotted domain name, the pair is `<a>` and `www.<a>`; for any other domain name `<h>`, it is `<h>` and `www.<h>`. IP literals and `localhost` have no pair. The apex is the pair's host without the leading `www.` label, which need not be a registrable domain: `docs.stripe.com` is the apex of its own pair. The pair folds when the root of either host answers its first request with a redirect to a URL on the other host.
- R2. A folded audit's site is the apex. The scorecard is stored under the apex, the checks probe the host the redirect lands on, and both hosts count as the audited site for every check: discovery, endpoint resolution, redirect hops, API targets, and the declared-hosts trail.
- R3. An unfolded pair is two sites. An audit of either host probes that host alone, is stored under that host, and treats the other host like any other host. An apex that does not answer leaves the apex unreachable, and `www.<a>` is still audited as itself; the unreachable error then names `www.<a>` as the host that answered.
- R4. A redirect from either host to a third host does not fold: `www.twitter.com` to `twitter.com` folds, while `twitter.com` to `x.com` does not (both redirects observed 2026-11-10). The root fetch follows a third-host redirect as it does today.
- R5. The apex's stored scorecard records the fold. A saved audit that folds, from either host, writes the fold into the apex's scorecard; a saved audit drops it only when both roots answered and neither redirected to the other. When either root gave no answer (a timeout, a transport failure, a 429, or a 5xx), the saved audit keeps the fold the record holds. While a fold is recorded, every request for either host reaches the apex, so a fold that appears or disappears takes effect at the next saved audit of the pair. A folded site has one stored record: a saved audit that folds writes the apex's record and deletes `www.<a>`'s stored record at the current spec version; an audit that does not fold deletes nothing.
- R6. The fold applies whatever the follow switch (`WEB_AUDIT_FOLLOW_ENABLED`) or the caller's `follow_declarations` says.

**Naming and routing**

- R7. Before its cache read, every entry point that reads a web target resolves `www.<a>` to `<a>` when the apex's record shows the pair folded, and keeps `www.<a>` otherwise: `POST /api/score`, `/score/<target>` in every representation, and the web MCP tools. The progress page at `/scoring` names the target as typed; the result forwards to the site's page.
- R8. While the pair is folded, `/score/www.<a>` answers 301 to the same representation of `/score/<a>`. Otherwise it serves `www.<a>`'s own scorecard, or its missing page. After a recorded fold disappears, `www.<a>` has no stored record, so it serves the missing page until its next audit stores it as its own site.
- R9. While the pair is folded, no board and no `list_website_audits` answer lists `www.<a>`. A folded write lists the site by the caller's explicit `public_listing` choice, else the apex's stored listing, else `www.<a>`'s stored listing, else unlisted.

**What the scorecard says**

- R10. The scorecard names the site by its name (`tool.name`, `tool.url`), records the origin its checks ran against in `target_url`, and, when the pair folded, lists both hosts in an optional `site_hosts` field, apex first. `schema_version` stays `0.5`.
- R11. A folded scorecard's page and markdown twin name the site and say, in the existing website line, which host it was audited at.
- R12. Every web MCP tool that takes or lists a site, the MCP session instructions, and the client skill state that `www.<a>` reads as `<a>` when one of the two redirects to the other, and as its own site otherwise.

**Parity**

- R13. The conformance corpus has one scenario per pair outcome (R1 to R4), so the CLI port can reproduce the fold byte for byte.

### Acceptance Examples

- AE1. Covers R1, R2, R5, R8, R10. **Given** `cnn.com` answers `/` with a 301 to `https://www.cnn.com/`, **when** anyone audits `cnn.com`, **then** the checks run against `https://www.cnn.com/`, the declared-hosts trail never names `www.cnn.com`, and the stored `cnn.com` scorecard says `tool.name: "cnn.com"`, `target_url: "https://www.cnn.com/"`, `site_hosts: ["cnn.com", "www.cnn.com"]`, and no stored `www.cnn.com` record remains. A later request for `/score/www.cnn.com` gets a 301 to `/score/cnn.com`.
- AE2. Covers R1, R2, R7. **Given** no record of `stripe.com` yet and `www.stripe.com` answers `/` with a 301 to `https://stripe.com/`, **when** a visitor audits `www.stripe.com` from the homepage form, **then** the audit folds, the scorecard is stored under `stripe.com`, the terminal envelope names `stripe.com` with `scorecard_url` `/score/stripe.com`, and the progress page forwards there.
- AE3. Covers R4. **Given** `www.twitter.com` redirects to `twitter.com`, which redirects to `x.com`, **when** anyone audits `www.twitter.com`, **then** the pair folds through the www-to-apex hop, the scorecard is stored under `twitter.com`, and the root fetch follows `twitter.com` on to `x.com` exactly as an audit of `twitter.com` does today.
- AE4. Covers R3. **Given** `a.test` does not answer and `www.a.test` answers 200 with no redirect, **when** anyone audits `a.test`, **then** the audit ends unreachable, and its error names `https://www.a.test/` as the host that answered; **when** anyone audits `www.a.test`, **then** it is audited and stored as `www.a.test`, a site of its own.
- AE5. Covers R5, R8. **Given** the stored `a.test` scorecard lists `site_hosts: ["a.test", "www.a.test"]`, **when** a later audit of `a.test` gets an answer from both roots with no redirect between them, **then** `a.test` is stored without `site_hosts`, and once the cached redirect expires `/score/www.a.test` serves the missing page, because the fold left `www.a.test` no stored record, until `www.a.test` is audited as its own site.
- AE6. Covers R5. **Given** the stored `a.test` scorecard lists `site_hosts: ["a.test", "www.a.test"]`, **when** a later audit of `a.test` gets a 503 from `www.a.test`'s root, **then** `a.test` is stored with `site_hosts` kept and `/score/www.a.test` still answers 301.

### Key Decisions

- **The fold happens at the audit, for the whole audit.** (session-settled: user-directed, chosen over a render-time display check on the og card: `www.python.org` becomes `python.org` from the first step, so boards never carry both names.) Governs R1, R2.
- **The apex is the folded site's name everywhere it is shown or keyed.** (session-settled: user-directed, chosen over keeping each typed host as its own scorecard: no board or store carries both names of one site.) Governs R7, R8, R9, R10.
- **The fold gets its own plan, coordinated with the agentnative-cli web-audit port.** (session-settled: user-directed, chosen over folding it into the og:video work.) Governs R13.
- **A redirect, in either direction, is what makes two hosts one site, and a redirect to a third host is not a fold.** (session-settled: user-directed, chosen over also folding hosts that serve matching content without a redirect. Brett: "Foldings are limited to redirects.") Governs R1, R4.
- **No redirect, no fold: an unfolded `www.` host is its own site, and the system records which pairs folded.** (session-settled: user-directed, chosen over renaming every `www.` host to its apex by a text rule. Brett: "if `www.x.com` does not redirect to `x.com` then they must be two separate sites in our system.") Governs R3, R5, R7.
- **Names are the apex; provenance stays the host actually requested; `site_hosts` records the fold; the website line says where the audit ran.** (session-settled: user-approved, chosen over rewriting row hosts, evidence URLs, `remediation.host`, and `target_url` to the apex, which would point fix prompts at a host that only redirects.) Governs R10, R11.
- **No data migration: an existing `www.` scorecard is a separate site until a saved audit of its pair folds and deletes it.** (session-settled: user-directed, chosen over a one-time pass that deletes or re-audits stored `www.` records.) Governs R8, R9.
- **The site ships first; the CLI follows in its pin-bump PR.** (session-settled: user-approved, chosen over lockstep PRs.) Governs R13.
- **A recorded fold survives a sibling that gives no answer.** (session-settled: user-directed, chosen over dropping the fold on any run that does not observe it.) No answer means a timeout, a transport failure, a 429, or a 5xx from either root; only observed answers with no redirect between the two hosts drop the fold. Governs R5.
- **A `www.<a>` opt-in carries to `<a>` when `<a>` stores no listing of its own.** (session-settled: user-approved, chosen over asking the submitter to opt in again under `<a>`.) The `audit_website` description promises that a blank never erases a prior opt-in; when `<a>` has its own record, that record decides (next decision). Governs R9.
- **One stored record per site.** (session-settled: user-directed, chosen over keeping a folded `www.<a>` record stored beside the apex's.) A saved audit that folds writes the apex's record, deletes `www.<a>`'s record at the current spec version, and purges `www.<a>`'s domain tag; an audit that does not fold deletes nothing. The write lists the site by the caller's explicit choice, else the apex's stored listing, else `www.<a>`'s stored listing, read once before the delete, else unlisted. A leftover `www.` record goes at its site's next saved folded audit; records under older spec versions are read by no surface and stay untouched. When a recorded fold disappears, `www.<a>` becomes its own site at its next audit. Evidence (production R2, read 2026-11-10): of 74 stored web audits at spec 0.7.0, two are `www.` hosts (`www.sivalabs.in`, `www.wimdeblauwe.com`), both unlisted, with no apex record and an apex that answers 301 to `www`, so both fold; 11 more `www.` records sit under 0.5.0 and 0.6.0, and no pair has two records. Governs R5, R8, R9.
- **`schema_version` stays `0.5`.** (session-settled: user-approved, chosen over a minor bump.) `site_hosts` is optional, as `follow_declarations` was under `0.5` (#395), and it marks every scorecard whose `tool.url` and `target_url` differ. Governs R10.
- **The unreachable error names a sibling that answered.** (session-settled: user-directed, chosen over keeping the current wording.) An agent that typed a dead apex gets the URL that works. Governs R3.
- **The pair rule reads the first hop only.** (session-settled: user-directed, chosen over the first hop that leaves the audited host, which would also fold a chain such as `a/` to `a/en` to `www.a/en`.) Governs R1.

### Scope Boundaries

- Only the www sibling folds. A third host that a root redirects to stays a separate site (`twitter.com` to `x.com`, `square.com` to `squareup.com`, both observed 2026-11-10), and the board's own alias choices stay curated in the seed.
- Considered and not built: deciding sameness by comparing the two roots' content. Pages differ per request (timestamps, nonces, A/B variants), so the rule would flake; a redirect is the operator's own statement.
- Considered and not built: a fold store of its own (a KV key or an R2 object per pair). The apex's stored scorecard already holds the observation (KTD1), and a second store could disagree with it. A need to know a fold for a site whose apex has no stored scorecard would change this call.
- Considered and not built: a guard rejecting `www.` domains in `src/data/web-audit/seed.yaml`. No seed row starts with `www.`, rows land by reviewed PR, and the seed's own header requires each row to name the host an agent reaches. A `www.` seed row that folds would show as a missing curated row after the next rescore.
- Considered and not built: a field on MCP answers echoing the input host that was folded. The envelope's `target` and `scorecard_url` already name the site, and the tool descriptions state the rule (R12). Agents re-asking for the www host in a loop would change this call.
- Considered and not built: metering the listing-flip budget again on `<a>` when a fold is first observed mid-run. Both callers meter before the run on the resolved name, and once the fold is recorded every later request meters on `<a>`.
- Considered and not built: a structured next-step field on the unreachable error. `AuditError` (`src/shared/audit-events.ts`) carries `code`, `message`, `cta`, and optional `details`, `retry_after`, and `pm`, with no structured next step, so the sibling's URL rides in `message` and `cta`.
- Considered and not built: resolving the fold in the og card route. `/og/score/www.<a>/…` still reads `www.<a>`'s record (`src/worker/og/subject.ts`); no page links to it once `/score/www.<a>` answers 301.
- Considered and not built: removing the `www.` strip in `wordmarkInitials` (`src/shared/score-og.ts`). It is harmless; deleting it is cleanup outside the brief.

#### Deferred to Follow-Up Work

- **The agentnative-cli web-audit port** (`brettdavies/agentnative-cli`, its own plan and PR). It bumps `src/web_audit/vendored/SITE_SHA` to the commit that lands this plan, then mirrors the engine half: the pair resolution in `src/web_audit/engine/waves.rs` before the root fetch, naming the site by the apex when the pair folds (`anc www.cnn.com` reports `cnn.com`; `anc www.x.test` with no redirect reports `www.x.test`), with the text header (`render/text.rs`) naming `tool.url` and adding `(audited at <target_url host>)` when `site_hosts` is present and the hosts differ, as R11 does on the page; the on-site set in place of `same_origin` at its call sites (`follow_trail.rs`, `discovery_posts.rs`, `discovery.rs`, `discovery_documents.rs`, `api_targets.rs`, `handlers/api_description.rs`, `handlers/api_probe_url.rs`, `handlers/content_without_js.rs`, `handlers/scoped_llms.rs`, `handlers/shared.rs`, and the hand-written redirect loop `same_origin_get` in `handlers/api_hygiene.rs`; `rg -n same_origin src/web_audit` lists them); the DNS-AID host in `handlers/dns_doh.rs`, which stays the site name; the unreachable reason that names a sibling that answered; the redirect-hop rule in its fetch layer (`fetch/redirect.rs`), where `hop_headers` keeps the credential exact-origin, so a token presented to one host of the pair is never forwarded to the other; and `site_hosts` in the strict scorecard mirror (`src/web_audit/scorecard.rs`) and its committed JSON Schema. The CLI keeps no record across runs, so it needs nothing from U2. The fold scenarios from U6 must pass with no divergence-ledger entry.

### Success Criteria

- A fresh staging audit of `cnn.com` names no `www.cnn.com` declared host, and its MCP rows report what `https://www.cnn.com/mcp` answers.
- After that audit, `/score/www.cnn.com`, `get_website_audit("www.cnn.com")`, and `audit_website("https://www.cnn.com/")` all answer with the site `cnn.com`.
- A staging audit of a `www.` host that does not redirect to or from its apex is stored and shown under its `www.` name.
- Every curated score move after the staging rescore is attributed in U8's table to a row the fold changed.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The fold record is the apex's stored scorecard.** A folded audit stores `site_hosts` in the apex's scorecard, the site's only stored record once the fold's write deletes `www.<a>`'s (KTD5), and `boardMetadataOf` (`src/worker/audit-web/cache.ts`) mirrors it into the record's R2 custom metadata, so the board listing sees it without reading bodies. A saved audit drops it only when both roots answered with no redirect between them; when either gave no answer, the stored `site_hosts` is kept (R5, KTD5). No new store or binding: R2 reads are strongly consistent after a write, a `www.<a>` request needs the apex's record anyway when the pair folded, and the scorecard and the record of the fold cannot disagree. A transient run (follow opt-out, held run) saves nothing, records nothing, and deletes nothing, as it does today.
- KTD2. **Each entry point resolves the name before its cache read.** A new resolver in `src/worker/audit-web/core.ts` takes a classified web host. For a host that is not `www.<a>` with a dotted `<a>`, the name is the host and nothing extra is read. For `www.<a>`, it reads the stored record of `<a>`; when that record's `site_hosts` contains `www.<a>`, the name is `<a>` and that record is the cache read. Otherwise the name is `www.<a>` and the usual read of its own record follows, so an unfolded `www.` target costs one extra R2 read. `handleWeb` (`src/worker/audit/api.ts`), `siteTarget` (`src/worker/mcp/tools/web-audit.ts`), and `serveWeb` (`src/worker/audit/result.ts`) call it. The resolved name keys the cache read, admission, the in-flight lock, the job, and the write; the engine always starts at the host as requested (KTD5); `serveWeb` answers a resolved `www.<a>` with the result route's existing 301 helper. `serveWeb` and `get_website_audit` read `<a>`'s record with the strict read (`getForRequest` in `src/worker/audit-web/cache.ts`). When it throws `WebCacheUnavailableError`, `serveWeb` answers its existing 503 `cache_unavailable`, and `get_website_audit` answers `isError: true` with `cache_unavailable: the stored scorecard for <a> could not be read right now; it has not been removed. Retry get_website_audit in 30 seconds.` Neither reads `www.<a>`'s record, so a read failure is never reported as a miss that sends the agent to a metered audit. `handleWeb` and `audit_website` keep the tolerant read (`get`): a failed read of `<a>` counts as no fold, and the audit that follows observes the fold itself and saves under `<a>` (KTD5). The classifier (`src/shared/audit-routes.ts`) stays syntactic and gains only the pair helper (U1).
- KTD3. **Pair resolution reads both roots at the start, concurrently.** The audited host's root fetch already runs first and doubles as the reachability probe; it now records its first hop. The other host's root is requested once with redirects not followed, in parallel. When the audited host's first hop lands on the other host, the fold is decided without waiting for the sibling; otherwise the sibling is awaited at most until the root fetch completes plus the engine's degraded per-check timeout (`DEGRADED_PER_CHECK_TIMEOUT_MS`, 2 s), then counts as not answering. The engine reports the pair outcome as folded, unfolded (both roots answered and neither first hop lands on the other host), or no answer (either root gave a timeout, a transport failure, a 429, or a 5xx, and no first hop landed on the other host). The CLI keeps no record, so it treats no answer as unfolded. The pair folds when either first hop lands on a URL whose host is the other host of the pair. The probe origin is the host that hop lands on; with no fold it is the audited host. A redirect is any status in `REDIRECT_STATUSES` (`src/worker/audit-web/ssrf.ts`): mintlify.com's temporary 307 folds like a 301, because the question is where the content lives, not whether the move is permanent. Every request goes through `guardedFetch`, so the SSRF guard and the https-only rule apply to the sibling as to any probe.
- KTD4. **One on-site predicate replaces exact-origin comparison wherever the audit's own origin is compared.** The audit carries a site: the probe origin plus, when folded, the other host's origin. The comparisons at `discovery-documents.ts` (endpoint resolution), `discovery.ts` (card fetch and catalog entries), `discovery-posts.ts` (`offOriginRedirect`), `follow-trail.ts` (`declaresHost`), `api-targets.ts` (audited-origin and declared grouping), `handlers/api-description.ts` (`off_origin`), `handlers/api-probe-url.ts` (probe URL resolution), `handlers/content-without-js.ts` and `handlers/shared.ts` (`sameOriginRecoveryLink`, same-site links), and `handlers/scoped-llms.ts` (which llms.txt links are fetched) ask "on site?" instead of "same origin as base?". `guardedFetch` gains a site-origins entry in its options, read where it decides a hop is off-origin: a hop counts as on-origin when the next origin equals the request's origin, or when both are in the site-origin set. A POST that the apex redirects to www is followed under `crossOriginRedirects: 'refuse'` and `'return'` like any same-origin hop, while a declared host's redirect into the site stays off-origin; `validatePublicUrl` still runs on every hop. Three comparisons stay exact, because they compare against a fixed URL or a declared host's own origin: the alias check against the canonical path (`assert.ts`), reciprocity (`reciprocity.ts`), and the follow slice.
- KTD5. **The engine starts at the host as requested; the site name is fixed when the audit completes.** The resolved name (KTD2) keys the cache read, admission, the in-flight lock, and the job, but the engine starts its pair resolution at the host the caller asked for, so a dead apex never blocks an audit of a live `www.<a>` (R3). `runWebAuditStream` writes by the pair outcome the engine reports:
  - **Folded**, whichever host was requested: write under `<a>` with `site_hosts`, then, once that write lands, delete `www.<a>`'s stored record (its key at the current `SPEC_VERSION`), so the site has one stored record. The listing is the caller's explicit choice; else `<a>`'s stored listing; else `www.<a>`'s stored listing, read once before the delete; else unlisted. A blank never erases the site's prior opt-in (the `public_listing` contract in the `audit_website` description), and when `<a>`'s record stores a listing, that listing decides. `heldRun` runs against `<a>`, and the purge covers both hosts' domain tags. A write that does not land deletes nothing; a delete that does not land logs, leaves the record for the next folded audit, and the board guard keeps it off every listing (KTD7).
  - **Unfolded**: write under the host requested, without `site_hosts`. When `<a>`'s stored record lists `site_hosts`, the fold is dropped: an audit of `<a>` rewrites `<a>` without it, and an audit of `www.<a>` patches `<a>`'s record to remove it. Either way `www.<a>`'s domain tag is purged, so `/score/www.<a>` stops redirecting, and nothing is deleted. A `www.<a>` whose fold was recorded has no stored record, so its own-site write takes the caller's explicit choice, else unlisted, as a first audit does.
  - **No answer**, with a fold recorded in `<a>`'s record: write under `<a>`, keeping its `site_hosts`, with `tool` stamped as `<a>`; purge nothing for `www.<a>` and delete nothing. The run's checks treat the sibling as any other host, because the engine consults no record. With no fold recorded, no answer writes as unfolded.

  The listing-flip budget is metered before the run on the resolved name, as today; a fold first observed mid-run applies the caller's explicit choice to `<a>` without metering again. The rescore Workflow writes outside `runWebAuditStream` (`auditDomainToCache` in `src/worker/audit-web/rescore-workflow.ts`), so it applies the same three rules: a folded rescore deletes `www.<seed>`'s record once its `cachePut` lands, and its listing stays the curated one (`isSeededDomain`), which takes the explicit choice's place, so it reads no `www.` listing. Its cycle purge adds `www.<seed>`'s domain tag for each seed whose stored or new scorecard carries `site_hosts`.
- KTD6. **The record, the envelope, and the cache key carry the name; the scorecard records where the checks ran.** `CachedWebAudit.target_url` stays the key URL, because `patchStoredPublicListing` rebuilds the key from it and the board metadata and listing backfill read the domain from it. The scorecard's `tool` comes from the name, its `target_url` from the probe origin, and `site_hosts` appears only on a fold. Row provenance keeps reading the entry host from `target_url`, so rows probed at the sibling read as the audited host with no change; a row whose evidence names the other host of a folded pair also reads as the audited host. The envelope's `target_url` is copied from the scorecard's `target_url`, falling back to the record's, so one field name carries one meaning in a response; the record's own `target_url` stays the key URL. Precedent for an optional field without a schema bump: `follow_declarations` (#395) under `0.5`.
- KTD7. **No migration.** A stored `www.<a>` scorecard stays a valid separate site until a saved audit of its pair folds, which deletes it (KTD5); records under older spec versions, which no surface reads, stay untouched. A `www.<a>` row beside a folded `<a>` row remains only when that delete did not land, so `listAllWebAudits` (`src/worker/audit-web/cache.ts`), which both the board (`src/worker/audit-web/board.ts`) and `list_website_audits` call, first collects the `site_hosts` metadata of every per-domain object at the spec version, before its excluded-domain and display-age filters run, then drops any `www.<a>` row whose host appears in a collected `site_hosts`; the next folded audit retries the delete. The two filters apply after that, so a curated apex, or one past the display window, still hides a leftover `www.` row. Records written before this change carry no `site_hosts`, so their pairs read as unfolded until the next saved audit of either host. U4 raises `FOLLOW_POLICY_VERSION` (`src/worker/audit-web/registry.ts`), whose doc comment requires a raise with any change to what the follow phase reaches; the new registry fingerprint makes the post-deploy rescore on staging and production reflow every seed whatever its age, which records the folds of the 13 curated apex-to-www sites. Seeds a domain budget defers follow the runbook's manual trigger after the hour. A spec-version bump rotates every key, so recorded folds read as absent until the rescore re-audits.
- KTD8. **The fold is not following.** `effectiveFollow` and the declared-domain budget gate requests to hosts a site declares. The sibling is either the site or a host the pair rule ignores, so neither gate applies to the sibling's root request, no budget unit is drawn for it, and a run with following off still folds (R6).
- KTD9. **Rate-limit, in-flight, and job keys use the resolved name.** The cache read already comes before admission on both paths (`handleWeb` reads the tier before `admit`; `audit_website` reads before its limiter), so the resolver's read joins the unmetered read tier that precedes admission. Once a fold is recorded, `www.<a>` and `<a>` share one session-limiter bucket (`<sid>:<sha256(target)>`, `src/worker/audit/admit.ts`) and one in-flight run. A fold first observed mid-run keys on the name requested. The declared-domain budget keys on registrable domains and is unaffected.
- KTD10. **Corpus scenarios name every request.** Each new fold scenario lists its sibling-root exchange. The four existing scenarios with `allow_unmatched: false` gain an explicit sibling exchange answering 404. Of the other 134, 132 answer an unmatched request with a 404, one with a transport error, and one with a 530; none is a redirect, so no existing scenario folds and their goldens do not change.

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
  Y -->|no| U[No fold this run. Probe H. Name = H. Outcome: unfolded, or no answer when either root timed out, failed, or sent 429 or 5xx]
  F1 --> Z{Probe origin answered?}
  F2 --> Z
  U --> Z
  Z -->|no| UR[Unreachable. Name S in the error when S answered without redirecting to H]
  Z -->|yes| D[Discovery from the probe origin]
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
  K --> T1[Serve, patch, or audit; the audit starts at T]
  KA --> T1
  KT --> T1
  T1 --> C{Audit ran and saved?}
  C -->|folded| WA[Write record a with site_hosts. Listing: explicit, else a's stored, else www.a's stored, else unlisted. Once written, delete record www.a. Purge both hosts' tags]
  C -->|unfolded| WT[Write record of the requested host without site_hosts. Delete nothing. If record a lists site_hosts, remove it and purge www.a's tag]
  C -->|no answer| WN[Fold recorded: write record a, keeping site_hosts, deleting nothing. None recorded: as unfolded]
```

Which field carries which host after a fold of `cnn.com` (KTD6):

| Field | Value | Role |
| --- | --- | --- |
| envelope `target`, `scorecard_url` | `cnn.com`, `/score/cnn.com` | name |
| envelope `target_url` | `https://www.cnn.com/` | where the checks ran (copied from the scorecard's `target_url`) |
| record `target_url`, cache key, board metadata `domain` | `https://cnn.com/`, `cnn.com` | name |
| board metadata `site_hosts` | `cnn.com www.cnn.com` | the fold, for the listing |
| scorecard `tool.name`, `tool.url` | `cnn.com`, `https://cnn.com/` | name |
| scorecard `target_url` | `https://www.cnn.com/` | where the checks ran |
| scorecard `site_hosts` | `["cnn.com", "www.cnn.com"]` | the fold |
| row hosts, evidence URLs, `remediation.host` | `www.cnn.com` | where each answer came from |
| page domain tag, og card and clip | `cnn.com` | name |

### Assumptions

- `isWebHostname` (`src/shared/audit-routes.ts`) admits `localhost`, IPv4 literals, and bracketed IPv6 literals as website targets, so the pair helper checks the host itself: a host has a pair only when it contains a dot, passes the classifier's domain test (`DOMAIN_RE`), and is not an IPv4 literal, as `isWebHostname` checks; `DOMAIN_RE` alone matches `co`. A host such as `www.1.2.3.4` never reaches the helper, because the URL parser rejects it.
- No caller outside `src/worker/audit-web/` compares an audit's origin for same-site meaning; the call-site list in KTD4 is complete. U4 confirms it with a repository search before changing the predicate.
- The CLI's drift workflow checks the vendored files against the pinned `SITE_SHA` only, so landing this plan does not break agentnative-cli CI before it bumps the pin.

### Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Curated scores move for the 13 apex-to-www sites at their next rescore. | U8 records before and after per row on staging and attributes every move before release. |
| A fold that disappears keeps `/score/www.<a>` redirecting in browsers and at the edge for up to the redirect's cache lifetime (`max-age=300` today). | U2 purges `www.<a>`'s domain tag when the fold is dropped; Deferred to Implementation settles whether the 301 carries that tag. |
| Following a POST across the pair re-sends its body to the other host. | Same treatment as a same-origin hop today, on a host the site's own redirect named; `validatePublicUrl` runs on the hop. |
| The sibling request adds one request per audit against the per-audit deadline. | It runs in parallel with the existing root fetch and is awaited at most 2 s past it (KTD3). Stop condition if staging shows starvation. |
| The CLI port lags the site. | The site is the reference; the CLI's pinned corpus keeps it green until it bumps. |

### Deferred to Implementation

- Whether the first-hop observation comes from a `guardedFetch` option that returns the hop chain or from a non-following first request whose redirect the engine then follows. Either satisfies KTD3; pick the one the request memo dedupes cleanly.
- Whether the fold's 301 from `serveWeb` is tagged with `www.<a>`'s domain tag or carries a shorter `max-age`, so a dropped fold stops redirecting promptly.
- The exact names of the pair helper, the resolver, and the cache delete.

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
1. Export a pure helper that returns a host's pair (apex, www) or null. `www.<a>` with `<a>` containing a dot, passing `DOMAIN_RE`, and not an IPv4 literal pairs as (`<a>`, `www.<a>`); any other host passing those tests pairs as (host, `www.` + host); everything else returns null. Case-insensitive; a non-default port is kept on both hosts.
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

**Goal:** every entry point names a site from the recorded fold, and every saved audit keeps that record current and a folded site to one stored record (R5, R7, R8, R9).

**Requirements:** R5, R7, R8, R9. KTD1, KTD2, KTD5, KTD7, KTD9.

**Dependencies:** U1, U3, U5.

**Files:**
- `src/worker/audit-web/core.ts`
- `src/worker/audit-web/cache.ts`
- `src/worker/audit/api.ts`
- `src/worker/audit/result.ts`
- `src/worker/mcp/tools/web-audit.ts`
- `src/worker/audit-web/rescore-workflow.ts`
- `src/shared/audit-envelope.ts`
- `src/worker/telemetry/log.ts`
- `tests/audit-api.test.ts`
- `tests/audit-result-route.test.ts`
- `tests/web-audit-mcp-tools.test.ts`
- `tests/web-audit-cache.test.ts`
- `tests/web-audit-rescore-workflow.test.ts`

**Approach:**
1. Add the resolver to `core.ts` (KTD2) and call it from `handleWeb`, `siteTarget`, and `serveWeb`, before each one's cache read. On the follow opt-out path the resolver runs before `readStandingListing` (`handleWeb`'s transient branch and the opt-out branch of `audit_website`), and the transient envelope carries the engine's site name.
2. `serveWeb` answers a resolved `www.<a>` with a 301 to the same representation of `/score/<a>`. The `/json` 301 carries `Access-Control-Allow-Origin: *`, like every JSON response, because the Fetch standard applies the CORS check to the redirect itself.
3. `buildWebEnvelope` (`src/shared/audit-envelope.ts`) takes `target_url` from the scorecard's `target_url`, falling back to the record's (KTD6).
4. In `runWebAuditStream`, start the engine at the host as requested and apply KTD5's three write rules, with the listing, held-run, purge, aggregate, and render steps keyed on the name written. On a fold, resolve the listing in KTD5's order, taking `www.<a>`'s stored listing, when the order reaches it, from its record (the tier's own read when the request named `www.<a>`, else one tolerant `get`); then, once `cachePut` reports the write landed, delete `www.<a>`'s key (`keyFor` of `https://www.<a>/` at `SPEC_VERSION`) through a new delete in `cache.ts`, beside `put`, that never throws and logs a failure under a new `web-cache.delete` scope.
5. `auditDomainToCache` applies KTD5's write rules, deletes `www.<seed>`'s record through the same delete once a folded `cachePut` lands, keeps its `isSeededDomain` listing, and reports whether the stored scorecard or the new one carries `site_hosts`; the rescore cycle's purge adds `webDomainTag('www.<seed>')` for each such seed (KTD5).
6. `boardMetadataOf` adds a `site_hosts` value when the scorecard carries one; `listAllWebAudits` drops a leftover `www.<a>` row, one whose delete did not land, when an `<a>` row's `site_hosts` names it, collected before the excluded-domain and display-age filters (KTD7).
7. Key admission, the in-flight lock, and the job on the resolved name (KTD9).

**Patterns to follow:** `readStoredWebAudit` and `readWebTier` in `core.ts`; the `redirect` helper in `result.ts`; `isBoardListable` as the shape of a listing predicate; `put`'s never-throw shape in `cache.ts` for the delete.

**Test scenarios:**
- Covers AE1. With a stored `cnn.com` record whose `site_hosts` names `www.cnn.com`, `/score/www.cnn.com`, `/score/www.cnn.com/md`, and `/score/www.cnn.com/json` answer 301 to the matching `/score/cnn.com` path.
- With a stored `cnn.com` record lacking `site_hosts`, `/score/www.cnn.com` serves the stored `www.cnn.com` record, or the missing page when there is none.
- `get_website_audit({ url: "https://www.cnn.com/" })` with a folded `cnn.com` record answers `found: true`, `target: "cnn.com"`.
- `get_website_audit({ url: "www.x.test" })` with no `x.test` record and no `www.x.test` record answers `found: false` naming `www.x.test`.
- Covers AE2. `POST /api/score` for `www.stripe.com` with no stored records, whose stubbed audit folds, writes under `stripe.com`, ends on an envelope with `target: "stripe.com"`, and queues purges for both hosts' domain tags.
- Covers AE5. A saved audit of `a.test` whose engine reports unfolded, where the stored record had `site_hosts`, writes `a.test` without `site_hosts`, deletes no record, and queues a purge of `www.a.test`'s domain tag.
- Covers AE6. A saved audit of `a.test` whose engine reports no answer from `www.a.test` (a 503), where the stored record had `site_hosts`, writes `a.test` with `site_hosts` kept, deletes no record, and queues no purge of `www.a.test`'s domain tag.
- A listing holding `www.a.test` and an `a.test` row whose `site_hosts` metadata names it returns only `a.test`; with no such `a.test` row it returns both.
- With `excludeDomains` holding `a.test`, an `a.test` row whose `site_hosts` names `www.a.test`, and a listed `www.a.test` row, the listing returns no row. The same holds when the `a.test` row is past the display window.
- A blank-listing request for `www.a.test` whose audit folds, with no `a.test` record and an opted-in `www.a.test` record, writes `a.test` opted in and leaves no `www.a.test` record.
- A blank audit of `a.test` that folds, with an opted-in `www.a.test` record and no `a.test` record, writes `a.test` opted in and leaves no `www.a.test` record at the current spec version; a `www.a.test` record under an older spec version stays.
- With an opted-in `www.a.test` record and an unlisted `a.test` record, a blank audit of `a.test` that folds writes `a.test` unlisted, because `a.test`'s own record decides, and leaves no `www.a.test` record.
- A folded audit whose `a.test` write fails deletes no `www.a.test` record.
- An explicit listing change on a `www.a.test` request with no recorded fold meters the flip budget on `www.a.test` before the run; when the run folds, `a.test` is written with that choice and the budget is not metered again.
- With a folded `a.test` record, a request for `www.a.test` starts the engine at `www.a.test`; when the pair reports unfolded, the run writes `www.a.test` as its own site, unlisted on a blank request, patches `a.test`'s record to remove `site_hosts`, and queues a purge of `www.a.test`'s domain tag.
- With a folded `a.test` record, a request for `www.a.test` whose pair reports no answer writes `a.test` with `site_hosts` kept and `tool.name` `a.test`, and deletes no record.
- With a folded `a.test` record and an in-flight `a.test` run, a blank-listing request for `www.a.test` attaches to that run.
- A follow opt-out request for `www.a.test` whose audit folds answers a transient envelope naming `a.test`, through `POST /api/score` and through `audit_website`, and deletes no record.
- When the read of `a.test`'s record throws `WebCacheUnavailableError`, `/score/www.a.test` answers 503 `cache_unavailable` and `get_website_audit` answers `isError: true` with `cache_unavailable`; neither reads `www.a.test`'s record.
- `audit_website` for `www.a.test` with an unreadable `a.test` record audits, folds, and writes `a.test`.
- The folded `/score/www.cnn.com/json` 301 carries `Access-Control-Allow-Origin: *`.
- The envelope for a folded apex-to-www audit has `target: "cnn.com"` and `target_url: "https://www.cnn.com/"`; an unfolded audit's envelope `target_url` is unchanged.
- A rescore whose run folds stores `site_hosts`, deletes a stored `www.<seed>` record, and its purge includes `web:www.<seed>`; a rescore that drops a stored fold includes it too and deletes nothing.
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
- `src/worker/audit-web/audit-log.ts`
- `src/worker/audit-web/core.ts`
- `tests/web-audit-site-pair.test.ts` (new)
- `tests/web-audit-antecedents-engine.test.ts`

**Approach:**
1. Before `readDiscoveryDocuments`, resolve the pair from the audited host's root fetch (first hop recorded) and the other host's root (one request, redirects not followed), in parallel.
2. Apply KTD3 and the first HTD flowchart; return the pair outcome (folded, unfolded, or no answer), the probe origin, the site's origin set, and the site name.
3. Of what `normalizeBase(input.url)` returns, `base` and the root response come from the probe origin, and `readDiscoveryDocuments` reads from it; `domain` (the scorecard's `tool.name`) and `host` come from the site name. The handler context's `host`, which only `dns-doh` reads, stays the site name (the apex on a fold), because a redirect says nothing about where DNS records live. Hand the origin set to the U4 predicate and to `fetchOptions`, and carry the site name to the scorecard build (U5).
4. When the probe origin did not answer and the sibling's root answered (not a timeout, a transport failure, a 429, or a 5xx) without redirecting to the audited host, the unreachable reason ends `www.a.test answered.` with the sibling's host, the event carries the sibling's origin, and the core's `cta` reads `Audit https://www.a.test/ instead.` Otherwise the reason and `cta` keep their current wording.
5. The pair resolution reads no follow switch and draws no domain-budget unit (KTD8).
6. The audit's existing `web-audit.run` log record (`src/worker/audit-web/audit-log.ts`) carries the pair outcome (folded, unfolded, or no answer) and the first-hop status of each root, so a site that did not fold can be diagnosed from the logs.

**Execution note:** write the pair-resolution tests against a stub fetch first; they are the contract U6 records into the corpus.

**Patterns to follow:** the existing root fetch in `auditWith`; stub-fetch tests in `tests/web-audit-antecedents-engine.test.ts`.

**Test scenarios:**
- Covers AE1. Audit of `n.test` whose root answers 301 to `https://www.n.test/`: folded, probe origin `https://www.n.test/`, name `n.test`.
- Covers AE2. Audit of `www.n.test` whose root answers 301 to `https://n.test/`: folded, probe origin `https://n.test/`, name `n.test`.
- Audit of `n.test` whose root answers 200 while `www.n.test`'s root answers 301 to `https://n.test/`: folded, probe origin `https://n.test/`, name `n.test`.
- Audit of `n.test` whose root redirects to `https://www.n.test/en-us/`: folded, probe origin `https://www.n.test/`.
- Covers AE3. Audit of `www.n.test` whose root redirects to `https://n.test/`, which redirects to `https://third.test/`: folded, name `n.test`, and the root response is the one followed to `third.test`.
- Audit of `n.test` whose root redirects to `https://third.test/` while `www.n.test`'s root answers 404: not folded, name `n.test`.
- Covers AE4. Audit of `n.test` that gets a transport failure or a 530 while `www.n.test` answers 200: not folded, unreachable, and the reason ends `www.n.test answered.` and the `cta` reads `Audit https://www.n.test/ instead.`
- Audit of `n.test` that gets a transport failure while `www.n.test` also fails: unreachable with the current wording.
- An apex-to-www fold of `n.test` queries `_index._agents.n.test` in the DNS-AID check.
- Covers AE4. Audit of `www.n.test` answering 200 while `n.test` fails: not folded, name `www.n.test`, probe origin `https://www.n.test/`.
- Both roots answer 200 with no redirect: outcome unfolded, name is the audited host.
- `n.test` answers 200 while `www.n.test` answers 503, 429, or a transport failure: outcome no answer, probe origin `https://n.test/`, name `n.test`.
- `n.test` answers 200 while `www.n.test` answers 404: outcome unfolded.
- `n.test` answers 429 while `www.n.test` answers 200: outcome no answer.
- `n.test` answers 301 to `https://www.n.test/` while `www.n.test` stalls: folded, with no wait for the sibling.
- `n.test` answers 200 while `www.n.test` stalls past the bound: not folded, and the pair step ends at the bound.
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
- `src/worker/audit-web/handlers/api-probe-url.ts`
- `src/worker/audit-web/handlers/content-without-js.ts`
- `src/worker/audit-web/handlers/scoped-llms.ts`
- `src/worker/audit-web/handlers/shared.ts`
- `src/worker/audit-web/ssrf.ts`
- `src/worker/audit-web/registry.ts`
- `tests/web-audit-discovery.test.ts`
- `tests/web-audit-follow.test.ts`
- `tests/web-audit-ssrf.test.ts`
- `tests/web-audit-api-anchors.test.ts`

**Approach:**
1. Search the repository for `sameOrigin(` and `.origin ===` / `.origin !==` comparisons against the audit's base, and list each one; KTD4 names the expected set.
2. Replace each with the on-site predicate over the site's origin set; a site with one origin behaves exactly as today.
3. In `guardedFetch`, a hop counts as on-origin for `crossOriginRedirects` when the next origin equals the request's origin, or when both the request's origin and the next origin are in the site-origin set.
4. Raise `FOLLOW_POLICY_VERSION` in `src/worker/audit-web/registry.ts` from 1 to 2 (KTD7). The corpus goldens carry no fingerprint, so none changes.
5. Leave the alias check in `assert.ts`, reciprocity, the follow slice, and comparisons against a declared host's origin unchanged.

**Patterns to follow:** `sameOrigin` in `discovery-documents.ts` as the shape of the predicate; the `crossOriginRedirects` handling in `guardedFetch`.

**Test scenarios:**
- Covers AE1. A folded site probed at `www.n.test` whose server card names `https://n.test/mcp`: the endpoint resolves as the site's own endpoint, not a declaration.
- A folded site probed at `www.n.test` whose common-path POST to `/mcp` redirects to `https://n.test/mcp`: no redirect declaration is recorded and the POST is followed.
- An unfolded site whose POST to `/mcp` redirects to `https://www.n.test/mcp`: recorded as a declaration exactly as today.
- `declaresHost` for a URL on the other host of a folded pair returns false; for a third host it returns true.
- An api-catalog anchor on the other host of a folded pair groups as `audited-origin`.
- `guardedFetch` with site origins `{n.test, www.n.test}` follows a 308 from `n.test` to `www.n.test` under `crossOriginRedirects: 'refuse'`, and still refuses a hop to `evil.test`.
- A hop from `n.test` to `www.n.test` that resolves to a blocked address is still refused by `validatePublicUrl`.
- With site origins `{n.test, www.n.test}`, a `crossOriginRedirects: 'return'` GET to `api.other.test` that redirects to `https://www.n.test/` is returned unfollowed.
- For a folded site probed at `www.n.test`, an llms.txt link to `https://n.test/docs.md` is fetched, and a root link to `https://n.test/about` counts for content-without-js.

**Verification:** the discovery, follow, ssrf, and api-anchor suites pass; the declared-hosts trail of a folded stub audit never names the other host.

### U5. Scorecard fields, page line, and schema doc

**Goal:** the scorecard and both page representations name the site and say where it was audited (R10, R11).

**Requirements:** R10, R11. KTD6.

**Dependencies:** U3.

**Files:**
- `src/worker/audit-web/scorecard.ts`
- `src/worker/audit-web/engine.ts`
- `src/worker/audit-web/provenance.ts`
- `src/worker/audit-web/summary-provenance.ts`
- `src/worker/audit-web/summary-model.ts`
- `src/worker/audit-web/summary-render.ts`
- `src/worker/audit-web/summary-markdown.ts`
- `src/shared/scoring-copy.ts`
- `content/web-scorecard-schema.md`
- `tests/web-audit-scorecard-format.test.ts`
- `tests/web-audit-provenance-render.test.ts`
- `tests/web-audit-transient-summary.test.ts`

**Approach:**
1. The engine's scorecard build takes the site name for `tool.name` and `tool.url`, the probe origin for `target_url`, and `site_hosts` (apex first) only on a fold.
2. Row provenance treats a host in `site_hosts` as the audited host, in `provenance.ts` and in the other-hosts split in `summary-provenance.ts`. The engine's `discovery` event carries the site's hosts, and the progress page's `rowHostPhrase` and `streamedHosts` (`src/shared/scoring-copy.ts`) treat any of them as the target.
3. The website line in `summary-render.ts` and its twin in `summary-markdown.ts` add the audited-at clause only when `site_hosts` is present and `target_url`'s host differs from `tool.name`.
4. In `content/web-scorecard-schema.md`: the `target_url` row reads "The origin the checks ran against: scheme, host, trailing slash. On a folded site, the host the www/bare redirect lands on."; the `tool.name` row reads "The site's name: the audited host, or the bare domain when `site_hosts` is present."; the `tool.url` row reads "The site's URL. Equals `target_url` unless `site_hosts` is present and the checks ran at the www host."; a new `site_hosts` row reads "array of string, optional. Present only when one of the bare and www hosts redirects to the other: both hosts, bare first. Absent means no fold was recorded: the pair did not fold, or the scorecard predates the field." After the optional-fields paragraph, one sentence: "The audited host is `target_url`'s host; the audited site is every host in `site_hosts`, or the audited host alone." The rows that say "audited origin" for a site-level comparison say "audited site".

**Patterns to follow:** the optional `follow_declarations` and `declared_hosts` fields in `WebScorecard`; the existing website clause in `summary-render.ts`.

**Test scenarios:**
- A folded apex-to-www scorecard serializes `tool.name` as the apex, `target_url` as the www origin, and `site_hosts` with the apex first.
- A folded www-to-apex scorecard has `target_url` equal to `tool.url` and still carries `site_hosts`.
- An unfolded `www.n.test` scorecard names `www.n.test` in `tool` and has no `site_hosts` key.
- An unfolded scorecard's JSON is byte-identical to a pre-change scorecard for the same exchanges.
- The HTML page of a folded apex-to-www scorecard shows the apex and the audited-at clause; the markdown twin carries the same clause.
- A row whose evidence came from the other host of a folded pair renders as evaluated at the audited host.
- A folded `n.test` stream probed at `www.n.test` shows no "evaluated at" phrase on the progress page.

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
1. Add scenarios for: an apex-to-www fold with an MCP endpoint on www; a www-to-apex fold audited from the www host; an apex that does not answer, audited from the apex (unreachable, its golden carrying the reason that names the www host) and from www (its own site); a third-host redirect, not folded; both roots 200, not folded; a folded site whose common-path POST redirects across the pair.
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
- `src/worker/mcp/instructions.ts`
- `content/mcp-skill.md`
- `content/_audit-web.md`
- `CONCEPTS.md`
- `tests/web-audit-mcp-tools.test.ts`

**Approach:**
1. `get_website_audit`'s `url` description appends: "`www.<domain>` reads the `<domain>` scorecard when that scorecard records that one of the two hosts redirects to the other (its `site_hosts` lists both); `target` and `scorecard_url` then name `<domain>`. Otherwise `www.<domain>` is its own site, and a miss there may mean the pair has not been audited since the fold was recorded." Its "Returns isError:false for every outcome" becomes "Returns isError:false for every outcome but one: isError:true with cache_unavailable when a `www.<domain>` read cannot reach the `<domain>` record."
2. `audit_website`'s `url` description appends: "The audit first checks whether `<domain>` or `www.<domain>` redirects to the other. If one does, they are one site named `<domain>`: `target` and `scorecard_url` name `<domain>`, `scorecard.target_url` is the origin the checks ran at, and `scorecard.site_hosts` lists both hosts. A `www.` host with no such redirect is audited as its own site."
3. `list_website_audits`' description appends: "A site whose bare or `www.` host redirects to the other is listed once, under the bare domain." `get_web_remediation` takes no site and is unchanged.
4. `src/worker/mcp/instructions.ts` adds one clause to its web-tools summary: "a bare host and its www host are one site, named by the bare host, when one redirects to the other; a `www.` host with no such redirect is its own site."
5. `content/mcp-skill.md` and `content/_audit-web.md` state the rule once each, with the `target_url` and `tool.url` distinction (KTD6). The skill's list of fields a read carries gains: "`site_hosts`: on a site whose bare or `www.` host redirects to the other, both hosts, bare first; `target` and `scorecard_url` name the bare host and `target_url` is where the checks ran ([top-level fields](/web-scorecard-schema#top-level-fields))." Its `host` bullet ends "...reads as the host the checks ran at (`target_url`'s host)." Its `get_website_audit` bullet names the `cache_unavailable` outcome.
6. `CONCEPTS.md` gains an entry for the site fold if no existing entry carries it.

**Test scenarios:**
- The registered tool descriptions for `get_website_audit`, `audit_website`, and `list_website_audits` each contain their fold sentence, and `get_website_audit`'s names the `cache_unavailable` outcome.
- The session instructions contain the fold clause, both halves.

**Verification:** the MCP tools suite passes; `bun run build` regenerates `llms-full.txt` with the new skill text.

### U8. Staging verification and score attribution

**Goal:** prove the fold on the deployed staging Worker and attribute every curated score move (Success Criteria).

**Requirements:** R1 to R11.

**Dependencies:** U1 to U7 merged to `dev` and deployed to staging.

**Files:**
- none in the repository; the attribution table goes in the `release/*` PR body.

**Approach:**
1. Before the `dev` merge, record the staging scorecards of the 13 apex-to-www curated sites named in the Problem Frame, and audit `www.sivalabs.in` on staging, whose apex answers 301 to `www`, so a stored `www.` record exists.
2. After the `dev` deploy, wait for the post-deploy rescore's full reflow (`wrangler workflows instances describe web-rescore-staging <id>`), firing the manual trigger in `docs/runbooks/web-audit-operations.md` only for seeds a domain budget deferred (the og curated pass audits nothing). Confirm `site_hosts` on each of the 13 whose root's first hop lands on the other host, and list any other as unfolded, with its hop chain, in the attribution table.
3. For each site, list every row whose status changed and the fold behavior that changed it (a declared host gone, an MCP probe now reaching www). A site whose redirect reaches the other host only at a later hop is input for a follow-up, not this PR.
4. Check `/score/www.cnn.com` (301 after `cnn.com` is audited), the `cnn.com` page in both themes, `get_website_audit("www.cnn.com")` and `audit_website("https://www.cnn.com/")` through the staging MCP endpoint, both answering with the site `cnn.com`, an audit of a `www.` host with no redirect to or from its apex, and an audit of `sivalabs.in` that leaves `/score/www.sivalabs.in` answering 301 and no `www.sivalabs.in` key in the staging bucket, using the Cloudflare Access service-token headers.

**Test expectation:** none -- live verification of deployed behavior; the unit suites carry the logic.

**Verification:** the `release/*` PR body holds the before-and-after table with every move attributed, and the checks in step 4 pass.

---

## Verification Contract

| Gate | Command or check | Proves |
| --- | --- | --- |
| Lint and types | `bun run lint`, `bun run typecheck` | style and types across touched files |
| Build first | `bun run build` | `dist/` matches the branch before tests read it (AGENTS.md gate order) |
| Unit and corpus | `bun test` | U1 to U7 scenarios, the regenerated corpus, and unchanged goldens |
| Observed failing | each new U2 to U4 test run against the unfixed code, its failure output quoted in the PR | the tests detect the behavior they cover |
| Local Worker | `bun run dev` with `MCP_ENABLED="true"` in `.dev.vars.staging`; a local `audit_website` of one of the 13 apex-to-www sites makes the folded record; then `/score/www.<a>` and an MCP `get_website_audit` for it | the resolver, the redirect, and the MCP answer through the real Worker |
| Browser | the folded scorecard page in light and dark themes | R11's clause renders legibly (AGENTS.md "Browser-verify before declaring done") |
| Staging | U8 | live fold, redirect, MCP answer, an unfolded `www.` site, attributed score moves |
| Reviews | `ce-code-review`, `/devex-review`, `/cso` | code, agent-facing output, egress and redirect trust |

## Definition of Done

- R1 to R13 hold, each covered by a U1 to U7 test scenario or by U8.
- Every pre-existing conformance golden is byte-identical; the new scenarios pass.
- The `release/*` PR carries U8's attribution table, with no unexplained curated score move.
- The agentnative-cli follow-up is filed as its own plan or brief, naming the commit this PR lands as the pin.
- No dead-end code from abandoned approaches remains in the diff.
- The PR's `## Changelog` carries: "Added: web audits treat `www.<domain>` and `<domain>` as one site when either redirects to the other; the scorecard is stored and shown under `<domain>`, `/score/www.<domain>` answers 301, scorecards gain an optional `site_hosts` field, and the unreachable error names a `www.` or bare host that answered."

---

## Review log

- 2026-11-10: plan written at 96549a9.
- 2026-11-10: `/plan-eng-review` round 1 started at ccd44e6 and was stopped before it reported, because the owner's answer to D3 replaced the naming design it was reviewing.
- 2026-11-10: plan reworked to the owner's answers to D1 to D8: folding needs an observed redirect, and the apex's stored scorecard records it.
- 2026-11-10: `/plan-eng-review` round 1 started on the reworked plan at 5c62277 (Opus, effort high).
- 2026-11-10: `/plan-eng-review` round 1 ended on dbc0942: ship with fixes; 0 P0, 1 P1 (the board guard could not see a curated apex), 7 P2. All folded in. The `www.<a>` opt-in carry was settled from the `public_listing` contract; the unanswered-sibling and first-hop questions went to the owner (Outstanding Questions).
- 2026-11-10: `/plan-devex-review` round 1 started at 9030fcc (Opus, effort high).
- 2026-11-10: `/plan-devex-review` round 1 ended on e40f857: ship with fixes; 0 P0, 2 P1 (a cache read failure reported as a miss; the envelope `target_url` carrying a second meaning), 6 P2. All folded in except the sibling hint on the unreachable error, recorded under Scope Boundaries. `schema_version` stays `0.5` on the #395 precedent; the 429/5xx refinement went to the owner with Outstanding Question 1.
- 2026-11-10: `/compound-engineering:ce-doc-review` round 1 started at 93dd136 (Opus, effort high, depth full).
- 2026-11-10: owner answers folded in: a recorded fold survives a sibling that gives no answer (a timeout, a transport failure, a 429, or a 5xx), and the pair rule reads the first hop only. The opt-in carry, `schema_version` `0.5`, and the unreachable-error hint wait for the owner (Outstanding Questions).
- 2026-11-10: `/compound-engineering:ce-doc-review` round 1 ended on 9fc6220: ship with fixes; 0 P0, 2 P1 (a stored `www.` opt-in could leave the board; U8 could not run before merge approval), 10 P2. All folded in, including starting the engine at the host as requested, raising `FOLLOW_POLICY_VERSION`, and `/cso`. Mid-run flip metering on `<a>` was cut under the smallest-change rule. Owner answers folded in at the same time: the opt-in carry and `schema_version` `0.5` are confirmed, and the unreachable error names a sibling that answered; Outstanding Questions is cleared.
- 2026-11-10: owner decision folded in: one stored record per site. A folded write deletes `www.<a>`'s record once the apex's write lands, the listing order puts the apex's stored listing before `www.<a>`'s, the rescore Workflow deletes too, and the board guard stays as the backstop for a delete that does not land. No review round: the decision applies to a plan whose three reviews are done, and the implementation PR carries the code reviews.
- 2026-11-10: `/compound-engineering:ce-code-review` round 1 started on PR 557 at 76d9ff1 (Opus, effort high).
- 2026-11-10: `/devex-review` round 1 started on PR 557 at 76d9ff1 (Opus, effort high).
- 2026-11-10: `/cso` round 1 started on PR 557 at 76d9ff1 (Opus, effort xhigh).
