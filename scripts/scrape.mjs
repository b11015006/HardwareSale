// Scrapes the PTT HardwareSale board and stores full article content
// (not just titles) as JSONL, one file per post date, under
// public/data/articles/YYYY-MM-DD.jsonl, for client-side search.
//
// Two modes (first CLI arg):
//   new     - incremental: walk backward from the newest page until an
//             already-stored article id is found. Meant to run hourly. If a
//             run's page cap is hit before finding that boundary (a bigger
//             backlog than one run can absorb - a missed run, an outage),
//             it resumes from a saved cursor next run instead of
//             restarting from the newest page every time, so a backlog
//             larger than one run's budget still gets fully closed over
//             a few runs rather than leaving a permanent gap.
//   catchup - backfill: resume from a saved cursor and walk further
//             backward in time until articles older than CUTOFF_DATE are
//             reached. Also meant to run hourly, picking up where the
//             previous run left off.
//
// Article-content fetches are throttled; see ARTICLE_DELAY_MS. A third
// "manifest" mode just regenerates manifest.json from whatever *.jsonl
// files currently exist on disk, without fetching anything - see the note
// on writeManifest() for why it's kept out of the scrape modes themselves.
import * as cheerio from "cheerio";
import { mkdir, readdir, readFile, writeFile, appendFile } from "node:fs/promises";

const BOARD_URL = "https://www.ptt.cc/bbs/HardwareSale/index.html";
const ARTICLES_DIR = new URL("../public/data/articles/", import.meta.url);
const MANIFEST_FILE = new URL("../public/data/manifest.json", import.meta.url);
const NEW_STATE_FILE = new URL("../data/state/new.json", import.meta.url);
const CATCHUP_STATE_FILE = new URL("../data/state/catchup.json", import.meta.url);

// Catch-up traces backward through history down to and including this date.
const CUTOFF_DATE = "2026-07-01";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
  Cookie: "over18=1",
};
// Be polite to PTT: board index (listing) pages are cheap, so those stay at
// 1/sec, but individual article-content fetches are throttled.
const INDEX_DELAY_MS = 1000;
const ARTICLE_DELAY_MS = 10_000;
const MAX_RETRIES = 4;
// Kept small because each page can add up to ~20 articles to the queue,
// and that queue is the run's time budget at ARTICLE_DELAY_MS/article —
// this keeps a single hourly run comfortably under an hour even worst case.
const MAX_PAGES_PER_ROUTINE_RUN = 2;
// Raised from 2 to 8: worst case is 8 pages * ~20 articles/page *
// ARTICLE_DELAY_MS (10s) ≈ 27 minutes, still comfortably inside the hourly
// cron slot (and well clear of the :00 scrape-new run), while closing the
// catch-up backlog roughly 4x faster per run. Per-article delay is
// unchanged - this doesn't make requests to PTT any less polite, it just
// does more of the same-paced requests before a run ends.
const MAX_PAGES_PER_CATCHUP_RUN = 8;

const MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url, delayMs) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
      const html = await res.text();
      await sleep(delayMs);
      return html;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const backoff = 500 * 2 ** (attempt - 1);
      console.warn(
        `fetch failed (attempt ${attempt}/${MAX_RETRIES}) for ${url}: ${err.message}, retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
}

function idFromUrl(url) {
  return url.split("/").pop().replace(/\.html$/, "");
}

// PTT article time format: "Fri Jul 24 17:48:33 2026". This is already the
// board's local (Taiwan) date, so extract it directly by regex rather than
// via Date parsing, which would apply the scraping machine's timezone.
function dateKeyFromPttTime(pttTime) {
  const m = pttTime.match(/^\w+\s+(\w{3})\s+(\d{1,2})\s+[\d:]+\s+(\d{4})$/);
  if (!m) return null;
  const [, mon, day, year] = m;
  const month = MONTHS[mon];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

// Fallback for articles that lost their metaline block (some users
// accidentally delete it while editing). PTT article ids embed a UTC unix
// timestamp; convert to Taiwan (UTC+8) local date for bucketing.
function dateKeyFromId(id) {
  const epoch = Number(id.split(".")[1]);
  if (!epoch) return null;
  const d = new Date((epoch + 8 * 3600) * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

// A board index page lists articles oldest-to-newest top-to-bottom.
// Returns valid (non-pinned, non-deleted) entries in that same order,
// plus the link to the previous (older) page for pagination.
function parseIndex(html, pageUrl) {
  const $ = cheerio.load(html);
  const entries = [];
  $(".r-ent").each((_, el) => {
    const a = $(el).find(".title a");
    const title = a.text().trim();
    const href = a.attr("href");
    if (!href || !title) return; // deleted article, no link/title
    if (title.startsWith("[公告]")) return; // pinned board announcement
    entries.push({ title, url: new URL(href, pageUrl).href });
  });
  const prevHref = $(".btn-group-paging .btn.wide")
    .filter((_, el) => $(el).text().includes("上頁") && !$(el).hasClass("disabled"))
    .attr("href");
  return { entries, prevUrl: prevHref ? new URL(prevHref, pageUrl).href : null };
}

function parseArticle(html, url) {
  const $ = cheerio.load(html);
  const meta = {};
  $(".article-metaline, .article-metaline-right").each((_, el) => {
    const tag = $(el).find(".article-meta-tag").text().trim();
    const value = $(el).find(".article-meta-value").text().trim();
    meta[tag] = value;
  });

  const body = $("#main-content").clone();
  body.find(".article-metaline, .article-metaline-right, .push").remove();
  const rawText = body.text();
  // Strip the trailing "※ 發信站/文章網址/編輯" signature block and the
  // "--" separator line PTT clients insert before a signature.
  const content = rawText
    .split(/\n?※ 發信站/)[0]
    .replace(/\n--\s*$/, "")
    .trim();

  const postedAt = meta["時間"] ?? "";
  const id = idFromUrl(url);
  return {
    id,
    title: meta["標題"] ?? "",
    author: meta["作者"] ?? "",
    postedAt,
    dateKey: dateKeyFromPttTime(postedAt) ?? dateKeyFromId(id) ?? "unknown",
    url,
    content,
  };
}

async function loadExistingIds() {
  await mkdir(ARTICLES_DIR, { recursive: true });
  const ids = new Set();
  const files = await readdir(ARTICLES_DIR).catch(() => []);
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const text = await readFile(new URL(file, ARTICLES_DIR), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        ids.add(JSON.parse(line).id);
      } catch {
        // skip malformed line
      }
    }
  }
  return ids;
}

async function appendArticles(articles) {
  const byDate = new Map();
  for (const article of articles) {
    if (!byDate.has(article.dateKey)) byDate.set(article.dateKey, []);
    byDate.get(article.dateKey).push(article);
  }
  for (const [date, list] of byDate) {
    const file = new URL(`${date}.jsonl`, ARTICLES_DIR);
    const lines = list.map((a) => JSON.stringify(a)).join("\n") + "\n";
    await appendFile(file, lines, "utf8");
  }
}

// Deliberately NOT called from scrapeNew()/scrapeCatchup(). manifest.json
// changes on effectively every run of either workflow (even a run that
// finds zero new articles still bumps updatedAt), and catch-up runs take
// 30-40+ minutes - long enough to almost always straddle the other
// workflow's run. Committing manifest.json as part of the scrape's own
// diff meant `git rebase origin/main` regularly hit a real conflict on it,
// which is unresolvable automatically and silently discarded that run's
// entire scrape (git rebase failure -> job failure -> nothing pushed).
// Instead each workflow regenerates it fresh, as a "manifest" mode run,
// *after* rebasing onto latest origin/main and immediately before pushing
// - see .github/workflows/scrape-*.yml.
async function writeManifest() {
  const files = (await readdir(ARTICLES_DIR).catch(() => []))
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""))
    .sort();
  await writeFile(
    MANIFEST_FILE,
    JSON.stringify({ dates: files, updatedAt: new Date().toISOString() }, null, 2),
  );
}

async function loadState(file, defaults) {
  try {
    const text = await readFile(file, "utf8");
    return { ...defaults, ...JSON.parse(text) };
  } catch {
    return defaults;
  }
}

async function saveState(file, state) {
  await mkdir(new URL(".", file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
  );
}

async function fetchArticles(entries) {
  const articles = [];
  for (const entry of entries) {
    const html = await fetchHtml(entry.url, ARTICLE_DELAY_MS);
    articles.push(parseArticle(html, entry.url));
  }
  return articles;
}

// Routine job: find articles newer than anything already stored. Walks
// backward until it finds an already-known article - fully caught up - or
// hits this run's page cap. In the latter case it saves a cursor and
// resumes from there next run rather than restarting from the newest page,
// so a backlog bigger than one run's budget still gets fully closed over
// a few runs instead of leaving a permanent gap (see the mode comment atop
// this file).
async function scrapeNew() {
  console.log("Routine scrape: looking for new articles...");
  const existingIds = await loadExistingIds();
  const state = await loadState(NEW_STATE_FILE, { nextPageUrl: null });

  let pageUrl = state.nextPageUrl ?? BOARD_URL;
  let pagesFetched = 0;
  let caughtUp = false;
  const collected = [];

  while (pageUrl && pagesFetched < MAX_PAGES_PER_ROUTINE_RUN) {
    const html = await fetchHtml(pageUrl, INDEX_DELAY_MS);
    pagesFetched++;
    const { entries, prevUrl } = parseIndex(html, pageUrl);

    let hitKnown = false;
    for (const entry of [...entries].reverse()) {
      if (existingIds.has(idFromUrl(entry.url))) {
        hitKnown = true;
        break;
      }
      collected.push(entry);
    }
    if (hitKnown || !prevUrl) {
      caughtUp = true;
      pageUrl = null;
      break;
    }
    pageUrl = prevUrl;
  }

  console.log(`Found ${collected.length} new article link(s) across ${pagesFetched} page(s).`);
  const articles = await fetchArticles(collected);
  const fresh = articles.filter((a) => !existingIds.has(a.id));
  await appendArticles(fresh);
  await saveState(NEW_STATE_FILE, { nextPageUrl: caughtUp ? null : pageUrl });

  console.log(
    `Stored ${fresh.length} new article(s). ${
      caughtUp ? "Caught up with the newest page." : `Backlog remains; will resume from ${pageUrl} next run.`
    }`,
  );
}

// Catch-up job: resume from a saved cursor and keep paging backward in
// time, storing anything not already saved, until articles older than
// CUTOFF_DATE are reached (or the board's oldest page is reached first).
async function scrapeCatchup() {
  const state = await loadState(CATCHUP_STATE_FILE, { nextPageUrl: null, done: false });
  if (state.done) {
    console.log(`Catch-up already complete (reached ${CUTOFF_DATE}).`);
    return;
  }

  let pageUrl = state.nextPageUrl;
  if (!pageUrl) {
    // First run: start just older than the newest page, since the routine
    // job keeps the newest page itself up to date.
    const html = await fetchHtml(BOARD_URL, INDEX_DELAY_MS);
    pageUrl = parseIndex(html, BOARD_URL).prevUrl;
  }

  const existingIds = await loadExistingIds();
  let pagesFetched = 0;
  let reachedCutoff = !pageUrl; // no older pages exist at all
  const collected = [];

  while (pageUrl && pagesFetched < MAX_PAGES_PER_CATCHUP_RUN) {
    const html = await fetchHtml(pageUrl, INDEX_DELAY_MS);
    pagesFetched++;
    const { entries, prevUrl } = parseIndex(html, pageUrl);
    for (const entry of entries) {
      if (!existingIds.has(idFromUrl(entry.url))) collected.push(entry);
    }
    if (!prevUrl) {
      reachedCutoff = true;
      pageUrl = null;
      break;
    }
    pageUrl = prevUrl;
  }

  console.log(`Catch-up: fetched ${pagesFetched} page(s), ${collected.length} candidate article(s).`);

  const articles = await fetchArticles(collected);
  const inRange = articles.filter((a) => a.dateKey >= CUTOFF_DATE);
  if (articles.some((a) => a.dateKey !== "unknown" && a.dateKey < CUTOFF_DATE)) {
    reachedCutoff = true;
  }

  const fresh = inRange.filter((a) => !existingIds.has(a.id));
  await appendArticles(fresh);
  await saveState(CATCHUP_STATE_FILE, { nextPageUrl: reachedCutoff ? null : pageUrl, done: reachedCutoff });

  console.log(
    `Stored ${fresh.length} article(s). ${
      reachedCutoff
        ? `Reached cutoff ${CUTOFF_DATE}, catch-up complete.`
        : `Will resume from ${pageUrl} next run.`
    }`,
  );
}

async function main() {
  const mode = process.argv[2] ?? "new";
  if (mode === "new") await scrapeNew();
  else if (mode === "catchup") await scrapeCatchup();
  else if (mode === "manifest") await writeManifest();
  else {
    console.error(`Unknown mode "${mode}". Use "new", "catchup", or "manifest".`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
