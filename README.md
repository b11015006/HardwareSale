# HardwareSale Search

A full-text search app for the [PTT HardwareSale](https://www.ptt.cc/bbs/HardwareSale/index.html) board — searches article **content**, not just titles. Live at https://b11015006.github.io/HardwareSale/.

## How it works

Since this is a static GitHub Pages site, scraping happens offline via scheduled GitHub Actions rather than in the browser (PTT doesn't send CORS headers, and client-side scraping would be unreliable and impolite anyway):

1. **Scraper** (`scripts/scrape.mjs`) fetches board pages and article bodies, stores them as JSONL.
2. **CI workflows** run the scraper hourly and commit the results to `main`.
3. **Frontend** (`src/main.ts`) fetches the stored data and searches it client-side in the browser.

## Data layout

Articles are stored one file per post date, tracked via [Git LFS](https://git-lfs.com/):

```
public/data/
  manifest.json              # { dates: [...], updatedAt }
  articles/
    2026-07-01.jsonl         # one JSON object per line, one file per date
    2026-07-02.jsonl
    ...
```

Each line is an `Article` (see `src/types.ts`):

```json
{"id":"M.1784894308.A.601","title":"...","author":"...","postedAt":"...","dateKey":"2026-07-24","url":"...","content":"..."}
```

`public/data/` is copied as-is into `dist/` by Vite, so the frontend fetches `manifest.json` then every listed date's `.jsonl` file (in parallel), merges them, and sorts newest-first before rendering/searching.

## Scraper modes

`scripts/scrape.mjs` has two modes, run by two separate hourly workflows:

- **`new`** (`.github/workflows/scrape-new.yml`, `:00` hourly) — walks backward from the board's newest page only until it finds an article already stored. Self-healing: if a run is missed, it just walks back further next time.
- **`catchup`** (`.github/workflows/scrape-catchup.yml`, `:30` hourly) — backfills history. Resumes from a cursor saved in `data/state/catchup.json` and pages further backward each run until it reaches articles older than `CUTOFF_DATE` (currently `2026-07-01`, set in `scripts/scrape.mjs`). Expected to take many runs (hours) to fully catch up.

Both are rate-limited to be polite to PTT: index/listing pages at 1 request/sec, individual article-content pages at **1 request/min**. Because of that, each run's page cap is kept small (2 pages) so a run can't run past the hourly schedule.

After either workflow commits new data, `deploy.yml`'s `workflow_run` trigger rebuilds and redeploys the site (a `GITHUB_TOKEN`-authored commit doesn't cascade into other push-triggered workflows on its own, hence the explicit trigger).

## Local development

```bash
npm install
npm run dev              # dev server
npm run build             # typecheck + production build to dist/
npm run preview           # serve dist/ locally

npm run scrape:new        # run the incremental scraper once
npm run scrape:catchup    # run the backfill scraper once
```

Git LFS must be installed locally (`git lfs install`) before committing changes to any `*.jsonl` file — see `.gitattributes`.

## Deployment

GitHub Pages, deployed via `.github/workflows/deploy.yml` (Actions-based deployment, not a branch). The site is served at `/HardwareSale/`, matching `base` in `vite.config.ts`.
