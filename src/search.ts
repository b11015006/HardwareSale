import type { Article } from './types.ts'

export interface SearchResult {
  article: Article
  snippet: string
  matchedIn: 'title' | 'content'
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
