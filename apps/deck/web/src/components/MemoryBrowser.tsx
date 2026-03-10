import { SearchBar } from "./SearchBar";
import { MemoryCard } from "./MemoryCard";
import { useSearch } from "../hooks/useSearch";
import { useApi } from "../hooks/useApi";
import { api } from "../lib/api";

export function MemoryBrowser() {
  const { results, loading, hasSearched, search } = useSearch();
  const { data: recent } = useApi(() => api.recentMemories(20), []);

  const displayMemories = hasSearched ? results : (recent?.results ?? []);

  return (
    <div className="page">
      <SearchBar onSearch={search} placeholder="Search memories..." />
      {loading && <div className="loading">Searching...</div>}
      {!loading && hasSearched && results.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No results</div>
          <div>Try a different query or search mode</div>
        </div>
      )}
      {!loading && !hasSearched && displayMemories.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No memories yet</div>
        </div>
      )}
      <div className="memory-list">
        {!loading && displayMemories.map((m) => <MemoryCard key={m.id} memory={m} />)}
      </div>
    </div>
  );
}
