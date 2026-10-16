import { useEffect, useState } from 'react'

type Props = {
  docId: string
  initialDoc: Record<string, unknown>
  saving: boolean
  onClose: () => void
  onSave: (document: Record<string, unknown>) => void
}

export function DocEditModal({
  docId,
  initialDoc,
  saving,
  onClose,
  onSave,
}: Props) {
  const [text, setText] = useState(() => JSON.stringify(initialDoc, null, 2))
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    setText(JSON.stringify(initialDoc, null, 2))
    setParseError(null)
  }, [initialDoc, docId])

  const formatJson = () => {
    try {
      const parsed = JSON.parse(text) as unknown
      setText(JSON.stringify(parsed, null, 2))
      setParseError(null)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err))
    }
  }

  const submit = () => {
    try {
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setParseError('文档必须是 JSON 对象')
        return
      }
      setParseError(null)
      onSave(parsed as Record<string, unknown>)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !saving) {
        e.preventDefault()
        submit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-card doc-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-edit-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h3 id="doc-edit-title">编辑文档</h3>
            <p className="modal-sub">
              _id: {docId} · 支持扩展 JSON（$oid / $date）· Ctrl+Enter 保存
            </p>
          </div>
          <button
            className="btn btn-light"
            type="button"
            disabled={saving}
            onClick={onClose}
          >
            关闭
          </button>
        </header>

        <textarea
          className="doc-edit-textarea"
          value={text}
          spellCheck={false}
          disabled={saving}
          onChange={(e) => {
            setText(e.target.value)
            if (parseError) setParseError(null)
          }}
        />

        {parseError && <div className="modal-error">{parseError}</div>}

        <footer className="modal-foot">
          <button
            className="btn btn-light"
            type="button"
            disabled={saving}
            onClick={formatJson}
          >
            格式化
          </button>
          <div className="modal-foot-right">
            <button
              className="btn btn-light"
              type="button"
              disabled={saving}
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={saving || !text.trim()}
              onClick={submit}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
