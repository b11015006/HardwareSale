import './style.css'
import type { Article, Manifest } from './types.ts'
import { escapeHtml, searchArticles } from './search.ts'

const BOARD_URL = 'https://www.ptt.cc/bbs/HardwareSale/index.html'
const MANIFEST_URL = `${import.meta.env.BASE_URL}data/manifest.json`
const articleFileUrl = (date: string) => `${import.meta.env.BASE_URL}data/articles/${date}.jsonl`

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
<header>
  <h1>PTT HardwareSale 全文搜尋</h1>
  <p class="sub">
    搜尋範圍涵蓋文章「內文」，不只是標題。
    資料來源：<a href="${BOARD_URL}" target="_blank" rel="noreferrer">看板 HardwareSale</a>
  </p>
</header>

<div class="search-box">
  <input id="query" type="search" placeholder="輸入關鍵字，例如：RTX 4060 面交" autofocus />
</div>

<p id="status" class="status"></p>
<ul id="results" class="results"></ul>
`

const input = document.querySelector<HTMLInputElement>('#query')!
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!
const resultsEl = document.querySelector<HTMLUListElement>('#results')!

function renderResults(articles: Article[], query: string) {
  if (query.trim() === '') {
    resultsEl.innerHTML = ''
    statusEl.textContent = `目前共 ${articles.length} 篇文章，輸入關鍵字開始搜尋。`
    return
  }

  const results = searchArticles(articles, query)
  statusEl.textContent = `找到 ${results.length} 篇符合「${query}」的文章`

  resultsEl.innerHTML = results
    .map(({ article, snippet, matchedIn }) => {
      const matchLabel = matchedIn === 'title' ? '標題相符' : '內文相符'
      return `
        <li>
          <a class="result-card" href="${article.url}" target="_blank" rel="noreferrer">
            <span class="result-title">${escapeHtml(article.title)}</span>
            <div class="result-meta">
              <span class="badge">${matchLabel}</span>
              <span>${escapeHtml(article.author)}</span>
              <span>${escapeHtml(article.postedAt)}</span>
            </div>
            <p class="result-snippet">${snippet}</p>
          </a>
        </li>
      `
    })
    .join('')
}

function parseJsonl(text: string): Article[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Article)
}

// PTT article ids look like "M.<unix-epoch>.A.<hash>"; use the embedded
// timestamp to sort across date files without re-parsing postedAt strings.
function articleEpoch(article: Article): number {
  return Number(article.id.split('.')[1] ?? 0)
}

async function loadArticles(): Promise<Article[]> {
  const manifestRes = await fetch(MANIFEST_URL)
  if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status} loading manifest`)
  const manifest: Manifest = await manifestRes.json()

  const perDate = await Promise.all(
    manifest.dates.map(async (date) => {
      const res = await fetch(articleFileUrl(date))
      if (!res.ok) return []
      return parseJsonl(await res.text())
    }),
  )

  return perDate.flat().sort((a, b) => articleEpoch(b) - articleEpoch(a))
}

async function main() {
  statusEl.textContent = '載入文章資料中…'
  let articles: Article[]
  try {
    articles = await loadArticles()
  } catch (err) {
    statusEl.textContent = '文章資料載入失敗，請稍後再試。'
    console.error(err)
    return
  }

  renderResults(articles, '')
  input.addEventListener('input', () => renderResults(articles, input.value))
}

main()
