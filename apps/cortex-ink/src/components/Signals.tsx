import React from 'react'
import { Box, Text } from 'ink'
import type { SignalRow } from '../db.js'

function signalColor(type: string): string {
  if (type === 'buy') return 'green'
  if (type === 'sell') return 'red'
  return 'yellow'
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

interface Props {
  signals: SignalRow[]
  height: number
  focused: boolean
  scrollOffset: number
}

export function Signals({ signals, height, focused, scrollOffset }: Props) {
  const borderColor = focused ? 'green' : 'gray'
  const visibleCount = height - 3
  const visible = signals.slice(scrollOffset, scrollOffset + visibleCount)

  return (
    <Box
      flexDirection="column"
      height={height}
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
    >
      <Text bold color="green">  Signals</Text>
      {visible.map((sig, i) => (
        <Box key={i} flexDirection="column">
          <Box>
            <Text dimColor>{timeAgo(sig.created_at).padStart(4)} </Text>
            <Text bold>{sig.symbol.padEnd(6)}</Text>
            <Text color={signalColor(sig.signal_type)} bold>
              {sig.signal_type.toUpperCase().padEnd(5)}
            </Text>
            <Text dimColor>
              {` ${(sig.confidence * 100).toFixed(0)}%`}
            </Text>
          </Box>
          <Text dimColor wrap="truncate">{'       ' + sig.reasoning.slice(0, 80)}</Text>
        </Box>
      ))}
    </Box>
  )
}
