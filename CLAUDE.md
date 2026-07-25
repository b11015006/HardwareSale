# CLAUDE.md

Guidance for future Claude Code sessions working in this repo. See `README.md` for the user-facing overview; this file is about things that aren't obvious from reading the code once.

## What this is

A static search app over the PTT HardwareSale board, deployed to GitHub Pages. Scraping happens offline in GitHub Actions (not in the browser — PTT has no CORS headers), writing JSONL files that the frontend fetches and searches client-side. Full architecture is in `README.md`.

## Rate limiting is load-bearing, not decoration

`scripts/scrape.mjs` throttles article-content fetches (`ARTICLE_DELAY_MS`, currently 10s) and index-page fetches (`INDEX_DELAY_MS`, 1/sec). This was an explicit user requirement ("don't want to cause any problem for the management"), not a performance default. If you change scraping behavior:

- Don't lower these delays without being asked.
- The per-run page caps (`MAX_PAGES_PER_ROUTINE_RUN`, `MAX_PAGES_PER_CATCHUP_RUN`, currently both `2`) exist specifically so a run doesn't exceed the hourly cron interval (~20 articles/page × `ARTICLE_DELAY_MS` per run, worst case). If you raise the page cap or lower the delay further, re-check that a worst-case run still finishes comfortably inside an hour — a run that's still going when the next hourly trigger fires doesn't get killed, but it does mean two scrape jobs overlapping, which increases the odds of the push race described below.
- Never test the scraper's multi-page pagination against the live PTT site with the real delay constants — that's tens of minutes of real requests for a smoke test. If you need to verify pagination/cursor logic, temporarily shrink the page cap (not the per-request delay) for the test, then restore it before committing. See git history around the catchup mode rewrite for the pattern used.

## Known PTT HTML quirks (already handled, but relevant if PTT changes markup)

- The "previous page" (older) pagination link's text is **`‹ 上頁`**, not `上頁` — an exact-match filter silently finds nothing. `parseIndex()` in `scripts/scrape.mjs` uses `.includes("上頁")` for this reason. This bug shipped once already and was only caught by testing catchup mode's pagination directly.
- A small number of articles lose their `article-metaline` block entirely (users sometimes select-all-and-cut while editing on mobile clients), leaving no parseable title/author/postedAt. `dateKeyFromId()` falls back to the Unix epoch embedded in the article id (`M.<epoch>.A.<hash>`) for date bucketing in that case. Don't assume `postedAt` is always populated.
- Pinned/announcement posts (`[公告]` prefix) are filtered out in `parseIndex()`. If the board's pinning convention changes, that filter needs to change too.

## Git LFS

All `*.jsonl` files are tracked via Git LFS (`.gitattributes`), declared as UTF-8 text with LF line endings. This matters in a few places:

- Every `actions/checkout@v4` step across all three workflows needs `lfs: true`. Without it, checkouts fetch pointer text instead of real content — this breaks both the deployed site (search would load garbage) and the scraper's dedupe logic (`loadExistingIds()` would silently see nothing, since pointer text doesn't parse as our expected JSON lines, and re-scrape everything from scratch).
- Local dev needs `git lfs install` run once per clone before touching `*.jsonl` files.
- If you ever see `git status` report `.jsonl` files as modified with no actual content change, it's almost always the LFS clean/diff filter reacting to a `.gitattributes` change, not real edits — check `git diff --stat` before assuming something broke.

## Frontend: positioning the category toggle's sliding thumb

The `.category-toggle` slider (`src/main.ts`, `positionThumb()`) had two separate, real bugs found by pixel-measuring actual screenshots rather than guessing:

1. **Don't drive a sliding indicator with `transform: translateX(N * 100%)` across unequal-width items.** `100%` in a transform is relative to the *element's own* box, not the track. If the thumb's width isn't exactly the track divided evenly (ours was `calc(25% - 4px)`, short by the padding gap), each step undershoots and the error compounds — "correct" at index 0, visibly wrong by index 3. Fixed by measuring the checked label's real `getBoundingClientRect()` and setting the thumb's `left`/`width` in pixels directly, recomputed on every selection change and on window resize.
2. **`left` on an absolutely positioned element resolves against its containing block's padding box, but `getBoundingClientRect()` returns the border box.** With a 1px border on `.category-toggle`, computing `left` as `labelRect.left - containerRect.left` was silently off by that 1px, every time, in the same direction — read as "the pill is slightly off-center" rather than a crash, so it's the kind of bug that survives casual visual review. Fixed by adding `categoryToggle.clientLeft` (the actual rendered border width) to the reference point.

If you add another JS-positioned overlay element anywhere in this UI, both of these apply generally: prefer measuring real boxes over percentage math, and remember `getBoundingClientRect()` is border-box while absolute positioning is padding-box.

## `scrape-new` has a persisted cursor, same as catch-up

`scrapeNew()` used to always restart from the board's newest page and give up (with nothing recorded) if it hit `MAX_PAGES_PER_ROUTINE_RUN` before finding an already-known article. If the backlog since the last successful run ever exceeded that page cap — a missed run, a GitHub Actions outage, several consecutive push-retry failures — that run would silently leave a gap with no way to detect or close it, since the next run always started over from page 1 with no memory of how far it had gotten.

It now saves a cursor to `data/state/new.json` (mirroring `catchup.json`) whenever it hits the page cap without reaching a known article, and resumes from there next run instead of restarting from the top. This guarantees any backlog eventually gets fully closed over however many runs it takes, the same way catch-up already worked, rather than leaving a permanent hole. Verified locally by temporarily shrinking `MAX_PAGES_PER_ROUTINE_RUN` to 1 against a deliberately-stale local dataset: run 1 hit the cap and saved a cursor, run 2 resumed from that exact page (not the newest one) and correctly cleared the cursor on reaching the known boundary.

This matters specifically because `scrape-catchup` is a *one-time* historical backfill — once it reaches `CUTOFF_DATE` it sets `done: true` and stops running its backward-walking logic for good. Before this fix, catch-up incidentally acted as a safety net that would eventually re-discover anything `scrape-new` missed as it walked past that time period; after catch-up finishes, there's nothing left to catch a gap except `scrape-new` itself, so `scrape-new` needs to be able to close an arbitrarily large backlog on its own.

## `scrape-catchup` disables its own schedule once done

Once `scrapeCatchup()` reaches `CUTOFF_DATE` and writes `done: true` to `data/state/catchup.json`, `scrape-catchup.yml`'s last step (`Disable this schedule once catch-up is complete`) calls `gh workflow disable "${{ github.workflow }}"`, turning off both the cron trigger and manual `workflow_dispatch` for that workflow. Before this, a completed catch-up would just run a cheap no-op every 30 minutes forever instead of actually stopping.

- This step deliberately has no `if:` override, so it only runs if the commit/push step above it succeeded — it checks the *local* checkout's `catchup.json`, and if a push failed after all retries, that local `done: true` never made it to `origin/main`. Disabling the workflow in that scenario would strand catch-up permanently incomplete with no run left to retry it. Don't add `if: always()` here without also switching the check to the pushed/remote state.
- Needs `permissions: actions: write` on the workflow (in addition to the existing `contents: write`) — that's what lets `GITHUB_TOKEN` call the workflow-disable API.
- Disabling is done via the Actions API (`gh workflow disable`), not by editing/committing the YAML file itself — no extra permission scope, no commit to review, and it's reversible with `gh workflow enable` if catch-up ever needs to run again (e.g., `CUTOFF_DATE` gets moved further back).

## Two scrape workflows, one deploy trigger

`scrape-new.yml` (hourly `:00`) and `scrape-catchup.yml` (hourly `:30`, offset intentionally to avoid both pushing to `main` at the same moment) both commit with the default `GITHUB_TOKEN`. GitHub does not let `GITHUB_TOKEN`-authored pushes cascade into other push-triggered workflows — this is why `deploy.yml` has an explicit `workflow_run` trigger listening for both scrape workflow names, in addition to its `push` trigger. If you rename either scrape workflow's `name:`, update `deploy.yml`'s `workflow_run.workflows` list to match, or redeploys silently stop happening after a scrape.

Both scrape workflows `git fetch` + `git rebase origin/main` before pushing, to tolerate the (rare, given the 30-min offset) case where the other scrape workflow pushed in between.

**`public/data/manifest.json` is deliberately never committed as part of the scraper's own diff.** It's regenerated fresh (`node scripts/scrape.mjs manifest`) *after* `git rebase origin/main` and folded into the same commit with `git commit --amend --no-edit`, right before the final push. This was a real bug, not preemptive caution: manifest.json changes on nearly every run of either workflow (even a run that finds zero new articles still bumps `updatedAt`), and catch-up runs take 30-40+ minutes — long enough to almost always straddle the other workflow's run. Committing it as part of the initial diff meant `git rebase origin/main` regularly hit a real, unresolvable conflict on it, silently discarding that entire run's scraped data (rebase fails → job fails → nothing pushed, but the run already burned 30-40 minutes of rate-limited fetching). Caught by four consecutive failed catch-up runs in the Actions log. Treat manifest.json as a derived build artifact, never as something with its own independent edits to merge.

Even with that fix, the final `git push` itself is wrapped in a retry loop (re-fetch, re-rebase, regenerate manifest, re-amend, retry) — verified necessary by deliberately dispatching both scrape workflows within seconds of each other: the rebase itself succeeded cleanly (no more manifest.json conflict), but a genuinely concurrent push from the other workflow still landed in the few-second gap between rebase and push, and a bare `git push` has no way to recover from that on its own.

**Don't pin `deploy.yml`'s checkout to `github.event.workflow_run.head_sha`.** This was tried and shipped, then caught when a 40-minute catchup run's newly-scraped data didn't appear on the live site after a successful deploy. `head_sha` is the commit the *triggering* workflow started from, not whatever it pushes after its own job finishes — for these scrape workflows, that's a completely different (older) commit than the one containing the data the run just produced. The fix is to not set `ref:` at all and let `actions/checkout` default to main's tip at the deploy workflow's own trigger time, which by then correctly includes the scrape workflow's push.

## Testing changes

- `npm run build` (runs `tsc` first) is the fastest correctness check for frontend changes.
- Prefer testing scraper logic changes with tiny, deliberately-scoped local runs (see the rate-limiting note above) over trusting it blind — a background/preview HTTP server does not reliably persist across tool calls in this sandbox, so the real verification for frontend + data wiring is the deployed GitHub Pages site, not a local server.
- After pushing anything that touches `.github/workflows/`, actually watch the run (`gh run watch`) rather than assuming a config change was correct — this project has already hit both a real GitHub Actions infra hiccup ("job was not acquired by Runner") and a self-inflicted config bug (workflow_run trigger name mismatch) that were only caught this way.
