import { useState, useCallback } from 'react'
import type { Memory } from '../lib/types'
import { api } from '../lib/api'

export function useSearch() {
  const [results, setResults] = useState<Memory[]>([])
  const [loading, setLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const search = useCallback(async (query: string, mode: string) => {
    if (!query.trim()) {
      setResults([])
      setHasSearched(false)
      return
    }
    setLoading(true)
    setHasSearched(true)
    try {
      const res = await api.searchMemories(query, mode)
      setResults(res.results)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  return { results, loading, hasSearched, search }
}
