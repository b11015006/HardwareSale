export interface Article {
  id: string
  title: string
  author: string
  postedAt: string
  url: string
  content: string
}

export interface ArticlesPayload {
  scrapedAt: string
  count: number
  articles: Article[]
}
