export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) || 'http://127.0.0.1:3001'

export async function waitForApiReady(maxMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) return true
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function apiUrl(path: string) {
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

export type DatabaseInfo = {
  name: string
  sizeOnDisk: number
  empty: boolean
}

export type CollectionInfo = {
  name: string
  count: number
  type: string
}

export type DocumentsResponse = {
  documents: Record<string, unknown>[]
  total: number
  skip: number
  limit: number
  sortBy: string
  order: 'asc' | 'desc'
  filter?: Record<string, unknown>
}

export type IndexInfo = {
  name: string
  key: Record<string, unknown>
  unique: boolean
  sparse: boolean
  expireAfterSeconds?: number
  partialFilterExpression?: unknown
  collated: boolean
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(url), {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  let data: { error?: string } & Record<string, unknown> = {}
  if (text) {
    try {
      data = JSON.parse(text) as typeof data
    } catch {
      throw new Error(
        res.ok
          ? `响应不是 JSON：${text.slice(0, 160)}`
          : `请求失败 (${res.status})：${text.slice(0, 200)}`,
      )
    }
  }
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`)
  }
  return data as T
}

function collPath(db: string, coll: string) {
  return `/api/databases/${encodeURIComponent(db)}/collections/${encodeURIComponent(coll)}`
}

export const api = {
  health: () =>
    request<{ ok: boolean; uri: string; error?: string }>('/api/health'),

  connect: (uri?: string) =>
    request<{ ok: boolean; uri: string }>('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    }),

  databases: () =>
    request<{ databases: DatabaseInfo[] }>('/api/databases'),

  collections: (db: string) =>
    request<{ collections: CollectionInfo[] }>(
      `/api/databases/${encodeURIComponent(db)}/collections`,
    ),

  documents: (
    db: string,
    coll: string,
    opts: {
      limit?: number
      skip?: number
      order?: 'asc' | 'desc'
      filter?: string
    } = {},
  ) => {
    const params = new URLSearchParams({
      limit: String(opts.limit ?? 50),
      skip: String(opts.skip ?? 0),
      sortBy: 'createdAt',
      order: opts.order ?? 'desc',
    })
    if (opts.filter?.trim()) {
      params.set('filter', opts.filter.trim())
    }
    return request<DocumentsResponse>(
      `${collPath(db, coll)}/documents?${params}`,
    )
  },

  indexes: (db: string, coll: string) =>
    request<{ indexes: IndexInfo[] }>(`${collPath(db, coll)}/indexes`),

  createIndex: (
    db: string,
    coll: string,
    body: {
      keys: Record<string, unknown>
      name?: string
      unique?: boolean
      sparse?: boolean
      expireAfterSeconds?: number
    },
  ) =>
    request<{ ok: boolean; name: string; indexes: IndexInfo[] }>(
      `${collPath(db, coll)}/indexes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),

  dropIndex: (db: string, coll: string, name: string) =>
    request<{ ok: boolean; indexes: IndexInfo[] }>(
      `${collPath(db, coll)}/indexes/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),

  dropCollection: (db: string, coll: string) =>
    request<{ ok: boolean; db: string; collection: string }>(
      collPath(db, coll),
      { method: 'DELETE' },
    ),

  clearCollection: (db: string, coll: string) =>
    request<{
      ok: boolean
      db: string
      collection: string
      deletedCount: number
    }>(`${collPath(db, coll)}/clear`, { method: 'POST' }),

  mongosh: (script: string, db?: string | null) =>
    request<{
      ok: boolean
      stdout: string
      stderr: string
      uri?: string
      error?: string
    }>('/api/mongosh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, db: db || undefined }),
    }),

  deleteDocument: (db: string, coll: string, id: string) =>
    request<{ ok: boolean; deletedId: string; deletedCount: number }>(
      `${collPath(db, coll)}/documents/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  updateDocument: (
    db: string,
    coll: string,
    id: string,
    document: Record<string, unknown>,
  ) =>
    request<{
      ok: boolean
      modifiedCount: number
      document: Record<string, unknown>
    }>(`${collPath(db, coll)}/documents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document }),
    }),

  bulkUpdateDocuments: (
    db: string,
    coll: string,
    body: {
      filter?: Record<string, unknown> | string
      update: Record<string, unknown>
      allowEmptyFilter?: boolean
    },
  ) =>
    request<{
      ok: boolean
      matchedCount: number
      modifiedCount: number
    }>(`${collPath(db, coll)}/documents/bulk-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  bulkDeleteDocuments: (db: string, coll: string, ids: string[]) =>
    request<{ ok: boolean; requested: number; deletedCount: number }>(
      `${collPath(db, coll)}/documents/bulk-delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      },
    ),

  exportDatabase: async (db: string) => {
    const res = await fetch(
      apiUrl(`/api/databases/${encodeURIComponent(db)}/export`),
    )
    if (!res.ok) {
      const text = await res.text()
      let message = `导出失败 (${res.status})`
      try {
        message = (JSON.parse(text) as { error?: string }).error || message
      } catch {
        // ignore
      }
      throw new Error(message)
    }
    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition') || ''
    const matched = disposition.match(/filename="?([^"]+)"?/i)
    const fileName = matched?.[1]
      ? decodeURIComponent(matched[1])
      : `${db}_bson_backup_mc`
    return { blob, fileName }
  },

  exportCollection: async (db: string, coll: string) => {
    const res = await fetch(apiUrl(`${collPath(db, coll)}/export`))
    if (!res.ok) {
      const text = await res.text()
      let message = `导出失败 (${res.status})`
      try {
        message = (JSON.parse(text) as { error?: string }).error || message
      } catch {
        // ignore
      }
      throw new Error(message)
    }
    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition') || ''
    const matched = disposition.match(/filename="?([^"]+)"?/i)
    const fileName = matched?.[1]
      ? decodeURIComponent(matched[1])
      : `${db}_${coll}_bson_backup_mc`
    return { blob, fileName }
  },

  importDatabase: async (
    db: string,
    file: File,
    mode: 'merge' | 'replace' = 'replace',
    sourcePath = '',
  ) => {
    const params = new URLSearchParams({
      mode,
      filename: file.name,
    })
    if (sourcePath) params.set('sourcePath', sourcePath)
    const res = await fetch(
      apiUrl(`/api/databases/${encodeURIComponent(db)}/import?${params}`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      },
    )
    const text = await res.text()
    let data: {
      error?: string
      ok?: boolean
      db?: string
      mode?: string
      format?: string
      history?: ImportHistoryItem
    } = {}
    if (text) {
      try {
        data = JSON.parse(text) as typeof data
      } catch {
        throw new Error(
          `导入失败 (${res.status})：服务器返回了非 JSON 响应。请确认已安装 MongoDB Database Tools 并重启服务`,
        )
      }
    }
    if (!res.ok) {
      throw new Error(data.error || `导入失败 (${res.status})`)
    }
    return data as {
      ok: boolean
      db: string
      mode: string
      format: string
      history?: ImportHistoryItem
    }
  },

  listImportHistory: () =>
    request<{ items: ImportHistoryItem[]; importsDir: string }>(
      '/api/import-history',
    ),

  deleteImportHistory: (id: string, removeFile = true) =>
    request<{ ok: boolean; removedFile: boolean }>(
      `/api/import-history/${encodeURIComponent(id)}?removeFile=${removeFile ? '1' : '0'}`,
      { method: 'DELETE' },
    ),

  clearImportHistory: (removeFiles = true) =>
    request<{ ok: boolean; count: number }>(
      `/api/import-history?removeFiles=${removeFiles ? '1' : '0'}`,
      { method: 'DELETE' },
    ),
}

export type ImportHistoryItem = {
  id: string
  createdAt: number
  targetDb: string
  sourceFileName: string
  sourcePath: string
  archivedPath: string
  archivedExists?: boolean
  mode: 'merge' | 'replace'
  format: string
  bytes: number
  ok: boolean
  error?: string
  durationMs: number
}

async function downloadBlob(blob: Blob, filename: string) {
  const isTauri =
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    const data = new Uint8Array(await blob.arrayBuffer())
    const saved = await invoke<string | null>('save_export_file', {
      fileName: filename,
      data,
    })
    if (!saved) {
      throw new Error('已取消保存')
    }
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export { downloadBlob }

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
