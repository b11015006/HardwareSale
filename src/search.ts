import type { Article } from './types.ts'

export interface SearchResult {
  article: Article
  snippet: string
  matchedIn: 'title' | 'content'
}

export type Category = 'all' | 'sell' | 'want' | 'estimate'

export const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'sell', label: '賣' },
  { value: 'want', label: '徵' },
  { value: 'estimate', label: '估價' },
]

// Titles are supposed to start with a bracketed category tag, e.g.
// "[賣/台北/面交] ..." or "[估價] ...", but real posts are messy: some use
// full-width brackets ("［徵/雙北/皆可］..."), some have stray punctuation
// before the bracket ("：[徵/桃園/皆可] ..."). Look for a bracket
// immediately followed by the category word anywhere near the start,
// rather than anchoring strictly to the first character.
const CATEGORY_PATTERN = /[[［]\s*(賣|徵|估價)/

export function articleCategory(title: string): Category | null {
  const m = title.match(CATEGORY_PATTERN)
  if (!m) return null
  if (m[1] === '賣') return 'sell'
  if (m[1] === '徵') return 'want'
  return 'estimate'
}

// Category filtering only ever looks at the title, never article content.
export function filterByCategory(articles: Article[], category: Category): Article[] {
  if (category === 'all') return articles
  return articles.filter((a) => articleCategory(a.title) === category)
}

const SNIPPET_RADIUS = 60

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlight(text: string, terms: string[]): string {
  if (terms.length === 0) return escapeHtml(text)
  const pattern = new RegExp(`(${terms.map((t) => escapeRegExp(escapeHtml(t))).join('|')})`, 'gi')
  return escapeHtml(text).replace(pattern, '<mark>$1</mark>')
}

// Builds a snippet of body text centered on the first matched term.
function buildContentSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase()
  let matchIndex = -1
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase())
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) matchIndex = idx
  }
  if (matchIndex === -1) {
    return highlight(content.slice(0, SNIPPET_RADIUS * 2).trim(), terms)
  }
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS)
  const end = Math.min(content.length, matchIndex + SNIPPET_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return prefix + highlight(content.slice(start, end).trim(), terms) + suffix
}

const PLAIN_SNIPPET_LENGTH = 120

// Used when browsing by category with no search query yet: just a plain
// preview of the body, no term highlighting.
export function buildPlainSnippet(content: string): string {
  const trimmed = content.trim()
  const truncated = trimmed.length > PLAIN_SNIPPET_LENGTH
  return escapeHtml(trimmed.slice(0, PLAIN_SNIPPET_LENGTH)) + (truncated ? '…' : '')
}

export function tokenize(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

// Full-text search across title AND body content (not just the title).
// All whitespace-separated terms must match (somewhere in title+content) for a hit.
export function searchArticles(articles: Article[], query: string): SearchResult[] {
  const terms = tokenize(query)
  if (terms.length === 0) return []

  const results: SearchResult[] = []
  for (const article of articles) {
    const haystack = `${article.title}\n${article.content}`.toLowerCase()
    const allMatch = terms.every((term) => haystack.includes(term.toLowerCase()))
    if (!allMatch) continue

    const titleLower = article.title.toLowerCase()
    const matchedInTitle = terms.some((term) => titleLower.includes(term.toLowerCase()))
    const matchedIn = matchedInTitle ? 'title' : 'content'
    const snippet = buildContentSnippet(article.content, terms)
    results.push({ article, snippet, matchedIn })
  }
  return results
}

export { escapeHtml, highlight }
