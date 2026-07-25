# Session Handoff

Snapshot as of 2026-07-25, for whoever (human or Claude) picks this project up next. This is a point-in-time narrative of what happened and what to watch — the evergreen docs are `README.md` (what the system is / how it works) and `CLAUDE.md` (non-obvious gotchas future changes need to respect). Read those for depth; this file is the "what happened and what's next" summary.

## What shipped this session

Starting point: a bare `npm create vite` scaffold with no functionality.

1. **Base deploy pipeline** — GitHub Pages via Actions (`deploy.yml`), verified live before building anything else.
2. **Scraper v1** — single-file `articles.json`, fixed count, proved full-text search (not just titles) works against real PTT data.
3. **Restructured storage** — per-date JSONL under `public/data/articles/`, tracked via Git LFS, plus `manifest.json` listing available dates for the static frontend to discover them.
4. **Two scraping modes** — `new` (incremental, hourly `:00`) and `catchup` (historical backfill to `CUTOFF_DATE = 2026-07-01`, hourly `:30`).
5. **Category slider toggle** (全部/賣/徵/估價) — filters by title only, per requirement.
6. **Three real production bugs found and fixed via actual log/pixel audits, not guesswork**:
   - `manifest.json` being part of the scrape workflows' own commit diff caused frequent, real rebase conflicts against each other — silently discarded four consecutive ~36-40 minute catch-up runs. Fixed by regenerating it fresh post-rebase instead of merging it.
   - `deploy.yml` pinned checkout to `workflow_run.head_sha`, which is the commit the triggering workflow *started* from, not what it pushed after finishing — the live site was serving stale pre-scrape data despite "successful" deploys.
   - The category toggle's sliding thumb had two independent CSS bugs (percentage-transform drift, border-box/padding-box mismatch), found by pixel-measuring actual screenshots rather than eyeballing.
7. **Reliability hardening** — `ARTICLE_DELAY_MS` dropped from 60s to 10s (6x faster) once the above were fixed; push retry loop added after stress-testing revealed a narrower remaining race; `scrape-new` given its own persisted resume cursor (`data/state/new.json`) so it can no longer leave a silent permanent gap if a backlog ever exceeds one run's page budget.
8. **`scrape-catchup` now disables its own schedule on completion** — previously, once `catchup.json` hit `done: true` the workflow would just keep running a cheap no-op every 30 minutes forever. It now calls `gh workflow disable` on itself in that case (see `CLAUDE.md`). Not yet observed running for real, since catch-up hasn't reached `CUTOFF_DATE` yet — see open items below.

## Current live status

- Site: https://b11015006.github.io/HardwareSale/
- Data as of last check: 7 date files (`2026-07-19` through `2026-07-25`), regenerating `manifest.json` correctly.
- `scrape-catchup` cursor: resuming from `index4000.html`, not yet reached `2026-07-01`. At ~2 pages/hour and roughly 1.4 pages/day of board history, expect somewhere in the ballpark of half a day to a day of continued hourly runs before it reaches the cutoff and sets `done: true` on its own — no action needed, just let it run.
- `scrape-new` cursor: `null` (caught up as of last run).
- Both scrape workflows and the deploy cascade have been verified working end-to-end in production CI this session, including a deliberate concurrent-dispatch stress test.

## Open items / possible follow-ups (none urgent, none requested yet)

- `MAX_PAGES_PER_ROUTINE_RUN` / `MAX_PAGES_PER_CATCHUP_RUN` are still `2`, sized for the old 60s/article delay. At the new 10s/article rate there's a lot of unused time budget per hourly run (a full run now takes minutes, not tens of minutes) — raising the cap would speed up the remaining catch-up backfill and give `scrape-new` more backlog-absorption headroom per run, but nobody's asked for it and the current pace is already reasonable.
- **Watch for**: when `scrape-catchup` finally reaches `CUTOFF_DATE` and sets `done: true`, confirm its new self-disable step (item 8 above) actually fires and the workflow shows as disabled in the Actions tab afterward, rather than assuming it worked — it hasn't been exercised against a real completed run yet.
- No monitoring/alerting on workflow failures beyond checking the Actions log manually. If that matters going forward, GitHub's built-in email-on-failure (repo settings → notifications) is the zero-effort option.
- The frontend fetches every date's `.jsonl` file individually on load; fine at 7 files, would eventually want reconsidering if this runs for months and accumulates hundreds of date files.

## Where to look

- `CLAUDE.md` — every non-obvious gotcha above, in detail, with the reasoning for why the fix is shaped the way it is. Read before touching the scraper or workflows.
- `README.md` — architecture, data layout, scraper modes, local dev commands.
- `git log` — commit messages this session are deliberately detailed (root cause, what was tried, what was verified) rather than terse; they're written to be read later.
