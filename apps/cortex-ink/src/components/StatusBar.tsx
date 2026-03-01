import React from 'react'
import { Box, Text } from 'ink'
import type { StatsRow } from '../db.js'

interface Props {
  stats: StatsRow | null
  lastRefresh: Date
  width: number
}

export function StatusBar({ stats, lastRefresh, width }: Props) {
  const time = lastRefresh.toLocaleTimeString()
  const counts = stats
    ? `mem:${stats.memories} nodes:${stats.nodes} edges:${stats.edges} sig:${stats.signals} news:${stats.news}`
    : 'loading...'

  return (
    <Box
      height={3}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      width={width}
    >
      <Text dimColor>
        {`${time} | ${counts} | q:quit r:refresh Tab:focus j/k:scroll`}
      </Text>
    </Box>
  )
}
