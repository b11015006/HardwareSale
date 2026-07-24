import './style.css'
import type { Article, Manifest } from './types.ts'
import {
  CATEGORIES,
  buildPlainSnippet,
  escapeHtml,
  filterByCategory,
  searchArticles,
  type Category,
} from './search.ts'

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

<div class="category-toggle" id="categoryToggle" role="radiogroup" aria-label="文章分類">
  <div class="toggle-thumb"></div>
  ${CATEGORIES.map(
    ({ value, label }, i) => `
    <label>
      <input type="radio" name="category" value="${value}" ${i === 0 ? 'checked' : ''} />
      <span>${label}</span>
    </label>
  `,
  ).join('')}
</div>

<div class="search-box">
  <input id="query" type="search" placeholder="輸入關鍵字，例如：RTX 4060 面交" autofocus />
</div>

<p id="status" class="status"></p>
<ul id="results" class="results"></ul>
`

const input = document.querySelector<HTMLInputElement>('#query')!
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!
const resultsEl = document.querySelector<HTMLUListElement>('#results')!
const categoryToggle = document.querySelector<HTMLDivElement>('#categoryToggle')!
const categoryThumb = categoryToggle.querySelector<HTMLDivElement>('.toggle-thumb')!
const categoryInputs = categoryToggle.querySelectorAll<HTMLInputElement>('input[name="category"]')

// Measures the checked label's actual pixel position/width rather than
// using a percentage-based transform, which drifts: translateX(N * 100%)
// moves by N times the thumb's *own* width, not N times a track quarter,
// so any padding/rounding difference compounds further right.
function positionThumb(radio: HTMLInputElement) {
  const label = radio.closest('label')!
  const containerRect = categoryToggle.getBoundingClientRect()
  const labelRect = label.getBoundingClientRect()
  categoryThumb.style.left = `${labelRect.left - containerRect.left}px`
  categoryThumb.style.width = `${labelRect.width}px`
}

function checkedCategoryInput(): HTMLInputElement {
  return Array.from(categoryInputs).find((r) => r.checked) ?? categoryInputs[0]!
}

positionThumb(checkedCategoryInput())
window.addEventListener('resize', () => positionThumb(checkedCategoryInput()))

function renderCard(article: Article, snippetHtml: string, badgeLabel: string | null): string {
  return `
    <li>
      <a class="result-card" href="${article.url}" target="_blank" rel="noreferrer">
        <span class="result-title">${escapeHtml(article.title)}</span>
        <div class="result-meta">
          ${badgeLabel ? `<span class="badge">${badgeLabel}</span>` : ''}
          <span>${escapeHtml(article.author)}</span>
          <span>${escapeHtml(article.postedAt)}</span>
        </div>
        <p class="result-snippet">${snippetHtml}</p>
      </a>
    </li>
  `
}

function renderResults(articles: Article[], query: string, category: Category) {
  const inCategory = filterByCategory(articles, category)
  const categoryLabel = CATEGORIES.find((c) => c.value === category)!.label

  if (query.trim() === '') {
    statusEl.textContent =
      category === 'all'
        ? `目前共 ${inCategory.length} 篇文章，輸入關鍵字開始搜尋。`
        : `分類「${categoryLabel}」共 ${inCategory.length} 篇文章，輸入關鍵字開始搜尋。`
    resultsEl.innerHTML = inCategory
      .map((article) => renderCard(article, buildPlainSnippet(article.content), null))
      .join('')
    return
  }

  const results = searchArticles(inCategory, query)
  statusEl.textContent =
    category === 'all'
      ? `找到 ${results.length} 篇符合「${query}」的文章`
      : `分類「${categoryLabel}」中找到 ${results.length} 篇符合「${query}」的文章`

  resultsEl.innerHTML = results
    .map(({ article, snippet, matchedIn }) =>
      renderCard(article, snippet, matchedIn === 'title' ? '標題相符' : '內文相符'),
    )
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

  let category: Category = 'all'
  const rerender = () => renderResults(articles, input.value, category)

  rerender()
  input.addEventListener('input', rerender)
  categoryInputs.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return
      category = radio.value as Category
      positionThumb(radio)
      rerender()
    })
  })
}

main()
