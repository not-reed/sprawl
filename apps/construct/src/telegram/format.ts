// --- Markdown → Telegram HTML conversion ---

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function markdownToTelegramHtml(md: string): string {
  // Protect code blocks and inline code from processing
  const codeBlocks: string[] = []
  let text = md.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code.trimEnd())
    return `\x00CB${codeBlocks.length - 1}\x00`
  })
  const inlineCodes: string[] = []
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code)
    return `\x00IC${inlineCodes.length - 1}\x00`
  })

  // Escape HTML entities in remaining text
  text = escapeHtml(text)

  // Headers → bold (strip any ** inside since the whole line is bold)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, content) =>
    `<b>${content.replace(/\*\*/g, '')}</b>`,
  )

  // Bold-italic (***text***)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>')
  // Bold (**text**)
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  // Italic (*text*) — but not bullet-point asterisks followed by whitespace
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<i>$1</i>')

  // Bullet points (* or - at line start)
  text = text.replace(/^\*\s+/gm, '• ')
  text = text.replace(/^-\s+/gm, '• ')

  // Restore code blocks and inline code
  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) =>
    `<pre>${escapeHtml(codeBlocks[parseInt(i)])}</pre>`,
  )
  text = text.replace(/\x00IC(\d+)\x00/g, (_, i) =>
    `<code>${escapeHtml(inlineCodes[parseInt(i)])}</code>`,
  )

  return text
}
