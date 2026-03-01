import React from 'react'
import { Box, Text } from 'ink'
import type { GraphRow } from '../db.js'

interface Props {
  edges: GraphRow[]
  height: number
  focused: boolean
  scrollOffset: number
}

export function GraphView({ edges, height, focused, scrollOffset }: Props) {
  const borderColor = focused ? 'magenta' : 'gray'
  const visibleCount = height - 3
  const visible = edges.slice(scrollOffset, scrollOffset + visibleCount)

  return (
    <Box
      flexDirection="column"
      height={height}
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
    >
      <Text bold color="magenta">  Graph Connections</Text>
      {visible.map((edge, i) => (
        <Box key={i}>
          <Text bold color="white">{edge.source_label}</Text>
          <Text dimColor>{' \u2192 '}</Text>
          <Text color="cyan">{edge.relation}</Text>
          <Text dimColor>{' \u2192 '}</Text>
          <Text bold color="white">{edge.target_label}</Text>
          <Text dimColor>{` (${edge.weight.toFixed(1)})`}</Text>
        </Box>
      ))}
    </Box>
  )
}
