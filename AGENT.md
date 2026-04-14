# Agent Instructions

## Project

Static website for the agent-native CLI standard. Plain HTML + CSS, no frameworks, no build step. Deployed via
Cloudflare Pages.

## Structure

- `index.html` — single-page spec site presenting the 7 agent-native principles
- `styles.css` — minimal CSS (standards sites are intentionally simple)
- No JavaScript unless strictly necessary

## Voice

This site presents a technical standard, not a personal project. The tone is authoritative and concise, modeled after
[12factor.net](https://12factor.net) and [clig.dev](https://clig.dev). No marketing language. No hype.

Brand voice guidelines are symlinked at `.context/brand/` (if present). The canonical voice anchor is the xAI cover
letter in the obsidian vault.

## Cross-Repo Context

- **CLI source:** `brettdavies/agentnative` — the Rust linter that checks compliance
- **Brand system:** `obsidian-vault/Projects/brettdavies-Brand-System/` — positioning, voice, audiences
- **Design doc:** `~/.gstack/projects/brettdavies-obsidian-vault/brett-main-design-20260413-181410.md`
