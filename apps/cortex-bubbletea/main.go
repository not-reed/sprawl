package main

import (
	"fmt"
	"os"

	tea "charm.land/bubbletea/v2"
)

func main() {
	dbPath := "./data/cortex.db"
	if len(os.Args) > 1 {
		dbPath = os.Args[1]
	} else if env := os.Getenv("DATABASE_URL"); env != "" {
		dbPath = env
	}

	db, err := OpenDB(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to open database: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	m := NewModel(db)
	p := tea.NewProgram(m)

	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
