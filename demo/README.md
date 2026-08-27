# Sounding

A tiny public depth-reading API. It is the **audit patient** for the anc.dev WebMCP challenge clip, not the WebMCP
product. Judges collaborate on [anc.dev](https://anc.dev/web-audit); this host is what they score.

Live Worker name: `sounding` → `https://sounding.brettdavies.workers.dev`

## Broken state (what we deploy)

The page, `/api/reading`, `/llms.txt`, robots, the well-known MCP card, and MCP CORS already pass. Three MUST rows stay
red on purpose:

1. **`openapi`:** `<link rel="service-desc">` points at `/openapi.json`; the file is not served.
2. **`mcp-initialize`:** the card discovers `/mcp`; `initialize` omits `serverInfo`.
3. **`mcp-tools-list`:** `tools/list` omits `tools[]`.

Do not "fix" `mcp-cors-*`. CORS already ships.

## Clip (two loops, one fix pass)

On production anc.dev `/web-audit` (ChatGPT in-app or Chrome with WebMCP):

1. **Loop 1 (gaps).** `fill_audit_url` with this host. Human clicks Audit. On `/web/sounding.brettdavies.workers.dev`,
   `get_worksheet` then `get_fix_prompt` for all three MUST ids (`openapi`, `mcp-initialize`, `mcp-tools-list`). Never
   `mcp-cors-*`.
2. **One pass.** Apply all three prompts in `demo/src/index.ts` (serve `/openapi.json`, add `serverInfo.name` on
   `initialize`, return a `tools` array from `tools/list`). Deploy.
3. **Loop 2 (closed).** Human Audit again. `get_worksheet` has no MUST rows.

Between takes, restore the patient and the live Worker:

```bash
scripts/sounding-restore.sh
```

That checks `demo/` out from the annotated tag `sounding-broken` and runs `wrangler deploy`. It does not touch the rest
of the repo. Add `--commit` only on a `feat/*` branch; it refuses `dev` and `main`.

The passing shape is also `createSoundingHandler({ complete: true })`, used in tests, not in the default export.

## Deploy

```bash
cd demo
npx wrangler deploy
```

Public host, no Access. Do not add this domain to `src/data/web-audit/seed.yaml`.
