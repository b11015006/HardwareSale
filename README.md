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
public/data/                 # deployed as-is; what the frontend fetches
  manifest.json              # { dates: [...], updatedAt }
  articles/
    2026-07-01.jsonl         # one JSON object per line, one file per date
    2026-07-02.jsonl
    ...

data/state/                  # NOT deployed; scraper bookkeeping only
  new.json                   # { nextPageUrl, updatedAt } - scrape-new's resume cursor
  catchup.json               # { nextPageUrl, done, updatedAt } - scrape-catchup's resume cursor
```

Each line is an `Article` (see `src/types.ts`):

```json
{"id":"M.1784894308.A.601","title":"...","author":"...","postedAt":"...","dateKey":"2026-07-24","url":"...","content":"..."}
```

`public/data/` is copied as-is into `dist/` by Vite, so the frontend fetches `manifest.json` then every listed date's `.jsonl` file (in parallel), merges them, and sorts newest-first before rendering/searching.

## Scraper modes

`scripts/scrape.mjs` has two modes, run by two separate hourly workflows:

- **`new`** (`.github/workflows/scrape-new.yml`, `:00` hourly) — walks backward from the board's newest page until it finds an article already stored. If a backlog is bigger than one run's page budget (a missed run, an outage), it saves a cursor in `data/state/new.json` and resumes from there next run instead of restarting from the top, so it always eventually fully catches up rather than leaving a gap.
- **`catchup`** (`.github/workflows/scrape-catchup.yml`, `:30` hourly) — backfills history. Resumes from a cursor saved in `data/state/catchup.json` and pages further backward each run until it reaches articles older than `CUTOFF_DATE` (currently `2026-07-01`, set in `scripts/scrape.mjs`). Expected to take many runs (hours) to fully catch up.

Both are rate-limited to be polite to PTT: index/listing pages at 1 request/sec, individual article-content pages at 1 request per `ARTICLE_DELAY_MS` (currently 10s). Because of that, each run's page cap is kept small (2 pages) so a run can't run past the hourly schedule.

`manifest.json` isn't committed as part of either scrape's own diff — it's regenerated fresh (`node scripts/scrape.mjs manifest`) after rebasing onto latest `main`, right before the final push, since it changes on nearly every run and would otherwise be a frequent merge-conflict source between the two workflows.

After either workflow commits new data, `deploy.yml`'s `workflow_run` trigger rebuilds and redeploys the site (a `GITHUB_TOKEN`-authored commit doesn't cascade into other push-triggered workflows on its own, hence the explicit trigger).

## Search UI

`src/search.ts` does the actual matching, `src/main.ts` wires it to the DOM:

- **Full-text search** (`searchArticles`) matches whitespace-separated query terms against title *and* body content (not just title), all terms required (AND), case-insensitive. Results carry a `matchedIn: 'title' | 'content'` badge and a snippet centered on the first matched term.
- **Category slider toggle** (全部/賣/徵/估價, rendered from `CATEGORIES` in `search.ts`) filters by a category parsed from the title only (`articleCategory`), never from content — real titles are messy (full-width brackets `［...］`, stray leading punctuation like `：`), so the detection regex looks for a bracket immediately followed by the category word anywhere near the start rather than anchoring to the first character.
- With a category selected but no query typed, results fall back to a plain chronological browse of that category (`buildPlainSnippet`) rather than showing nothing.
- Everything runs against the full in-memory dataset after `loadArticles()` merges and sorts it — there's no incremental/streamed search, just one linear pass per keystroke.

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
