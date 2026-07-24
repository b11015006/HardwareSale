// Scrapes the PTT HardwareSale board and writes full article content
// (not just titles) to public/data/articles.json for client-side search.
import * as cheerio from "cheerio";
import { writeFile } from "node:fs/promises";

const BOARD_URL = "https://www.ptt.cc/bbs/HardwareSale/index.html";
const OUT_FILE = new URL("../public/data/articles.json", import.meta.url);
const TARGET_COUNT = Number(process.argv[2] ?? 10);
const HEADERS = { "User-Agent": "Mozilla/5.0", Cookie: "over18=1" };
const DELAY_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

// A board index page lists articles oldest-to-newest top-to-bottom.
// Returns valid (non-pinned, non-deleted) entries in that same order,
// plus the link to the previous (older) page for pagination.
function parseIndex(html) {
  const $ = cheerio.load(html);
  const entries = [];
  $(".r-ent").each((_, el) => {
    const a = $(el).find(".title a");
    const title = a.text().trim();
    const href = a.attr("href");
    if (!href || !title) return; // deleted article, no link/title
    if (title.startsWith("[公告]")) return; // pinned board announcement
    entries.push({ title, url: new URL(href, BOARD_URL).href });
  });
  const prevHref = $(".btn-group-paging .btn.wide")
    .filter((_, el) => $(el).text().trim() === "上頁")
    .attr("href");
  return { entries, prevUrl: prevHref ? new URL(prevHref, BOARD_URL).href : null };
}

async function collectLatestArticles(targetCount) {
  let pageUrl = BOARD_URL;
  let collected = [];
  while (pageUrl && collected.length < targetCount) {
    const html = await fetchHtml(pageUrl);
    const { entries, prevUrl } = parseIndex(html);
    // entries are oldest->newest; older pages get prepended.
    collected = [...entries, ...collected];
    pageUrl = collected.length < targetCount ? prevUrl : null;
    if (pageUrl) await sleep(DELAY_MS);
  }
  return collected.slice(-targetCount);
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

  const id = url.split("/").pop().replace(/\.html$/, "");
  return {
    id,
    title: meta["標題"] ?? "",
    author: meta["作者"] ?? "",
    postedAt: meta["時間"] ?? "",
    url,
    content,
  };
}

async function main() {
  console.log(`Collecting latest ${TARGET_COUNT} non-pinned articles...`);
  const stubs = await collectLatestArticles(TARGET_COUNT);
  console.log(`Found ${stubs.length} article links, fetching bodies...`);

  const articles = [];
  for (const { url } of stubs) {
    const html = await fetchHtml(url);
    articles.push(parseArticle(html, url));
    await sleep(DELAY_MS);
  }

  const payload = {
    scrapedAt: new Date().toISOString(),
    count: articles.length,
    articles,
  };
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${articles.length} articles to ${OUT_FILE.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
