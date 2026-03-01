import React from 'react'
import { Box, Text } from 'ink'
import type { PriceRow } from '../db.js'

function formatUsd(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toPrecision(4)}`
}

function formatPct(n: number | null): string {
  if (n == null) return '   --'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

function formatVolume(n: number | null): string {
  if (n == null) return '--'
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

interface Props {
  prices: PriceRow[]
  height: number
  focused: boolean
}

export function PriceTable({ prices, height, focused }: Props) {
  const borderColor = focused ? 'cyan' : 'gray'

  return (
    <Box
      flexDirection="column"
      height={height}
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
    >
      <Text bold color="cyan">
        {'  SYMBOL    PRICE        24H      7D      VOLUME'}
      </Text>
      {prices.slice(0, height - 3).map((p) => (
        <Box key={p.symbol}>
          <Text>  </Text>
          <Text bold>{p.symbol.padEnd(8)}</Text>
          <Text>{formatUsd(p.price_usd).padStart(12)}</Text>
          <Text color={p.change_24h != null && p.change_24h >= 0 ? 'green' : 'red'}>
            {formatPct(p.change_24h).padStart(8)}
          </Text>
          <Text color={p.change_7d != null && p.change_7d >= 0 ? 'green' : 'red'}>
            {formatPct(p.change_7d).padStart(8)}
          </Text>
          <Text dimColor>{'  ' + formatVolume(p.volume_24h)}</Text>
        </Box>
      ))}
    </Box>
  )
}
