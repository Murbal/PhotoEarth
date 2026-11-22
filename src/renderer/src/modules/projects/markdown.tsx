import { Fragment, type ReactNode } from 'react'

/**
 * Lightweight, XSS-safe Markdown renderer producing pure React elements (never dangerouslySetInnerHTML).
 * Supports headings (#..###), bullet lists, task checklists (- [ ] / - [x]), bold (**), italic (*),
 * inline code (`), and http(s) links opened safely via Electron's openExternal.
 */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(
        <code key={key++} className="md-code">
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    } else if (match[2] && match[3]) {
      const url = match[3]
      nodes.push(
        <button
          key={key++}
          type="button"
          className="link-btn md-link"
          onClick={() => void window.photoearth.openExternal(url)}
        >
          {match[2]}
        </button>
      )
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function MarkdownPreview({
  body,
  onToggleCheckbox
}: {
  body: string
  onToggleCheckbox?: (lineIndex: number, checked: boolean) => void
}) {
  if (!body.trim()) {
    return <div className="muted small">Empty note. Switch to Edit to start writing.</div>
  }
  const lines = body.split(/\r?\n/)
  const blocks: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const content = renderInline(heading[2])
      if (level === 1) blocks.push(<h1 key={i} className="md-h1">{content}</h1>)
      else if (level === 2) blocks.push(<h2 key={i} className="md-h2">{content}</h2>)
      else blocks.push(<h3 key={i} className="md-h3">{content}</h3>)
      i++
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const listItems: ReactNode[] = []
      const listKey = i
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const currentLine = lines[i]
        const lineIndex = i
        const task = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/.exec(currentLine)
        if (task) {
          const checked = task[1].toLowerCase() === 'x'
          listItems.push(
            <li key={lineIndex} className="md-task">
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!onToggleCheckbox}
                  onChange={(e) => onToggleCheckbox?.(lineIndex, e.target.checked)}
                />
                <span className={checked ? 'md-done' : undefined}>{renderInline(task[2])}</span>
              </label>
            </li>
          )
        } else {
          const itemText = currentLine.replace(/^\s*[-*]\s+/, '')
          listItems.push(<li key={lineIndex}>{renderInline(itemText)}</li>)
        }
        i++
      }
      blocks.push(
        <ul key={listKey} className="md-list">
          {listItems}
        </ul>
      )
      continue
    }
    const paraLines: string[] = []
    const paraKey = i
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push(
      <p key={paraKey} className="md-p">
        {paraLines.map((pl, idx) => (
          <Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInline(pl)}
          </Fragment>
        ))}
      </p>
    )
  }
  return <div className="md-preview">{blocks}</div>
}

/** Toggles a markdown task checkbox `- [ ]` / `- [x]` on the given 0-based line index. */
export function toggleMarkdownCheckbox(body: string, lineIndex: number, checked: boolean): string {
  const lines = body.split(/\r?\n/)
  const line = lines[lineIndex]
  if (line === undefined) return body
  lines[lineIndex] = line.replace(/^(\s*[-*]\s+\[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`)
  return lines.join('\n')
}
