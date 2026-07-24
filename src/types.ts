export interface Article {
  id: string
  title: string
  author: string
  postedAt: string
  dateKey: string
  url: string
  content: string
}

export interface Manifest {
  dates: string[]
  updatedAt: string
}
