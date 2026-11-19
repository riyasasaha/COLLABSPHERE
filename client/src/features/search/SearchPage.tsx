import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type SearchResult = {
  id: string
  type: string
  title: string
  summary: string
  updatedAt: string
  route: string
}

type SearchResultsByCategory = {
  tasks: SearchResult[]
  documents: SearchResult[]
  users: SearchResult[]
  messages: SearchResult[]
  files: SearchResult[]
}

const emptyResults: SearchResultsByCategory = {
  tasks: [],
  documents: [],
  users: [],
  messages: [],
  files: [],
}

const resultCategories = [
  { key: 'tasks', label: 'Tasks' },
  { key: 'documents', label: 'Documents' },
  { key: 'users', label: 'Users' },
  { key: 'messages', label: 'Messages' },
  { key: 'files', label: 'Files' },
] as const

export function SearchPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultsByCategory>(emptyResults)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!query.trim()) {
      setResults(emptyResults)
      setError('')
      setLoading(false)
      return
    }

    const timeout = window.setTimeout(() => {
      const runSearch = async () => {
        setLoading(true)
        setError('')

        try {
          const response = await fetch(`${apiUrl}/api/search?q=${encodeURIComponent(query)}`, { credentials: 'include' })
          if (!response.ok) throw new Error('Unable to search workspace')
          const payload = await response.json() as { results?: SearchResultsByCategory }
          setResults(payload.results ?? emptyResults)
        } catch (caughtError) {
          setError(caughtError instanceof Error ? caughtError.message : 'Search failed')
          setResults(emptyResults)
        } finally {
          setLoading(false)
        }
      }

      void runSearch()
    }, 300)

    return () => window.clearTimeout(timeout)
  }, [query])

  const hasResults = useMemo(
    () => resultCategories.some(({ key }) => results[key].length > 0),
    [results],
  )

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">GLOBAL SEARCH</p>
          <h2>Search workspace content</h2>
        </div>
      </div>

      <div className="search-box">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tasks, documents, users, messages, and files"
          aria-label="Search workspace"
        />
      </div>

      {error && <div className="error-state">{error}</div>}

      {!query.trim() ? (
        <div className="page-panel"><div className="empty-state">Type a search to find relevant workspace items.</div></div>
      ) : loading ? (
        <div className="page-panel"><div className="empty-state">Searching…</div></div>
      ) : hasResults ? (
        <div className="search-results">
          {resultCategories.map(({ key, label }) => {
            const items = results[key]
            if (items.length === 0) return null

            return (
              <section key={key} className="search-category">
                <div className="search-category-header">
                  <h3>{label}</h3>
                  <span>{items.length}</span>
                </div>

                {items.map((result) => (
                  <Link key={`${key}-${result.id}`} to={result.route} className="search-result-card">
                    <div className="search-result-header">
                      <span className="search-tag">{result.type}</span>
                      <small>{new Date(result.updatedAt).toLocaleString()}</small>
                    </div>
                    <strong>{result.title}</strong>
                    <p>{result.summary}</p>
                  </Link>
                ))}
              </section>
            )
          })}
        </div>
      ) : (
        <div className="page-panel"><div className="empty-state">No matching results for “{query}”.</div></div>
      )}
    </div>
  )
}
