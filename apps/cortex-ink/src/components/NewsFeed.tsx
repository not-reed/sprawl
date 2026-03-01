import React from 'react'
import { Box, Text } from 'ink'
import type { NewsRow } from '../db.js'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

interface Props {
  news: NewsRow[]
  height: number
  focused: boolean
  scrollOffset: number
}

export function NewsFeed({ news, height, focused, scrollOffset }: Props) {
  const borderColor = focused ? 'yellow' : 'gray'
  const visibleCount = height - 3
  const visible = news.slice(scrollOffset, scrollOffset + visibleCount)

  return (
    <Box
      flexDirection="column"
      height={height}
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
    >
      <Text bold color="yellow">  News Feed</Text>
      {visible.map((item, i) => {
        const tokens = item.tokens_mentioned
          ? JSON.parse(item.tokens_mentioned).join(',')
          : ''
        const linked = item.memory_id ? '\u25CF' : ' '
        const src = item.source.replace('rss:', '').replace('cryptocompare:', '')
        return (
          <Box key={i}>
            <Text dimColor>{timeAgo(item.published_at).padStart(4)} </Text>
            <Text color="blue">{linked} </Text>
            <Text>{item.title.slice(0, 60)}</Text>
            {tokens && <Text color="cyan">{` [${tokens}]`}</Text>}
            <Text dimColor>{` (${src})`}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
