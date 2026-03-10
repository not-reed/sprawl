import { useState, useRef, useEffect } from "react";

interface SearchBarProps {
  onSearch: (query: string, mode: string) => void;
  placeholder?: string;
  showMode?: boolean;
  className?: string;
}

export function SearchBar({
  onSearch,
  placeholder = "Search...",
  showMode = true,
  className,
}: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("auto");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearch(query, mode);
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, mode, onSearch]);

  return (
    <div className={`search-bar ${className ?? ""}`}>
      <input
        className="search-input"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
      />
      {showMode && (
        <select className="search-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="auto">Auto</option>
          <option value="fts">FTS5</option>
          <option value="embedding">Embedding</option>
          <option value="keyword">Keyword</option>
        </select>
      )}
    </div>
  );
}
