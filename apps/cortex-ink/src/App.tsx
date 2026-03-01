import React, { useState, useEffect, useCallback } from 'react'
import { Box, useApp, useInput } from 'ink'
import { useScreenSize } from 'fullscreen-ink'
import type { CortexDb, PriceRow, NewsRow, SignalRow, GraphRow, StatsRow } from './db.js'
import { PriceTable } from './components/PriceTable.js'
import { SparklinePanel } from './components/Sparkline.js'
import { NewsFeed } from './components/NewsFeed.js'
import { Signals } from './components/Signals.js'
import { GraphView } from './components/GraphView.js'
import { StatusBar } from './components/StatusBar.js'

const PANELS = ['prices', 'news', 'signals', 'graph'] as const
type Panel = (typeof PANELS)[number]

interface AppProps {
  db: CortexDb
}

export function App({ db }: AppProps) {
  const { exit } = useApp()
  const { width, height } = useScreenSize()
  const [focusedPanel, setFocusedPanel] = useState<Panel>('prices')
  const [scrollOffsets, setScrollOffsets] = useState<Record<Panel, number>>({
    prices: 0, news: 0, signals: 0, graph: 0,
  })
  const [prices, setPrices] = useState<PriceRow[]>([])
  const [sparklines, setSparklines] = useState<Map<string, number[]>>(new Map())
  const [news, setNews] = useState<NewsRow[]>([])
  const [signals, setSignals] = useState<SignalRow[]>([])
  const [graph, setGraph] = useState<GraphRow[]>([])
  const [stats, setStats] = useState<StatsRow | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  const refresh = useCallback(() => {
    try {
      setPrices(db.getPrices())
      setNews(db.getNews())
      setSignals(db.getSignals())
      setGraph(db.getGraph())
      setStats(db.getStats())

      const symbols = db.getTokenSymbols()
      const sparkMap = new Map<string, number[]>()
      for (const sym of symbols) {
        const rows = db.getSparkline(sym)
        if (rows.length > 0) {
          sparkMap.set(sym, rows.map(r => r.price_usd))
        }
      }
      setSparklines(sparkMap)
      setLastRefresh(new Date())
    } catch {
      // DB might be locked briefly, skip this cycle
    }
  }, [db])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [refresh])

  useInput((input, key) => {
    if (input === 'q') exit()
    if (input === 'r') refresh()
    if (key.tab) {
      const idx = PANELS.indexOf(focusedPanel)
      setFocusedPanel(PANELS[(idx + 1) % PANELS.length])
    }
    if (input === 'j' || key.downArrow) {
      setScrollOffsets(prev => ({
        ...prev,
        [focusedPanel]: prev[focusedPanel] + 1,
      }))
    }
    if (input === 'k' || key.upArrow) {
      setScrollOffsets(prev => ({
        ...prev,
        [focusedPanel]: Math.max(0, prev[focusedPanel] - 1),
      }))
    }
  })

  const leftWidth = Math.floor(width * 0.45)
  const rightWidth = width - leftWidth - 1
  const mainHeight = height - 3 // leave room for status bar
  const priceHeight = Math.min(prices.length + 4, Math.floor(mainHeight * 0.3))
  const sparkHeight = 5
  const newsHeight = mainHeight - priceHeight - sparkHeight
  const signalHeight = Math.floor(mainHeight * 0.45)
  const graphHeight = mainHeight - signalHeight

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="row" height={mainHeight}>
        {/* Left column */}
        <Box flexDirection="column" width={leftWidth}>
          <PriceTable
            prices={prices}
            height={priceHeight}
            focused={focusedPanel === 'prices'}
          />
          <SparklinePanel
            sparklines={sparklines}
            height={sparkHeight}
            width={leftWidth}
          />
          <NewsFeed
            news={news}
            height={newsHeight}
            focused={focusedPanel === 'news'}
            scrollOffset={scrollOffsets.news}
          />
        </Box>
        {/* Right column */}
        <Box flexDirection="column" width={rightWidth} marginLeft={1}>
          <Signals
            signals={signals}
            height={signalHeight}
            focused={focusedPanel === 'signals'}
            scrollOffset={scrollOffsets.signals}
          />
          <GraphView
            edges={graph}
            height={graphHeight}
            focused={focusedPanel === 'graph'}
            scrollOffset={scrollOffsets.graph}
          />
        </Box>
      </Box>
      <StatusBar stats={stats} lastRefresh={lastRefresh} width={width} />
    </Box>
  )
}
