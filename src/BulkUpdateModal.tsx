import { useEffect, useMemo, useState } from 'react'

type UpdateRow = { id: string; key: string; value: string }

function newRow(key = '', value = ''): UpdateRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    key,
    value,
  }
}

function parseValue(raw: string): unknown {
  const t = raw.trim()
  if (t === '') return ''
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t)
  if (
    (t.startsWith('{') && t.endsWith('}')) ||
    (t.startsWith('[') && t.endsWith(']'))
  ) {
    try {
      return JSON.parse(t) as unknown
    } catch {
      return raw
    }
  }
  return raw
}

type Props = {
  db: string
  coll: string
  filterJson: string
  matchCount: number | null
  counting: boolean
  saving: boolean
  onClose: () => void
  onSave: (payload: {
    update: Record<string, unknown>
    allowEmptyFilter: boolean
  }) => void
}

export function BulkUpdateModal({
  db,
  coll,
  filterJson,
  matchCount,
  counting,
  saving,
  onClose,
  onSave,
}: Props) {
  const [rows, setRows] = useState<UpdateRow[]>([newRow()])
  const [advanced, setAdvanced] = useState(false)
  const [advancedText, setAdvancedText] = useState(
    '{\n  "$set": {\n    "field": "value"\n  }\n}',
  )
  const [allowEmpty, setAllowEmpty] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const filterEmpty = !filterJson.trim() || filterJson.trim() === '{}'
  const filterPreview = useMemo(() => {
    if (filterEmpty) return '{ }（空条件 = 整个集合）'
    try {
      return JSON.stringify(JSON.parse(filterJson), null, 2)
    } catch {
      return filterJson
    }
  }, [filterJson, filterEmpty])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const updateRow = (id: string, patch: Partial<Pick<UpdateRow, 'key' | 'value'>>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const submit = () => {
    setLocalError(null)
    if (filterEmpty && !allowEmpty) {
      setLocalError('条件为空会修改整个集合，请勾选确认')
      return
    }

    if (advanced) {
      try {
        const parsed = JSON.parse(advancedText) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setLocalError('更新内容必须是 JSON 对象')
          return
        }
        onSave({
          update: parsed as Record<string, unknown>,
          allowEmptyFilter: allowEmpty,
        })
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : String(err))
      }
      return
    }

    const update: Record<string, unknown> = {}
    for (const row of rows) {
      const key = row.key.trim()
      if (!key) continue
      if (key === '_id') {
        setLocalError('不能批量修改 _id')
        return
      }
      update[key] = parseValue(row.value)
    }
    if (Object.keys(update).length === 0) {
      setLocalError('请至少填写一个要修改的字段')
      return
    }
    onSave({ update, allowEmptyFilter: allowEmpty })
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-card bulk-update-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-update-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h3 id="bulk-update-title">按条件批量修改</h3>
            <p className="modal-sub">
              {db}.{coll}
              {counting
                ? ' · 正在统计匹配条数…'
                : matchCount != null
                  ? ` · 将匹配 ${matchCount} 条`
                  : ''}
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

        <div className="bulk-update-body">
          <section>
            <div className="bulk-section-label">匹配条件（来自上方查询）</div>
            <pre className="bulk-filter-preview">{filterPreview}</pre>
            {filterEmpty && (
              <label className="bulk-allow-empty">
                <input
                  type="checkbox"
                  checked={allowEmpty}
                  disabled={saving}
                  onChange={(e) => setAllowEmpty(e.target.checked)}
                />
                确认修改集合内全部文档（危险）
              </label>
            )}
          </section>

          <section>
            <div className="bulk-section-head">
              <span className="bulk-section-label">要写入的字段</span>
              <label className="bulk-advanced-toggle">
                <input
                  type="checkbox"
                  checked={advanced}
                  disabled={saving}
                  onChange={(e) => setAdvanced(e.target.checked)}
                />
                高级 JSON（$set / $inc 等）
              </label>
            </div>

            {!advanced ? (
              <div className="query-rows">
                {rows.map((row, index) => (
                  <div className="query-row" key={row.id}>
                    <span className="query-row-index">{index + 1}</span>
                    <input
                      className="query-key"
                      value={row.key}
                      disabled={saving}
                      onChange={(e) => updateRow(row.id, { key: e.target.value })}
                      spellCheck={false}
                      placeholder="字段，如 reviewStatus"
                    />
                    <span className="query-eq">=</span>
                    <input
                      className="query-value"
                      value={row.value}
                      disabled={saving}
                      onChange={(e) => updateRow(row.id, { value: e.target.value })}
                      spellCheck={false}
                      placeholder="新值"
                    />
                    <button
                      className="btn btn-ghost-light"
                      type="button"
                      disabled={saving || rows.length <= 1}
                      onClick={() =>
                        setRows((prev) =>
                          prev.length <= 1
                            ? prev
                            : prev.filter((item) => item.id !== row.id),
                        )
                      }
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button
                  className="btn btn-light"
                  type="button"
                  disabled={saving}
                  onClick={() => setRows((prev) => [...prev, newRow()])}
                >
                  添加字段
                </button>
              </div>
            ) : (
              <textarea
                className="doc-edit-textarea bulk-advanced-textarea"
                value={advancedText}
                disabled={saving}
                spellCheck={false}
                onChange={(e) => setAdvancedText(e.target.value)}
              />
            )}
            <p className="bulk-hint">
              普通模式会写成 <code>$set</code>。布尔/数字/JSON
              会自动识别；字符串直接填即可。
            </p>
          </section>

          {localError && <div className="modal-error">{localError}</div>}
        </div>

        <footer className="modal-foot">
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
            disabled={saving || counting || (matchCount === 0 && !filterEmpty)}
            onClick={submit}
          >
            {saving
              ? '修改中…'
              : matchCount != null
                ? `修改匹配的 ${matchCount} 条`
                : '执行修改'}
          </button>
        </footer>
      </div>
    </div>
  )
}
