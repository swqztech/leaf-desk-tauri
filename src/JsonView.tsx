import { useState, type ReactNode } from 'react'

function tokenizeJson(raw: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re =
    /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}\[\],])/g

  let last = 0
  let match: RegExpExecArray | null
  let i = 0

  while ((match = re.exec(raw)) !== null) {
    if (match.index > last) {
      nodes.push(raw.slice(last, match.index))
    }

    if (match[1] !== undefined) {
      nodes.push(
        <span key={i++} className="json-key">
          {match[1]}
        </span>,
      )
      const suffix = match[0].slice(match[1].length)
      const parts = suffix.match(/^(\s*)(:)$/)
      if (parts) {
        if (parts[1]) nodes.push(parts[1])
        nodes.push(
          <span key={i++} className="json-punct">
            :
          </span>,
        )
      } else {
        nodes.push(suffix)
      }
      last = re.lastIndex
      continue
    }

    const kind = match[2]
      ? 'string'
      : match[3]
        ? 'number'
        : match[4]
          ? 'bool'
          : match[5]
            ? 'null'
            : 'punct'
    const text = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6]

    nodes.push(
      <span key={i++} className={`json-${kind}`}>
        {text}
      </span>,
    )
    last = re.lastIndex
  }

  if (last < raw.length) {
    nodes.push(raw.slice(last))
  }

  return nodes
}

export function JsonView({
  value,
  defaultExpanded = false,
}: {
  value: unknown
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const raw = expanded
    ? (JSON.stringify(value, null, 2) ?? 'null')
    : (JSON.stringify(value) ?? 'null')
        .replace(/":/g, '": ')
        .replace(/,"/g, ', "')
        .replace(/,{/g, ', {')
        .replace(/,\[/g, ', [')

  return (
    <div className={`json-view ${expanded ? 'expanded' : 'compact'}`}>
      <button
        type="button"
        className="json-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '收起' : '展开'}
      </button>
      <pre className="doc-body">{tokenizeJson(raw)}</pre>
    </div>
  )
}
