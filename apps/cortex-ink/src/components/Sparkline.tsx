import React from 'react'
import { Box, Text } from 'ink'

const SPARK_CHARS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588'

function renderSparkline(data: number[], width: number): string {
  if (data.length === 0) return ''

  // Downsample to fit width
  const step = Math.max(1, Math.floor(data.length / width))
  const sampled: number[] = []
  for (let i = 0; i < data.length; i += step) {
    sampled.push(data[i])
  }

  const min = Math.min(...sampled)
  const max = Math.max(...sampled)
  const range = max - min || 1

  return sampled
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1))
      return SPARK_CHARS[idx]
    })
    .join('')
}

interface Props {
  sparklines: Map<string, number[]>
  height: number
  width: number
}

export function SparklinePanel({ sparklines, height, width }: Props) {
  const entries = [...sparklines.entries()]
  const sparkWidth = Math.max(10, width - 12)

  return (
    <Box
      flexDirection="column"
      height={height}
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">  Price History (24h)</Text>
      {entries.slice(0, height - 3).map(([symbol, data]) => (
        <Box key={symbol}>
          <Text bold>{('  ' + symbol).padEnd(8)}</Text>
          <Text color="greenBright">{renderSparkline(data, sparkWidth)}</Text>
        </Box>
      ))}
    </Box>
  )
}
