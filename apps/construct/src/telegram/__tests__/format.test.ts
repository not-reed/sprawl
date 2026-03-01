import { describe, it, expect } from 'vitest'
import { escapeHtml, markdownToTelegramHtml } from '../format.js'

describe('escapeHtml', () => {
  it('escapes & < >', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  it('handles multiple occurrences', () => {
    expect(escapeHtml('<<>>')).toBe('&lt;&lt;&gt;&gt;')
  })

  it('passes through text without special chars', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })
})

describe('markdownToTelegramHtml', () => {
  // --- Bold ---

  it('converts **bold**', () => {
    expect(markdownToTelegramHtml('hello **world**')).toBe('hello <b>world</b>')
  })

  // --- Italic ---

  it('converts *italic*', () => {
    expect(markdownToTelegramHtml('hello *world*')).toBe('hello <i>world</i>')
  })

  // --- Bold-italic ---

  it('converts ***bold-italic***', () => {
    expect(markdownToTelegramHtml('***wow***')).toBe('<b><i>wow</i></b>')
  })

  // --- Headers ---

  it('converts # headers to bold', () => {
    expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>')
    expect(markdownToTelegramHtml('## Subtitle')).toBe('<b>Subtitle</b>')
    expect(markdownToTelegramHtml('### Deep')).toBe('<b>Deep</b>')
  })

  it('strips ** inside headers', () => {
    expect(markdownToTelegramHtml('## **Bold header**')).toBe('<b>Bold header</b>')
  })

  // --- Bullet points ---

  it('converts * bullets to •', () => {
    expect(markdownToTelegramHtml('* item one\n* item two')).toBe(
      '• item one\n• item two',
    )
  })

  it('converts - bullets to •', () => {
    expect(markdownToTelegramHtml('- first\n- second')).toBe(
      '• first\n• second',
    )
  })

  // --- Code blocks ---

  it('protects fenced code blocks from formatting', () => {
    const input = '```js\nconst x = **bold**;\n```'
    const result = markdownToTelegramHtml(input)
    // Code should be in <pre>, not have <b> tags
    expect(result).toContain('<pre>')
    expect(result).not.toContain('<b>')
    expect(result).toContain('const x = **bold**;')
  })

  it('escapes HTML inside code blocks', () => {
    const input = '```\n<script>alert("xss")</script>\n```'
    const result = markdownToTelegramHtml(input)
    expect(result).toContain('&lt;script&gt;')
    expect(result).not.toContain('<script>')
  })

  it('handles code blocks with language specifier', () => {
    const input = '```typescript\nconst x: number = 1;\n```'
    const result = markdownToTelegramHtml(input)
    expect(result).toContain('<pre>')
    expect(result).toContain('const x: number = 1;')
  })

  // --- Inline code ---

  it('converts `inline code`', () => {
    expect(markdownToTelegramHtml('run `npm test` now')).toBe(
      'run <code>npm test</code> now',
    )
  })

  it('escapes HTML inside inline code', () => {
    const result = markdownToTelegramHtml('use `<div>` element')
    expect(result).toContain('<code>&lt;div&gt;</code>')
  })

  it('protects inline code from bold/italic processing', () => {
    const result = markdownToTelegramHtml('run `**not bold**`')
    expect(result).toContain('<code>**not bold**</code>')
    expect(result).not.toContain('<b>')
  })

  // --- HTML escaping in body text ---

  it('escapes HTML entities in regular text', () => {
    const result = markdownToTelegramHtml('a < b & c > d')
    expect(result).toBe('a &lt; b &amp; c &gt; d')
  })

  // --- Mixed formatting ---

  it('handles mixed formatting in one message', () => {
    const input = [
      '# Status Update',
      '',
      '**Build**: passing',
      '* deployed to *staging*',
      '* run `npm test`',
    ].join('\n')

    const result = markdownToTelegramHtml(input)
    expect(result).toContain('<b>Status Update</b>')
    expect(result).toContain('<b>Build</b>')
    expect(result).toContain('• deployed to <i>staging</i>')
    expect(result).toContain('<code>npm test</code>')
  })

  // --- Edge cases ---

  it('passes through plain text unchanged', () => {
    expect(markdownToTelegramHtml('hello world')).toBe('hello world')
  })

  it('handles empty string', () => {
    expect(markdownToTelegramHtml('')).toBe('')
  })

  it('does not treat mid-word asterisks as italic', () => {
    // file_path*extension should NOT become italic
    const result = markdownToTelegramHtml('file*name')
    expect(result).not.toContain('<i>')
  })

  it('handles multiple code blocks', () => {
    const input = '```\nfirst\n```\ntext\n```\nsecond\n```'
    const result = markdownToTelegramHtml(input)
    expect(result).toContain('<pre>first</pre>')
    expect(result).toContain('<pre>second</pre>')
    expect(result).toContain('text')
  })
})
