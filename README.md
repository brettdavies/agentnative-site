# agentnative-site

Source for the agent-native CLI standard website. Presents the 7 principles for building CLI tools that AI agents can
operate as first-class users. The site also hosts curated tool scorecards at `/score/<tool>` and a live-scoring form at
`/score` that returns shareable results at `/score/live/<binary>`.

## Development

Static HTML + CSS. No build step. Open `index.html` in a browser.

After cloning, point git at the repo's hook directory once:

```bash
git config core.hooksPath scripts/hooks
```

This enables `scripts/hooks/pre-push`, which runs `bun run lint`, `bun run build`, `bun test`, and `wrangler deploy
--dry-run` before every push — the same gates CI enforces. Bypass intentionally with `git push --no-verify` if you
really need to (rare; the hook exists to catch what we've lost time to before).

## Deployment

Cloudflare Workers. Pushes to `main` deploy automatically.

## Related

- [agentnative-cli](https://github.com/brettdavies/agentnative-cli) — the CLI linter that checks compliance with this
  standard
- [agentnative-skill](https://github.com/brettdavies/agentnative-skill) — the agent-native-cli skill bundle (SKILL.md +
  checklists + scripts) installed via [anc.dev/skill](https://anc.dev/skill)
