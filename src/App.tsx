import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import {
  api,
  downloadBlob,
  formatBytes,
  waitForApiReady,
  type CollectionInfo,
  type DatabaseInfo,
  type DocumentsResponse,
  type IndexInfo,
} from './api'
import { BulkUpdateModal } from './BulkUpdateModal'
import { DocEditModal } from './DocEditModal'
import { ImportHistoryModal } from './ImportHistoryModal'
import { JsonView } from './JsonView'
import { useDialog } from './dialogs'
import { MongoshPanel } from './MongoshPanel'
import { toast } from './toast'
import './App.css'

const DEFAULT_URI = 'mongodb://127.0.0.1:27017'

type QueryRow = { id: string; key: string; value: string }

function newQueryRow(): QueryRow {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, key: '', value: '' }
}

function parseQueryValue(raw: string): unknown {
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

function buildFilterFromRows(rows: QueryRow[]): string {
  const filter: Record<string, unknown> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    filter[key] = parseQueryValue(row.value)
  }
  return Object.keys(filter).length > 0 ? JSON.stringify(filter) : ''
}

type RouteState = {
  db: string | null
  coll: string | null
  tab: 'docs' | 'indexes'
  cf: string
}

const ROUTE_STORAGE_KEY = 'leaf-desk-route'
const PINNED_DB_STORAGE_KEY = 'leaf-desk-pinned-dbs'
const PINNED_COLL_STORAGE_KEY = 'leaf-desk-pinned-colls'

function readPinnedDbs(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_DB_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((name): name is string => typeof name === 'string')
  } catch {
    return []
  }
}

function writePinnedDbs(names: string[]) {
  try {
    localStorage.setItem(PINNED_DB_STORAGE_KEY, JSON.stringify(names))
  } catch {
    // ignore
  }
}

function readPinnedColls(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(PINNED_COLL_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [db, names] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(names)) continue
      out[db] = names.filter((name): name is string => typeof name === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function writePinnedColls(map: Record<string, string[]>) {
  try {
    localStorage.setItem(PINNED_COLL_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

function readRoute(): RouteState {
  const params = new URLSearchParams(window.location.search)
  let db = params.get('db')
  let coll = params.get('coll')
  let tab: 'docs' | 'indexes' = params.get('tab') === 'indexes' ? 'indexes' : 'docs'
  let cf = params.get('cf') ?? ''

  if (!db) {
    try {
      const raw = localStorage.getItem(ROUTE_STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Partial<RouteState>
        db = saved.db ?? null
        coll = saved.coll ?? null
        tab = saved.tab === 'indexes' ? 'indexes' : 'docs'
        cf = typeof saved.cf === 'string' ? saved.cf : ''
      }
    } catch {
      // ignore
    }
  }

  return { db, coll, tab, cf }
}

function writeRoute(next: RouteState) {
  const params = new URLSearchParams()
  if (next.db) params.set('db', next.db)
  if (next.coll) params.set('coll', next.coll)
  if (next.tab === 'indexes') params.set('tab', 'indexes')
  if (next.cf.trim()) params.set('cf', next.cf.trim())

  const qs = params.toString()
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  window.history.replaceState(null, '', url)

  try {
    localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore
  }
}

function getDocId(doc: Record<string, unknown>): string {
  const id = doc._id
  if (id && typeof id === 'object' && '$oid' in id) {
    return String((id as { $oid: string }).$oid)
  }
  return String(id ?? '—')
}

function getCreatedHint(doc: Record<string, unknown>): string | null {
  const createdAt = doc.createdAt
  if (createdAt && typeof createdAt === 'object' && '$date' in createdAt) {
    return new Date((createdAt as { $date: string }).$date).toLocaleString()
  }
  if (typeof createdAt === 'string') {
    const d = new Date(createdAt)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString()
  }

  const id = doc._id
  if (id && typeof id === 'object' && '$oid' in id) {
    const hex = (id as { $oid: string }).$oid
    if (/^[a-f0-9]{24}$/i.test(hex)) {
      const ts = parseInt(hex.slice(0, 8), 16) * 1000
      return new Date(ts).toLocaleString()
    }
  }
  return null
}

export default function App() {
  const dialog = useDialog()
  const [uri, setUri] = useState(DEFAULT_URI)
  const [connected, setConnected] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [databases, setDatabases] = useState<DatabaseInfo[]>([])
  const [collections, setCollections] = useState<CollectionInfo[]>([])
  const [selectedDb, setSelectedDb] = useState<string | null>(null)
  const [selectedColl, setSelectedColl] = useState<string | null>(null)
  const [docs, setDocs] = useState<DocumentsResponse | null>(null)
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(0)
  const [loadingNav, setLoadingNav] = useState(false)
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [collFilter, setCollFilter] = useState('')
  const [queryRows, setQueryRows] = useState<QueryRow[]>([newQueryRow()])
  const [activeQuery, setActiveQuery] = useState('')
  const [mainTab, setMainTab] = useState<'docs' | 'indexes'>('docs')
  const [appView, setAppView] = useState<'browse' | 'shell'>('browse')
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [loadingIndexes, setLoadingIndexes] = useState(false)
  const [indexKeysDraft, setIndexKeysDraft] = useState('{"createdAt":-1}')
  const [indexNameDraft, setIndexNameDraft] = useState('')
  const [indexUnique, setIndexUnique] = useState(false)
  const [indexSparse, setIndexSparse] = useState(false)
  const [creatingIndex, setCreatingIndex] = useState(false)
  const [ioBusy, setIoBusy] = useState(false)
  const [ioElapsed, setIoElapsed] = useState(0)
  const [ioLabel, setIoLabel] = useState('正在处理导入/导出')
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([])
  const [editingDoc, setEditingDoc] = useState<Record<string, unknown> | null>(
    null,
  )
  const [savingDoc, setSavingDoc] = useState(false)
  const [bulkUpdateOpen, setBulkUpdateOpen] = useState(false)
  const [bulkMatchCount, setBulkMatchCount] = useState<number | null>(null)
  const [bulkCounting, setBulkCounting] = useState(false)
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkFilterJson, setBulkFilterJson] = useState('')
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [importHistoryOpen, setImportHistoryOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const dragDepthRef = useRef(0)
  const [routeReady, setRouteReady] = useState(false)
  const [pinnedDbs, setPinnedDbs] = useState<string[]>(() => readPinnedDbs())
  const [pinnedColls, setPinnedColls] = useState<Record<string, string[]>>(
    () => readPinnedColls(),
  )
  const restoringRef = useRef(false)

  const pageSize = 50

  useEffect(() => {
    if (!ioBusy) {
      setIoElapsed(0)
      return
    }
    const started = Date.now()
    setIoElapsed(0)
    const timer = window.setInterval(() => {
      setIoElapsed(Math.floor((Date.now() - started) / 1000))
    }, 250)
    return () => window.clearInterval(timer)
  }, [ioBusy])

  const sortedDatabases = useMemo(() => {
    const keyword = collFilter.trim().toLowerCase()
    const matched = keyword
      ? databases.filter((db) => {
          if (db.name.toLowerCase().includes(keyword)) return true
          // 当前展开库：按集合名也能命中，避免搜表时把库筛没
          if (
            selectedDb === db.name &&
            collections.some((col) => col.name.toLowerCase().includes(keyword))
          ) {
            return true
          }
          return false
        })
      : databases

    const pinnedSet = new Set(pinnedDbs)
    const pinned = pinnedDbs
      .map((name) => matched.find((db) => db.name === name))
      .filter((db): db is DatabaseInfo => Boolean(db))
    const rest = matched
      .filter((db) => !pinnedSet.has(db.name))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
    return [...pinned, ...rest]
  }, [databases, pinnedDbs, collFilter, selectedDb, collections])

  const sortedCollections = useMemo(() => {
    const keyword = collFilter.trim().toLowerCase()
    const matched = keyword
      ? collections.filter((col) => col.name.toLowerCase().includes(keyword))
      : collections

    if (!selectedDb) return matched

    const pinnedNames = pinnedColls[selectedDb] ?? []
    const pinnedSet = new Set(pinnedNames)
    const pinned = pinnedNames
      .map((name) => matched.find((col) => col.name === name))
      .filter((col): col is CollectionInfo => Boolean(col))
    const rest = matched
      .filter((col) => !pinnedSet.has(col.name))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
    return [...pinned, ...rest]
  }, [collections, collFilter, selectedDb, pinnedColls])

  const togglePinDb = (name: string) => {
    setPinnedDbs((prev) => {
      const next = prev.includes(name)
        ? prev.filter((item) => item !== name)
        : [...prev, name]
      writePinnedDbs(next)
      return next
    })
  }

  const togglePinColl = (db: string, name: string) => {
    setPinnedColls((prev) => {
      const current = prev[db] ?? []
      const nextForDb = current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name]
      const next = { ...prev, [db]: nextForDb }
      if (nextForDb.length === 0) {
        delete next[db]
      }
      writePinnedColls(next)
      return next
    })
  }

  const exportDatabase = async (db: string) => {
    setIoBusy(true)
    setIoLabel(`正在导出数据库「${db}」`)
    try {
      const { blob, fileName } = await api.exportDatabase(db)
      downloadBlob(blob, fileName)
      toast.success(`已导出数据库「${db}」（宝塔兼容 zip）：${fileName}`)
    } catch (err) {
      toast.error(err)
    } finally {
      setIoBusy(false)
    }
  }

  const exportCollection = async (db: string, coll: string) => {
    setIoBusy(true)
    setIoLabel(`正在导出集合「${db}.${coll}」`)
    try {
      const { blob, fileName } = await api.exportCollection(db, coll)
      downloadBlob(blob, fileName)
      toast.success(`已导出集合「${db}.${coll}」（宝塔兼容 zip）：${fileName}`)
    } catch (err) {
      toast.error(err)
    } finally {
      setIoBusy(false)
    }
  }

  const importDatabaseFromFile = async (file: File) => {
    if (!selectedDb) {
      toast.error('请先选择要导入到的数据库（左侧点开库名后再导入）')
      return
    }

    const sourcePath =
      typeof window.api?.getPathForFile === 'function'
        ? window.api.getPathForFile(file)
        : ''

    const mode = await dialog.choose({
      title: `导入到「${selectedDb}」`,
      message: `文件：${file.name}${sourcePath ? `\n路径：${sourcePath}` : ''}\n\n支持宝塔 bson 备份 / mongodump zip。导入后会归档一份到本机，可在「导入记录」查看。`,
      options: [
        { id: 'merge', label: '合并导入', primary: true },
        { id: 'replace', label: '覆盖导入', danger: true },
      ],
    })
    if (!mode) return

    setIoBusy(true)
    setIoLabel(`正在导入到「${selectedDb}」`)
    try {
      const head = new Uint8Array(await file.slice(0, 2).arrayBuffer())
      const isZip = head[0] === 0x50 && head[1] === 0x4b
      const isGzip = head[0] === 0x1f && head[1] === 0x8b
      if (!isZip && !isGzip && !/_bson_/i.test(file.name)) {
        throw new Error(
          '请选择宝塔 MongoDB 备份（含 _bson_ 的文件）或 Leaf Desk 导出的 .zip',
        )
      }
      const result = await api.importDatabase(
        selectedDb,
        file,
        mode === 'replace' ? 'replace' : 'merge',
        sourcePath,
      )
      const archived = result.history?.archivedPath
      toast.success(
        archived
          ? `导入完成（${result.format}，${result.mode === 'replace' ? '覆盖' : '合并'}）\n已归档：${archived}`
          : `导入完成（${result.format}，${result.mode === 'replace' ? '覆盖' : '合并'}）`,
      )
      const { collections: list } = await api.collections(selectedDb)
      setCollections(list)
      if (selectedColl) {
        await Promise.all([
          loadDocuments(selectedDb, selectedColl, 0, order, activeQuery),
          loadIndexes(selectedDb, selectedColl),
        ])
      }
    } catch (err) {
      toast.error(err)
    } finally {
      setIoBusy(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const onShellDragEnter = (e: DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragOver(true)
  }

  const onShellDragLeave = (e: DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }

  const onShellDragOver = (e: DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onShellDrop = (e: DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    if (ioBusy) {
      toast.error('正在导入/导出，请稍候')
      return
    }
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    void importDatabaseFromFile(file)
  }

  const dropCollection = async (db: string, name: string) => {
    const ok = await dialog.confirm({
      title: '删除集合',
      message: `确定删除集合「${db}.${name}」？\n\n此操作会删除该集合的全部文档和索引，且不可恢复。`,
      confirmLabel: '继续',
      danger: true,
    })
    if (!ok) return

    const typed = await dialog.prompt({
      title: '确认删除集合',
      message: `请输入集合名以确认删除。`,
      expected: name,
      confirmLabel: '删除集合',
      danger: true,
    })
    if (typed === null) return
    if (typed !== name) {
      toast.error('集合名不匹配，已取消删除')
      return
    }

    setLoadingNav(true)
    try {
      await api.dropCollection(db, name)
      toast.success(`已删除集合「${db}.${name}」`)
      setCollections((prev) => prev.filter((col) => col.name !== name))
      setPinnedColls((prev) => {
        const current = prev[db] ?? []
        if (!current.includes(name)) return prev
        const nextForDb = current.filter((item) => item !== name)
        const next = { ...prev, [db]: nextForDb }
        if (nextForDb.length === 0) delete next[db]
        writePinnedColls(next)
        return next
      })
      if (selectedDb === db && selectedColl === name) {
        setSelectedColl(null)
        setDocs(null)
        setIndexes([])
        setQueryRows([newQueryRow()])
        setActiveQuery('')
        setMainTab('docs')
        setPage(0)
      }
    } catch (err) {
      toast.error(err)
    } finally {
      setLoadingNav(false)
    }
  }

  const clearCollection = async () => {
    if (!selectedDb || !selectedColl) return
    const ok = await dialog.confirm({
      title: '清空集合',
      message: `确定清空集合「${selectedDb}.${selectedColl}」的全部文档？\n\n集合本身和索引会保留，仅删除数据，且不可恢复。`,
      confirmLabel: '继续',
      danger: true,
    })
    if (!ok) return

    const typed = await dialog.prompt({
      title: '确认清空集合',
      message: '请输入集合名以确认清空。',
      expected: selectedColl,
      confirmLabel: '清空集合',
      danger: true,
    })
    if (typed === null) return
    if (typed !== selectedColl) {
      toast.error('集合名不匹配，已取消清空')
      return
    }

    setIoBusy(true)
    setIoLabel(`正在清空集合「${selectedColl}」`)
    try {
      const result = await api.clearCollection(selectedDb, selectedColl)
      setSelectedDocIds([])
      setDocs({
        documents: [],
        total: 0,
        skip: 0,
        limit: pageSize,
        sortBy: docs?.sortBy ?? '_id',
        order: order,
      })
      setPage(0)
      setCollections((prev) =>
        prev.map((col) =>
          col.name === selectedColl ? { ...col, count: 0 } : col,
        ),
      )
      toast.success(`已清空集合，删除 ${result.deletedCount} 条文档`)
    } catch (err) {
      toast.error(err)
    } finally {
      setIoBusy(false)
    }
  }

  const loadDatabases = useCallback(async () => {
    setLoadingNav(true)
    try {
      const { databases: list } = await api.databases()
      setDatabases(list)
      setConnected(true)
      setStatusError(null)
    } catch (err) {
      setConnected(false)
      setStatusError(err instanceof Error ? err.message : String(err))
      setDatabases([])
    } finally {
      setLoadingNav(false)
    }
  }, [])

  const connect = useCallback(async () => {
    setLoadingNav(true)
    try {
      const ready = await waitForApiReady()
      if (!ready) throw new Error('本地 Mongo 服务未就绪，请稍后重试或重启应用')
      await api.connect(uri)
      setSelectedDb(null)
      setSelectedColl(null)
      setCollections([])
      setCollFilter('')
      setDocs(null)
      setPage(0)
      await loadDatabases()
    } catch (err) {
      setConnected(false)
      setStatusError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingNav(false)
    }
  }, [uri, loadDatabases])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingNav(true)
      try {
        const ready = await waitForApiReady()
        if (!ready) throw new Error('本地 Mongo 服务未就绪，请稍后重试或重启应用')
        if (cancelled) return
        await api.connect(uri)
        if (cancelled) return
        const { databases: list } = await api.databases()
        if (cancelled) return
        setDatabases(list)
        setConnected(true)
        setStatusError(null)

        // 从 URL / localStorage 恢复上次停留的库表
        const route = readRoute()
        if (route.db && list.some((db) => db.name === route.db)) {
          restoringRef.current = true
          setSelectedDb(route.db)
          setCollFilter(route.cf)
          setMainTab(route.tab)
          try {
            const { collections: cols } = await api.collections(route.db)
            if (cancelled) return
            setCollections(cols)
            if (route.coll && cols.some((col) => col.name === route.coll)) {
              setSelectedColl(route.coll)
              setPage(0)
              setQueryRows([newQueryRow()])
              setActiveQuery('')
              const [docData, indexData] = await Promise.all([
                api.documents(route.db, route.coll, {
                  limit: pageSize,
                  skip: 0,
                  order: 'desc',
                }),
                api.indexes(route.db, route.coll),
              ])
              if (cancelled) return
              setDocs(docData)
              setIndexes(indexData.indexes)
            }
          } catch (err) {
            if (!cancelled) {
              toast.error(err)
            }
          } finally {
            restoringRef.current = false
          }
        }
      } catch (err) {
        if (cancelled) return
        setConnected(false)
        setStatusError(err instanceof Error ? err.message : String(err))
        setDatabases([])
      } finally {
        if (!cancelled) {
          setLoadingNav(false)
          setRouteReady(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // 仅首次挂载自动连接默认地址
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!routeReady || restoringRef.current) return
    writeRoute({
      db: selectedDb,
      coll: selectedColl,
      tab: mainTab,
      cf: collFilter,
    })
  }, [routeReady, selectedDb, selectedColl, mainTab, collFilter])

  const selectDb = async (name: string) => {
    // 再点已展开的库 → 收起
    if (selectedDb === name) {
      setSelectedDb(null)
      setSelectedColl(null)
      setCollections([])
      setDocs(null)
      setIndexes([])
      setPage(0)
      setMainTab('docs')
      return
    }

    setSelectedDb(name)
    setSelectedColl(null)
    setDocs(null)
    setIndexes([])
    setPage(0)
    setMainTab('docs')
    setLoadingNav(true)
    try {
      const { collections: list } = await api.collections(name)
      setCollections(list)
    } catch (err) {
      toast.error(err)
      setCollections([])
    } finally {
      setLoadingNav(false)
    }
  }

  const loadDocuments = useCallback(
    async (
      db: string,
      coll: string,
      nextPage: number,
      nextOrder: 'asc' | 'desc',
      filterText = activeQuery,
    ) => {
      setLoadingDocs(true)
      try {
        const data = await api.documents(db, coll, {
          limit: pageSize,
          skip: nextPage * pageSize,
          order: nextOrder,
          filter: filterText,
        })
        setDocs(data)
      } catch (err) {
        toast.error(err)
        setDocs(null)
      } finally {
        setLoadingDocs(false)
      }
    },
    [activeQuery],
  )

  const loadIndexes = useCallback(async (db: string, coll: string) => {
    setLoadingIndexes(true)
    try {
      const data = await api.indexes(db, coll)
      setIndexes(data.indexes)
    } catch (err) {
      toast.error(err)
      setIndexes([])
    } finally {
      setLoadingIndexes(false)
    }
  }, [])

  const selectColl = async (name: string) => {
    if (!selectedDb) return
    setSelectedColl(name)
    setPage(0)
    setQueryRows([newQueryRow()])
    setActiveQuery('')
    setSelectedDocIds([])
    setMainTab('docs')
    setIndexKeysDraft('{"createdAt":-1}')
    setIndexNameDraft('')
    setIndexUnique(false)
    setIndexSparse(false)
    await Promise.all([
      loadDocuments(selectedDb, name, 0, order, ''),
      loadIndexes(selectedDb, name),
    ])
  }

  const changeOrder = async (next: 'asc' | 'desc') => {
    setOrder(next)
    setPage(0)
    if (selectedDb && selectedColl) {
      await loadDocuments(selectedDb, selectedColl, 0, next)
    }
  }

  const goPage = async (next: number) => {
    if (!selectedDb || !selectedColl) return
    setPage(next)
    await loadDocuments(selectedDb, selectedColl, next, order)
  }

  const updateQueryRow = (id: string, patch: Partial<Pick<QueryRow, 'key' | 'value'>>) => {
    setQueryRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const addQueryRow = () => {
    setQueryRows((rows) => [...rows, newQueryRow()])
  }

  const addIdQueryRow = () => {
    setQueryRows((rows) => {
      const empty = rows.find((row) => !row.key.trim() && !row.value.trim())
      if (empty) {
        return rows.map((row) =>
          row.id === empty.id ? { ...row, key: '_id' } : row,
        )
      }
      return [...rows, { ...newQueryRow(), key: '_id' }]
    })
  }

  const removeQueryRow = (id: string) => {
    setQueryRows((rows) => (rows.length <= 1 ? [newQueryRow()] : rows.filter((row) => row.id !== id)))
  }

  const runQuery = async () => {
    if (!selectedDb || !selectedColl) return
    const filled = queryRows.filter((row) => row.key.trim())
    if (filled.length === 0) {
      toast.error('请至少填写一个字段名（key）')
      return
    }
    const next = buildFilterFromRows(queryRows)
    setActiveQuery(next)
    setPage(0)
    await loadDocuments(selectedDb, selectedColl, 0, order, next)
  }

  const clearQuery = async () => {
    if (!selectedDb || !selectedColl) return
    setQueryRows([newQueryRow()])
    setActiveQuery('')
    setPage(0)
    await loadDocuments(selectedDb, selectedColl, 0, order, '')
  }

  const openBulkUpdate = async () => {
    if (!selectedDb || !selectedColl) return
    const filled = queryRows.filter((row) => row.key.trim())
    const filterJson = filled.length > 0 ? buildFilterFromRows(queryRows) : ''
    setBulkFilterJson(filterJson)
    setBulkMatchCount(null)
    setBulkUpdateOpen(true)
    setBulkCounting(true)
    try {
      const data = await api.documents(selectedDb, selectedColl, {
        limit: 1,
        skip: 0,
        order,
        filter: filterJson,
      })
      setBulkMatchCount(data.total)
    } catch (err) {
      setBulkUpdateOpen(false)
      toast.error(err)
    } finally {
      setBulkCounting(false)
    }
  }

  const runBulkUpdate = async (payload: {
    update: Record<string, unknown>
    allowEmptyFilter: boolean
  }) => {
    if (!selectedDb || !selectedColl) return
    const filterEmpty =
      !bulkFilterJson.trim() || bulkFilterJson.trim() === '{}'
    const countLabel =
      bulkMatchCount != null ? String(bulkMatchCount) : '全部匹配'

    const ok = await dialog.confirm({
      title: '确认批量修改',
      message: filterEmpty
        ? `将按空条件修改集合「${selectedDb}.${selectedColl}」内的文档（约 ${countLabel} 条）。此操作不可撤销预览，请确认字段无误。`
        : `将修改「${selectedDb}.${selectedColl}」中匹配条件的约 ${countLabel} 条文档。`,
      confirmLabel: '确认修改',
      danger: true,
    })
    if (!ok) return

    setBulkSaving(true)
    try {
      let filter: Record<string, unknown> = {}
      if (bulkFilterJson.trim()) {
        filter = JSON.parse(bulkFilterJson) as Record<string, unknown>
      }
      const result = await api.bulkUpdateDocuments(selectedDb, selectedColl, {
        filter,
        update: payload.update,
        allowEmptyFilter: payload.allowEmptyFilter,
      })
      toast.success(
        `批量修改完成：匹配 ${result.matchedCount} 条，实际更新 ${result.modifiedCount} 条`,
      )
      setBulkUpdateOpen(false)
      // 若当前列表有筛选，保持；否则刷新当前页
      const nextFilter =
        activeQuery ||
        (queryRows.some((row) => row.key.trim())
          ? buildFilterFromRows(queryRows)
          : '')
      if (nextFilter && nextFilter !== activeQuery) {
        setActiveQuery(nextFilter)
      }
      await loadDocuments(
        selectedDb,
        selectedColl,
        page,
        order,
        nextFilter || activeQuery,
      )
      const { collections: list } = await api.collections(selectedDb)
      setCollections(list)
    } catch (err) {
      toast.error(err)
    } finally {
      setBulkSaving(false)
    }
  }

  const pageDocIds = (docs?.documents ?? [])
    .map((doc) => getDocId(doc))
    .filter((id) => id && id !== '—')

  const allPageSelected =
    pageDocIds.length > 0 && pageDocIds.every((id) => selectedDocIds.includes(id))

  const toggleDocSelected = (id: string) => {
    if (!id || id === '—') return
    setSelectedDocIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    )
  }

  const toggleSelectAllOnPage = () => {
    if (allPageSelected) {
      setSelectedDocIds((prev) => prev.filter((id) => !pageDocIds.includes(id)))
      return
    }
    setSelectedDocIds((prev) => Array.from(new Set([...prev, ...pageDocIds])))
  }

  const saveDocument = async (document: Record<string, unknown>) => {
    if (!selectedDb || !selectedColl || !editingDoc) return
    const id = getDocId(editingDoc)
    if (id === '—' || !id) {
      toast.error('无法保存：文档没有有效 _id')
      return
    }

    setSavingDoc(true)
    try {
      const result = await api.updateDocument(
        selectedDb,
        selectedColl,
        id,
        document,
      )
      setEditingDoc(null)
      toast.success(
        result.modifiedCount > 0 ? '文档已保存' : '已提交（内容与原来相同）',
      )
      await loadDocuments(selectedDb, selectedColl, page, order)
    } catch (err) {
      toast.error(err)
    } finally {
      setSavingDoc(false)
    }
  }

  const deleteDocument = async (id: string) => {
    if (!selectedDb || !selectedColl) return
    if (id === '—' || !id) {
      toast.error('无法删除：文档没有有效 _id')
      return
    }
    const ok = await dialog.confirm({
      title: '删除文档',
      message: `确定删除这条文档？\n_id: ${id}`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return

    setLoadingDocs(true)
    try {
      await api.deleteDocument(selectedDb, selectedColl, id)
      toast.success('文档已删除')
      setSelectedDocIds((prev) => prev.filter((item) => item !== id))
      const onlyOneOnPage = (docs?.documents.length ?? 0) <= 1
      const nextPage = onlyOneOnPage && page > 0 ? page - 1 : page
      if (nextPage !== page) setPage(nextPage)
      await loadDocuments(selectedDb, selectedColl, nextPage, order)
    } catch (err) {
      toast.error(err)
    } finally {
      setLoadingDocs(false)
    }
  }

  const bulkDeleteDocuments = async () => {
    if (!selectedDb || !selectedColl) return
    if (selectedDocIds.length === 0) {
      toast.error('请先勾选要删除的文档')
      return
    }
    const ok = await dialog.confirm({
      title: '批量删除',
      message: `确定批量删除选中的 ${selectedDocIds.length} 条文档？此操作不可恢复。`,
      confirmLabel: '批量删除',
      danger: true,
    })
    if (!ok) return

    setLoadingDocs(true)
    try {
      const result = await api.bulkDeleteDocuments(
        selectedDb,
        selectedColl,
        selectedDocIds,
      )
      setSelectedDocIds([])
      toast.success(`已删除 ${result.deletedCount} 条文档`)
      const remain = (docs?.documents.length ?? 0) - result.deletedCount
      const nextPage = remain <= 0 && page > 0 ? page - 1 : page
      if (nextPage !== page) setPage(nextPage)
      await loadDocuments(selectedDb, selectedColl, nextPage, order)
    } catch (err) {
      toast.error(err)
    } finally {
      setLoadingDocs(false)
    }
  }

  const createIndex = async () => {
    if (!selectedDb || !selectedColl) return
    let keys: Record<string, unknown>
    try {
      const parsed = JSON.parse(indexKeysDraft) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        toast.error('索引字段必须是 JSON 对象，例如 {"createdAt":-1}')
        return
      }
      keys = parsed as Record<string, unknown>
    } catch {
      toast.error('索引字段不是合法 JSON')
      return
    }

    setCreatingIndex(true)
    try {
      const data = await api.createIndex(selectedDb, selectedColl, {
        keys,
        name: indexNameDraft.trim() || undefined,
        unique: indexUnique || undefined,
        sparse: indexSparse || undefined,
      })
      setIndexes(data.indexes)
      setIndexNameDraft('')
      toast.success(`索引已创建：${data.name}`)
    } catch (err) {
      toast.error(err)
    } finally {
      setCreatingIndex(false)
    }
  }

  const dropIndex = async (name: string) => {
    if (!selectedDb || !selectedColl) return
    if (name === '_id_') return
    const ok = await dialog.confirm({
      title: '删除索引',
      message: `确定删除索引「${name}」？`,
      confirmLabel: '删除索引',
      danger: true,
    })
    if (!ok) return

    setLoadingIndexes(true)
    try {
      const data = await api.dropIndex(selectedDb, selectedColl, name)
      setIndexes(data.indexes)
      toast.success(`已删除索引「${name}」`)
    } catch (err) {
      toast.error(err)
    } finally {
      setLoadingIndexes(false)
    }
  }

  const totalPages = docs ? Math.max(1, Math.ceil(docs.total / pageSize)) : 1

  return (
    <div
      className={`shell ${dragOver ? 'drag-over' : ''}`}
      onDragEnter={onShellDragEnter}
      onDragLeave={onShellDragLeave}
      onDragOver={onShellDragOver}
      onDrop={onShellDrop}
    >
      {dragOver && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">
            <strong>松开以导入备份</strong>
            <p>
              {selectedDb
                ? `将导入到数据库「${selectedDb}」`
                : '请先在左侧选中目标数据库'}
            </p>
            <p className="dim">支持 .zip / .gz / 宝塔 _bson_ 备份</p>
          </div>
        </div>
      )}
      <aside className="sidebar">
        <div className="brand">
          <h1>Leaf Desk</h1>
          <p>本地 MongoDB 浏览器 · 可拖入备份导入</p>
        </div>

        <div className="connect">
          <input
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            spellCheck={false}
            aria-label="连接字符串"
          />
          <div className="connect-actions">
            <button className="btn btn-primary" onClick={() => void connect()} disabled={loadingNav}>
              连接
            </button>
            <button className="btn btn-ghost" onClick={() => void loadDatabases()} disabled={loadingNav}>
              刷新
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => setImportHistoryOpen(true)}
              title="查看曾导入的备份归档位置"
            >
              导入记录
            </button>
          </div>
          <div className="status">
            <span className={`status-dot ${connected ? 'ok' : statusError ? 'err' : ''}`} />
            {connected ? '已连接' : statusError ? '未连接' : '连接中…'}
          </div>
          <div className="view-switch">
            <button
              type="button"
              className={`view-btn ${appView === 'browse' ? 'active' : ''}`}
              onClick={() => setAppView('browse')}
            >
              数据浏览
            </button>
            <button
              type="button"
              className={`view-btn ${appView === 'shell' ? 'active' : ''}`}
              onClick={() => setAppView('shell')}
              disabled={!connected}
            >
              mongosh
            </button>
          </div>
        </div>

        {connected && (
          <div className="nav-filter">
            <input
              value={collFilter}
              onChange={(e) => setCollFilter(e.target.value)}
              placeholder="搜索数据库或集合…"
              spellCheck={false}
              aria-label="搜索数据库或集合"
            />
            {collFilter.trim() && (
              <span className="nav-filter-meta">
                {sortedDatabases.length}/{databases.length}
              </span>
            )}
          </div>
        )}

        <div className="nav-scroll">
          <div className="nav-label">数据库</div>
          {databases.length === 0 && !loadingNav && (
            <p style={{ padding: '0.5rem', fontSize: '0.8rem', color: 'var(--sidebar-muted)' }}>
              {statusError || '暂无用户数据库'}
            </p>
          )}
          {databases.length > 0 && sortedDatabases.length === 0 && (
            <p style={{ padding: '0.5rem', fontSize: '0.8rem', color: 'var(--sidebar-muted)' }}>
              无匹配数据库
            </p>
          )}
          {sortedDatabases.map((db) => {
            const pinned = pinnedDbs.includes(db.name)
            return (
            <div key={db.name}>
              <div className={`db-row ${selectedDb === db.name ? 'active' : ''}`}>
                <button
                  className={`pin-btn ${pinned ? 'pinned' : ''}`}
                  type="button"
                  title={pinned ? '取消置顶' : '置顶'}
                  aria-label={pinned ? `取消置顶 ${db.name}` : `置顶 ${db.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    togglePinDb(db.name)
                  }}
                >
                  {pinned ? '★' : '☆'}
                </button>
                <button
                  className="db-item"
                  onClick={() => void selectDb(db.name)}
                >
                  <span className="db-name">{db.name}</span>
                  <span className="meta">{formatBytes(db.sizeOnDisk)}</span>
                </button>
              </div>
              {selectedDb === db.name && (
                <div className="coll-list">
                  <div className="db-io-actions">
                    <button
                      className="btn btn-ghost io-btn"
                      type="button"
                      disabled={ioBusy}
                      onClick={() => void exportDatabase(db.name)}
                    >
                      导出库
                    </button>
                    <button
                      className="btn btn-ghost io-btn"
                      type="button"
                      disabled={ioBusy}
                      onClick={() => importInputRef.current?.click()}
                      title="也可把备份文件拖进窗口"
                    >
                      导入库
                    </button>
                    <button
                      className="btn btn-ghost io-btn"
                      type="button"
                      onClick={() => setImportHistoryOpen(true)}
                    >
                      导入记录
                    </button>
                  </div>
                  {collections.length === 0 ? (
                    <p style={{ fontSize: '0.75rem', color: 'var(--sidebar-muted)', margin: '0.25rem 0' }}>
                      {loadingNav ? '加载中…' : '无集合'}
                    </p>
                  ) : sortedCollections.length === 0 ? (
                    <p style={{ fontSize: '0.75rem', color: 'var(--sidebar-muted)', margin: '0.25rem 0' }}>
                      无匹配集合
                    </p>
                  ) : (
                    sortedCollections.map((col) => {
                      const pinned = (pinnedColls[db.name] ?? []).includes(col.name)
                      return (
                        <div
                          key={col.name}
                          className={`coll-row ${selectedColl === col.name ? 'active' : ''}`}
                        >
                          <button
                            className={`pin-btn ${pinned ? 'pinned' : ''}`}
                            type="button"
                            title={pinned ? '取消置顶' : '置顶'}
                            aria-label={pinned ? `取消置顶 ${col.name}` : `置顶 ${col.name}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              togglePinColl(db.name, col.name)
                            }}
                          >
                            {pinned ? '★' : '☆'}
                          </button>
                          <button
                            className="coll-item"
                            onClick={() => void selectColl(col.name)}
                          >
                            <span className="coll-name">{col.name}</span>
                            <span className="meta">{col.count}</span>
                          </button>
                          <button
                            className="coll-del-btn"
                            type="button"
                            title={`删除集合 ${col.name}`}
                            aria-label={`删除集合 ${col.name}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              void dropCollection(db.name, col.name)
                            }}
                          >
                            ×
                          </button>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>
            )
          })}
        </div>
      </aside>

      <main className="main">
        {appView === 'shell' ? (
          <MongoshPanel db={selectedDb} onClose={() => setAppView('browse')} />
        ) : (
          <>
        <div className="toolbar">
          <div className="crumb">
            <h2>
              {selectedColl
                ? selectedColl
                : selectedDb
                  ? selectedDb
                  : '选择一个集合'}
            </h2>
            <p>
              {selectedDb && selectedColl
                ? mainTab === 'indexes'
                  ? `${selectedDb} · ${indexes.length} 个索引`
                  : `${selectedDb} · ${docs?.total ?? '…'} 条${activeQuery ? '（已筛选）' : ''} · 按 ${docs?.sortBy ?? 'createdAt/_id'} ${order === 'desc' ? '最新在前' : '最早在前'}`
                : selectedDb
                  ? '在左侧选择集合查看文档'
                  : '连接本地 MongoDB，浏览数据库与集合'}
            </p>
          </div>

          {selectedColl && (
            <div className="toolbar-actions">
              <div className="tabs">
                <button
                  className={`tab ${mainTab === 'docs' ? 'active' : ''}`}
                  onClick={() => setMainTab('docs')}
                >
                  文档
                </button>
                <button
                  className={`tab ${mainTab === 'indexes' ? 'active' : ''}`}
                  onClick={() => {
                    setMainTab('indexes')
                    if (selectedDb && selectedColl) {
                      void loadIndexes(selectedDb, selectedColl)
                    }
                  }}
                >
                  索引
                </button>
              </div>
              {mainTab === 'docs' && (
                <>
                  <select
                    className="select"
                    value={order}
                    onChange={(e) => void changeOrder(e.target.value as 'asc' | 'desc')}
                    aria-label="排序"
                  >
                    <option value="desc">创建时间 · 最新在前</option>
                    <option value="asc">创建时间 · 最早在前</option>
                  </select>
                  <button
                    className="btn btn-light"
                    disabled={loadingDocs}
                    onClick={() => {
                      if (selectedDb && selectedColl) {
                        void loadDocuments(selectedDb, selectedColl, page, order)
                      }
                    }}
                  >
                    刷新文档
                  </button>
                </>
              )}
              {mainTab === 'indexes' && (
                <button
                  className="btn btn-light"
                  disabled={loadingIndexes}
                  onClick={() => {
                    if (selectedDb && selectedColl) {
                      void loadIndexes(selectedDb, selectedColl)
                    }
                  }}
                >
                  刷新索引
                </button>
              )}
              <button
                className="btn btn-light"
                disabled={ioBusy || !selectedDb || !selectedColl}
                onClick={() => {
                  if (selectedDb && selectedColl) {
                    void exportCollection(selectedDb, selectedColl)
                  }
                }}
              >
                导出集合
              </button>
              <button
                className="btn btn-light"
                disabled={ioBusy || loadingNav || !selectedDb || !selectedColl}
                onClick={() => void clearCollection()}
              >
                清空集合
              </button>
              <button
                className="btn btn-danger"
                disabled={loadingNav || !selectedDb || !selectedColl}
                onClick={() => {
                  if (selectedDb && selectedColl) {
                    void dropCollection(selectedDb, selectedColl)
                  }
                }}
              >
                删除集合
              </button>
            </div>
          )}
        </div>

        <input
          ref={importInputRef}
          type="file"
          accept=".zip,.gz,.archive,application/zip,application/gzip,*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importDatabaseFromFile(file)
          }}
        />

        {selectedColl && mainTab === 'docs' && (
          <div className="query-panel">
            <div className="query-panel-head">
              <span className="query-label">查询条件</span>
              <div className="query-panel-actions">
                <button className="btn btn-light" type="button" onClick={addQueryRow}>
                  添加条件
                </button>
                <button
                  className="btn btn-light"
                  type="button"
                  title="快速添加 _id 条件"
                  onClick={addIdQueryRow}
                >
                  + _id
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={loadingDocs}
                  onClick={() => void runQuery()}
                >
                  查询
                </button>
                <button
                  className="btn btn-light"
                  type="button"
                  disabled={loadingDocs || bulkSaving}
                  title="按当前查询条件批量修改匹配的文档"
                  onClick={() => void openBulkUpdate()}
                >
                  按条件修改
                </button>
                <button
                  className="btn btn-light"
                  type="button"
                  disabled={loadingDocs || !activeQuery}
                  onClick={() => void clearQuery()}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="query-rows">
              {queryRows.map((row, index) => (
                <div className="query-row" key={row.id}>
                  <span className="query-row-index">{index + 1}</span>
                  <input
                    className="query-key"
                    value={row.key}
                    onChange={(e) => updateQueryRow(row.id, { key: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void runQuery()
                      }
                    }}
                    spellCheck={false}
                    placeholder="字段，如 _id / title"
                    aria-label={`条件 ${index + 1} 字段名`}
                  />
                  <span className="query-eq">=</span>
                  <input
                    className="query-value"
                    value={row.value}
                    onChange={(e) => updateQueryRow(row.id, { value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void runQuery()
                      }
                    }}
                    spellCheck={false}
                    placeholder={row.key === '_id' ? '粘贴 ObjectId' : '值 value'}
                    autoFocus={row.key === '_id' && !row.value}
                    aria-label={`条件 ${index + 1} 字段值`}
                  />
                  <button
                    className="btn btn-ghost-light"
                    type="button"
                    title="删除条件"
                    onClick={() => removeQueryRow(row.id)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="content">
          {ioBusy && (
            <div className="notice-box busy progress-box">
              <div className="progress-head">
                <strong>{ioLabel}</strong>
                <span>{ioElapsed}s</span>
              </div>
              <div className="progress-track" aria-hidden="true">
                <div className="progress-bar" />
              </div>
              <p>大库可能需要较长时间，请勿关闭页面…</p>
            </div>
          )}
          {!selectedColl && (
            <div className="empty">
              <h3>{selectedDb ? '选择集合' : '开始浏览'}</h3>
              <p>
                {selectedDb
                  ? '展开后的集合列表里点一下，就能按创建时间查看文档。'
                  : '左侧选数据库，再选集合。默认按创建时间降序，最新的排在最前。'}
              </p>
            </div>
          )}

          {selectedColl && mainTab === 'indexes' && (
            <div className="index-panel">
              <section className="index-create">
                <h3>创建索引</h3>
                <div className="index-form">
                  <label>
                    字段 keys
                    <input
                      value={indexKeysDraft}
                      onChange={(e) => setIndexKeysDraft(e.target.value)}
                      spellCheck={false}
                      placeholder='{"createdAt":-1}'
                    />
                  </label>
                  <label>
                    名称（可选）
                    <input
                      value={indexNameDraft}
                      onChange={(e) => setIndexNameDraft(e.target.value)}
                      spellCheck={false}
                      placeholder="自动生成"
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={indexUnique}
                      onChange={(e) => setIndexUnique(e.target.checked)}
                    />
                    unique
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={indexSparse}
                      onChange={(e) => setIndexSparse(e.target.checked)}
                    />
                    sparse
                  </label>
                  <button
                    className="btn btn-primary"
                    disabled={creatingIndex}
                    onClick={() => void createIndex()}
                  >
                    {creatingIndex ? '创建中…' : '创建'}
                  </button>
                </div>
                <p className="index-hint">
                  例：{`{"createdAt":-1}`}、{`{"userId":1,"createdAt":-1}`}。1 升序，-1 降序。
                </p>
              </section>

              <section className="index-list-wrap">
                <h3>当前索引 {loadingIndexes ? '…' : `(${indexes.length})`}</h3>
                {indexes.length === 0 && !loadingIndexes ? (
                  <div className="empty">
                    <h3>暂无索引</h3>
                    <p>这个集合还没有索引信息。</p>
                  </div>
                ) : (
                  <div className="index-list">
                    {indexes.map((idx) => (
                      <article className="index-card" key={idx.name}>
                        <div className="index-card-head">
                          <div>
                            <strong>{idx.name}</strong>
                            <div className="index-tags">
                              {idx.unique && <span className="tag">unique</span>}
                              {idx.sparse && <span className="tag">sparse</span>}
                              {idx.expireAfterSeconds != null && (
                                <span className="tag">ttl:{idx.expireAfterSeconds}s</span>
                              )}
                              {idx.name === '_id_' && <span className="tag">默认</span>}
                            </div>
                          </div>
                          <button
                            className="btn btn-danger"
                            disabled={idx.name === '_id_' || loadingIndexes}
                            title={idx.name === '_id_' ? '不能删除默认 _id 索引' : '删除索引'}
                            onClick={() => void dropIndex(idx.name)}
                          >
                            删除
                          </button>
                        </div>
                        <pre className="index-keys">{JSON.stringify(idx.key, null, 2)}</pre>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {selectedColl && mainTab === 'docs' && loadingDocs && !docs && (
            <div className="loading">
              <h3>加载文档</h3>
              <p>正在按创建时间排序拉取数据…</p>
            </div>
          )}

          {selectedColl && mainTab === 'docs' && docs && (
            <>
              {docs.documents.length > 0 && (
                <div className="batch-bar">
                  <label className="batch-check">
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={toggleSelectAllOnPage}
                    />
                    本页全选
                  </label>
                  <span className="batch-meta">
                    已选 {selectedDocIds.length} 条
                  </span>
                  <button
                    className="btn btn-light"
                    type="button"
                    disabled={selectedDocIds.length === 0}
                    onClick={() => setSelectedDocIds([])}
                  >
                    清空选择
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={loadingDocs || selectedDocIds.length === 0}
                    onClick={() => void bulkDeleteDocuments()}
                  >
                    批量删除
                  </button>
                </div>
              )}
              <div className="doc-list">
                {docs.documents.length === 0 ? (
                  <div className="empty">
                    <h3>{activeQuery ? '没有匹配结果' : '集合为空'}</h3>
                    <p>
                      {activeQuery
                        ? '当前查询条件下没有文档，可调整条件后重试。'
                        : '这个集合里还没有文档。'}
                    </p>
                  </div>
                ) : (
                  docs.documents.map((doc, i) => {
                    const id = getDocId(doc)
                    const time = getCreatedHint(doc)
                    const checked = selectedDocIds.includes(id)
                    return (
                      <article
                        className={`doc-card ${checked ? 'selected' : ''}`}
                        key={id + String(i)}
                        style={{ animationDelay: `${Math.min(i, 12) * 20}ms` }}
                      >
                        <div className="doc-head">
                          <label className="doc-select">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={id === '—'}
                              onChange={() => toggleDocSelected(id)}
                            />
                            <span className="doc-id">_id: {id}</span>
                          </label>
                          <div className="doc-head-actions">
                            {time && <span className="doc-time">{time}</span>}
                            <button
                              className="btn btn-light doc-edit-btn"
                              type="button"
                              disabled={loadingDocs || savingDoc || id === '—'}
                              title="编辑这条文档"
                              onClick={() => setEditingDoc(doc)}
                            >
                              编辑
                            </button>
                            <button
                              className="btn btn-danger doc-del-btn"
                              type="button"
                              disabled={loadingDocs || id === '—'}
                              title="删除这条文档"
                              onClick={() => void deleteDocument(id)}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                        <JsonView value={doc} />
                      </article>
                    )
                  })
                )}
              </div>

              {docs.total > pageSize && (
                <div className="pager">
                  <button
                    className="btn btn-light"
                    disabled={page <= 0 || loadingDocs}
                    onClick={() => void goPage(page - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    className="btn btn-light"
                    disabled={page + 1 >= totalPages || loadingDocs}
                    onClick={() => void goPage(page + 1)}
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </div>
          </>
        )}
      </main>

      {editingDoc && (
        <DocEditModal
          docId={getDocId(editingDoc)}
          initialDoc={editingDoc}
          saving={savingDoc}
          onClose={() => {
            if (!savingDoc) setEditingDoc(null)
          }}
          onSave={(document) => void saveDocument(document)}
        />
      )}

      {bulkUpdateOpen && selectedDb && selectedColl && (
        <BulkUpdateModal
          db={selectedDb}
          coll={selectedColl}
          filterJson={bulkFilterJson}
          matchCount={bulkMatchCount}
          counting={bulkCounting}
          saving={bulkSaving}
          onClose={() => {
            if (!bulkSaving) setBulkUpdateOpen(false)
          }}
          onSave={(payload) => void runBulkUpdate(payload)}
        />
      )}

      <ImportHistoryModal
        open={importHistoryOpen}
        onClose={() => setImportHistoryOpen(false)}
      />
    </div>
  )
}
