import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

export type ImportHistoryItem = {
  id: string
  createdAt: number
  targetDb: string
  sourceFileName: string
  /** 拖入/选择时的本机原路径（Electron 可得） */
  sourcePath: string
  /** 归档副本路径（可在导入记录里找到） */
  archivedPath: string
  mode: 'merge' | 'replace'
  format: string
  bytes: number
  ok: boolean
  error?: string
  durationMs: number
}

function dataRoot() {
  return (
    process.env.LEAF_DESK_DATA?.trim() ||
    join(homedir(), '.leaf-desk')
  )
}

export function importsDir() {
  return join(dataRoot(), 'imports')
}

function historyFile() {
  return join(dataRoot(), 'import-history.json')
}

function ensureDirs() {
  mkdirSync(importsDir(), { recursive: true })
  const hf = historyFile()
  if (!existsSync(hf)) {
    writeFileSync(hf, '[]', 'utf8')
  }
}

function readAll(): ImportHistoryItem[] {
  ensureDirs()
  try {
    const raw = JSON.parse(readFileSync(historyFile(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((x) => x && typeof x === 'object') as ImportHistoryItem[]
  } catch {
    return []
  }
}

function writeAll(list: ImportHistoryItem[]) {
  ensureDirs()
  writeFileSync(historyFile(), JSON.stringify(list, null, 2), 'utf8')
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function safeName(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180)
}

/** 将导入文件归档到本机目录，并写入历史 */
export function archiveImportFile(
  buf: Buffer,
  meta: {
    targetDb: string
    sourceFileName: string
    sourcePath?: string
    mode: 'merge' | 'replace'
    format: string
    ok: boolean
    error?: string
    durationMs: number
  }
): ImportHistoryItem {
  ensureDirs()
  const id = uid()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archivedName = `${stamp}_${safeName(meta.sourceFileName || 'backup.zip')}`
  const archivedPath = join(importsDir(), archivedName)
  writeFileSync(archivedPath, buf)

  const item: ImportHistoryItem = {
    id,
    createdAt: Date.now(),
    targetDb: meta.targetDb,
    sourceFileName: meta.sourceFileName || basename(archivedPath),
    sourcePath: (meta.sourcePath || '').trim(),
    archivedPath,
    mode: meta.mode,
    format: meta.format || 'unknown',
    bytes: buf.length,
    ok: meta.ok,
    error: meta.error,
    durationMs: meta.durationMs
  }

  const list = readAll()
  list.unshift(item)
  // 最多保留 200 条记录（文件另删）
  writeAll(list.slice(0, 200))
  return item
}

export function listImportHistory(): ImportHistoryItem[] {
  return readAll()
}

export function getImportHistoryItem(id: string): ImportHistoryItem | undefined {
  return readAll().find((x) => x.id === id)
}

/** 仅删记录；可选同时删归档文件 */
export function deleteImportHistory(
  id: string,
  removeFile: boolean
): { ok: boolean; removedFile: boolean } {
  const list = readAll()
  const idx = list.findIndex((x) => x.id === id)
  if (idx < 0) return { ok: false, removedFile: false }
  const [item] = list.splice(idx, 1)
  writeAll(list)
  let removedFile = false
  if (removeFile && item?.archivedPath && existsSync(item.archivedPath)) {
    try {
      unlinkSync(item.archivedPath)
      removedFile = true
    } catch {
      // ignore
    }
  }
  return { ok: true, removedFile }
}

export function clearImportHistory(removeFiles: boolean): number {
  const list = readAll()
  if (removeFiles) {
    for (const item of list) {
      if (item.archivedPath && existsSync(item.archivedPath)) {
        try {
          unlinkSync(item.archivedPath)
        } catch {
          // ignore
        }
      }
    }
  }
  writeAll([])
  return list.length
}

/** 兼容：若归档路径被挪到同目录，尝试纠正 */
export function resolveArchivedPath(item: ImportHistoryItem): string {
  if (item.archivedPath && existsSync(item.archivedPath)) return item.archivedPath
  const fallback = join(importsDir(), basename(item.archivedPath || item.sourceFileName))
  if (existsSync(fallback)) {
    const list = readAll()
    const hit = list.find((x) => x.id === item.id)
    if (hit) {
      hit.archivedPath = fallback
      writeAll(list)
    }
    return fallback
  }
  return item.archivedPath
}
