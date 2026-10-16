import { useCallback, useEffect, useState } from 'react'
import { api, formatBytes, type ImportHistoryItem } from './api'
import { useDialog } from './dialogs'
import { toast } from './toast'

type Props = {
  open: boolean
  onClose: () => void
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleString()
}

export function ImportHistoryModal({ open, onClose }: Props) {
  const dialog = useDialog()
  const [items, setItems] = useState<ImportHistoryItem[]>([])
  const [importsDir, setImportsDir] = useState('')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.listImportHistory()
      setItems(res.items)
      setImportsDir(res.importsDir)
    } catch (err) {
      toast.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  if (!open) return null

  async function removeOne(item: ImportHistoryItem) {
    const ok = await dialog.confirm({
      title: '删除导入记录',
      message: `删除「${item.sourceFileName}」的记录？\n\n将同时删除归档文件（若仍存在）。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteImportHistory(item.id, true)
      toast.success('已删除')
      await refresh()
    } catch (err) {
      toast.error(err)
    }
  }

  async function clearAll() {
    const ok = await dialog.confirm({
      title: '清空导入记录',
      message: '清空全部导入记录，并删除归档目录中的对应文件？',
      confirmLabel: '全部清空',
      danger: true,
    })
    if (!ok) return
    try {
      const res = await api.clearImportHistory(true)
      toast.success(`已清空 ${res.count} 条`)
      await refresh()
    } catch (err) {
      toast.error(err)
    }
  }

  async function reveal(path: string) {
    if (!path) {
      toast.error('没有可打开的路径')
      return
    }
    try {
      if (window.api?.showItem) {
        await window.api.showItem(path)
        return
      }
    } catch {
      // fallthrough
    }
    toast.error(`请手动打开：${path}`)
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card import-history-modal"
        role="dialog"
        aria-labelledby="import-history-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h3 id="import-history-title">导入记录</h3>
            <p className="modal-sub mono">
              归档目录：{importsDir || '加载中…'}
            </p>
          </div>
          <button className="btn btn-ghost-light" type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="import-history-toolbar">
          <button
            className="btn btn-light"
            type="button"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button
            className="btn btn-light"
            type="button"
            disabled={!importsDir}
            onClick={() => void reveal(importsDir)}
          >
            打开归档目录
          </button>
          <button
            className="btn btn-danger"
            type="button"
            disabled={!items.length}
            onClick={() => void clearAll()}
          >
            清空全部
          </button>
        </div>

        <div className="import-history-list">
          {!items.length && !loading && (
            <p className="import-history-empty">暂无导入记录。导入成功或失败后都会留下归档。</p>
          )}
          {items.map((item) => (
            <article
              key={item.id}
              className={`import-history-item ${item.ok ? 'ok' : 'fail'}`}
            >
              <div className="import-history-main">
                <div className="import-history-title-row">
                  <strong className="mono">{item.sourceFileName}</strong>
                  <span className={`pill ${item.ok ? 'ok' : 'fail'}`}>
                    {item.ok ? '成功' : '失败'}
                  </span>
                </div>
                <p className="meta">
                  {formatTime(item.createdAt)} · 目标库{' '}
                  <code>{item.targetDb}</code> ·{' '}
                  {item.mode === 'replace' ? '覆盖' : '合并'} ·{' '}
                  {formatBytes(item.bytes)} · {Math.round(item.durationMs / 1000)}s
                  {item.format ? ` · ${item.format}` : ''}
                </p>
                {item.error && <p className="import-history-error">{item.error}</p>}
                <p className="path-line mono" title={item.archivedPath}>
                  归档：{item.archivedPath || '—'}
                  {!item.archivedExists && item.archivedPath ? '（文件已不在）' : ''}
                </p>
                {item.sourcePath && (
                  <p className="path-line mono" title={item.sourcePath}>
                    原路径：{item.sourcePath}
                  </p>
                )}
              </div>
              <div className="import-history-actions">
                <button
                  className="btn btn-light"
                  type="button"
                  disabled={!item.archivedExists}
                  onClick={() => void reveal(item.archivedPath)}
                >
                  打开位置
                </button>
                {item.sourcePath && (
                  <button
                    className="btn btn-ghost-light"
                    type="button"
                    onClick={() => void reveal(item.sourcePath)}
                  >
                    原文件
                  </button>
                )}
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => void removeOne(item)}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
