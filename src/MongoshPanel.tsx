import { useEffect, useRef, useState } from 'react'

type Props = {
  db: string | null
  onClose?: () => void
}

type HistoryItem = {
  id: string
  script: string
  ok: boolean
  stdout: string
  stderr: string
  at: string
}

const EXAMPLES = [
  'db.getName()',
  'db.stats()',
  'show collections',
  'db.getCollectionNames()',
  'db.activityfeeds.find().limit(3).toArray()',
]

export function MongoshPanel({ db, onClose }: Props) {
  const [script, setScript] = useState(
    db ? `db.getName()\ndb.getCollectionNames()` : 'db.adminCommand({ ping: 1 })',
  )
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const outputRef = useRef<HTMLDivElement | null>(null)
  const scriptHistoryRef = useRef<string[]>([])

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [history, running])

  const run = async () => {
    const code = script.trim()
    if (!code || running) return

    setRunning(true)
    scriptHistoryRef.current = [
      code,
      ...scriptHistoryRef.current.filter((item) => item !== code),
    ].slice(0, 50)
    setHistoryIndex(-1)

    try {
      const res = await fetch('/api/mongosh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: code, db }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        stdout?: string
        stderr?: string
        error?: string
      }
      setHistory((prev) => [
        ...prev,
        {
          id: `${Date.now()}`,
          script: code,
          ok: Boolean(data.ok),
          stdout: data.stdout || '',
          stderr: data.stderr || data.error || '',
          at: new Date().toLocaleTimeString(),
        },
      ])
    } catch (err) {
      setHistory((prev) => [
        ...prev,
        {
          id: `${Date.now()}`,
          script: code,
          ok: false,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          at: new Date().toLocaleTimeString(),
        },
      ])
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="shell-panel">
      <div className="shell-toolbar">
        <div>
          <h2>mongosh</h2>
          <p>
            连接上下文：{db ? `${db}` : '（未选库，可用 use("库名")）'} · Ctrl+Enter
            运行
          </p>
        </div>
        <div className="shell-toolbar-actions">
          <button
            className="btn btn-light"
            type="button"
            onClick={() => setHistory([])}
            disabled={running || history.length === 0}
          >
            清空输出
          </button>
          {onClose && (
            <button className="btn btn-light" type="button" onClick={onClose}>
              返回浏览
            </button>
          )}
          <button
            className="btn btn-primary"
            type="button"
            disabled={running || !script.trim()}
            onClick={() => void run()}
          >
            {running ? '运行中…' : '运行'}
          </button>
        </div>
      </div>

      <div className="shell-examples">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            className="shell-example"
            onClick={() => setScript(ex)}
          >
            {ex}
          </button>
        ))}
      </div>

      <textarea
        className="shell-input"
        value={script}
        spellCheck={false}
        disabled={running}
        placeholder={'输入 mongosh 命令，例如：\ndb.stats()\ndb.myColl.find().limit(5).toArray()'}
        onChange={(e) => setScript(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            void run()
            return
          }
          if (e.key === 'ArrowUp' && e.altKey) {
            e.preventDefault()
            const list = scriptHistoryRef.current
            if (!list.length) return
            const next = Math.min(historyIndex + 1, list.length - 1)
            setHistoryIndex(next)
            setScript(list[next] || '')
          }
          if (e.key === 'ArrowDown' && e.altKey) {
            e.preventDefault()
            const list = scriptHistoryRef.current
            const next = historyIndex - 1
            if (next < 0) {
              setHistoryIndex(-1)
              return
            }
            setHistoryIndex(next)
            setScript(list[next] || '')
          }
        }}
      />

      <div className="shell-output" ref={outputRef}>
        {history.length === 0 && !running && (
          <div className="shell-empty">
            运行结果会显示在这里。游标查询建议加 <code>.toArray()</code> 或{' '}
            <code>.limit(n)</code>；也可用 <code>use(&quot;库名&quot;)</code> 切换库。
          </div>
        )}
        {history.map((item) => (
          <article
            key={item.id}
            className={`shell-block ${item.ok ? 'ok' : 'err'}`}
          >
            <header>
              <span>{item.at}</span>
              <span>{item.ok ? 'ok' : 'error'}</span>
            </header>
            <pre className="shell-cmd">{item.script}</pre>
            {item.stdout && <pre className="shell-stdout">{item.stdout}</pre>}
            {item.stderr && <pre className="shell-stderr">{item.stderr}</pre>}
          </article>
        ))}
        {running && <div className="shell-running">mongosh 执行中…</div>}
      </div>
    </div>
  )
}
