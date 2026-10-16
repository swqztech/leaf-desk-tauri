import cors from 'cors'
import express from 'express'
import { existsSync } from 'fs'
import { MongoClient, ObjectId, type Document, type Sort } from 'mongodb'
import {
  archiveImportFile,
  clearImportHistory,
  deleteImportHistory,
  importsDir,
  listImportHistory,
  resolveArchivedPath,
  type ImportHistoryItem,
} from './importHistory'
import {
  dumpCollectionToFile,
  dumpDatabaseToFile,
  parseSourceDbFromFileName,
  restoreDatabaseFromBuffer,
} from './mongoTools'
import { runMongoshScript } from './mongoshRunner'

const DEFAULT_PORT = 3001
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017'

const app = express()
app.use(cors())

let client: MongoClient | null = null
let currentUri = DEFAULT_URI

function readPort(fallback = DEFAULT_PORT) {
  const n = Number(process.env.PORT || fallback)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function readHost(fallback = DEFAULT_HOST) {
  return process.env.HOST || fallback
}
/** 串行化连接操作，避免并发 close/connect 把 client 置空 */
let gate: Promise<void> = Promise.resolve()

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = gate.then(fn, fn)
  gate = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function serializeValue(value: unknown): unknown {
  if (value instanceof ObjectId) {
    return { $oid: value.toHexString() }
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() }
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v)
    }
    return out
  }
  return value
}

function serializeDocs(docs: Document[]) {
  return docs.map((doc) => serializeValue(doc))
}

/** 把扩展 JSON / 常见写法还原成 Mongo 可查询类型 */
function reviveFilterValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reviveFilterValue(item))
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$oid === 'string' && Object.keys(obj).length === 1) {
      if (!ObjectId.isValid(obj.$oid)) {
        throw new Error(`无效 ObjectId: ${obj.$oid}`)
      }
      return new ObjectId(obj.$oid)
    }
    if (typeof obj.$date === 'string' && Object.keys(obj).length === 1) {
      const d = new Date(obj.$date)
      if (Number.isNaN(d.getTime())) {
        throw new Error(`无效日期: ${obj.$date}`)
      }
      return d
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = reviveFilterValue(v, k)
    }
    return out
  }
  if (
    key === '_id' &&
    typeof value === 'string' &&
    /^[a-f0-9]{24}$/i.test(value)
  ) {
    return new ObjectId(value)
  }
  return value
}

function parseFilter(raw: string): Document {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('查询条件不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('查询条件必须是 JSON 对象，例如 {"title":"示例"}')
  }
  return reviveFilterValue(parsed) as Document
}

async function closeClient() {
  if (!client) return
  const old = client
  client = null
  try {
    await old.close()
  } catch {
    // 忽略关闭异常
  }
}

async function ensureClient(uri: string = currentUri): Promise<MongoClient> {
  return runExclusive(async () => {
    if (client && currentUri === uri) {
      try {
        await client.db('admin').command({ ping: 1 })
        return client
      } catch {
        await closeClient()
      }
    }

    if (client) {
      await closeClient()
    }

    currentUri = uri
    const next = new MongoClient(uri)
    await next.connect()
    client = next
    return next
  })
}

// 导入必须在 express.json 之前注册，并用 raw 接收宝塔 bson 备份文件
app.post(
  '/api/databases/:db/import',
  express.raw({ type: () => true, limit: '1024mb' }),
  async (req, res) => {
    const started = Date.now()
    const dbName = req.params.db
    const mode = req.query.mode === 'merge' ? 'merge' : 'replace'
    const fileName =
      typeof req.query.filename === 'string' ? req.query.filename : ''
    const sourcePath =
      typeof req.query.sourcePath === 'string' ? req.query.sourcePath : ''
    const buf = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body ?? '')

    try {
      if (!dbName) {
        res.status(400).json({ error: '缺少数据库名' })
        return
      }

      if (!buf.length) {
        res.status(400).json({ error: '导入内容为空' })
        return
      }

      await ensureClient()
      const sourceDb =
        parseSourceDbFromFileName(fileName) ||
        (typeof req.query.sourceDb === 'string' ? req.query.sourceDb : null)

      const result = await restoreDatabaseFromBuffer(
        currentUri,
        dbName,
        buf,
        mode,
        sourceDb,
      )
      const history = archiveImportFile(buf, {
        targetDb: dbName,
        sourceFileName: fileName,
        sourcePath,
        mode,
        format: result.format || 'unknown',
        ok: true,
        durationMs: Date.now() - started,
      })
      res.json({ ...result, history })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 失败也归档一份，方便排查「当时导的是哪个文件」
      let history: ImportHistoryItem | undefined
      if (buf.length && dbName) {
        try {
          history = archiveImportFile(buf, {
            targetDb: dbName,
            sourceFileName: fileName || 'unknown.zip',
            sourcePath,
            mode,
            format: 'failed',
            ok: false,
            error: message,
            durationMs: Date.now() - started,
          })
        } catch {
          // ignore archive failure
        }
      }
      res.status(500).json({ error: message, history })
    }
  },
)

app.get('/api/import-history', (_req, res) => {
  try {
    const items = listImportHistory().map((item) => {
      const archivedPath = resolveArchivedPath(item)
      return {
        ...item,
        archivedPath,
        archivedExists: Boolean(archivedPath && existsSync(archivedPath)),
      }
    })
    res.json({ items, importsDir: importsDir() })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.delete('/api/import-history/:id', (req, res) => {
  try {
    const removeFile = req.query.removeFile !== '0' && req.query.removeFile !== 'false'
    const result = deleteImportHistory(req.params.id || '', removeFile)
    if (!result.ok) {
      res.status(404).json({ error: '记录不存在' })
      return
    }
    res.json({ ok: true, removedFile: result.removedFile })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.delete('/api/import-history', (req, res) => {
  try {
    const removeFiles = req.query.removeFiles !== '0' && req.query.removeFiles !== 'false'
    const count = clearImportHistory(removeFiles)
    res.json({ ok: true, count })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.use(express.json({ limit: '32mb' }))

app.post('/api/mongosh', async (req, res) => {
  try {
    const script =
      typeof req.body?.script === 'string' ? req.body.script : ''
    const db =
      typeof req.body?.db === 'string' && req.body.db.trim()
        ? req.body.db.trim()
        : null

    await ensureClient()
    const result = await runMongoshScript({
      uri: currentUri,
      db,
      script,
    })

    res.status(result.ok ? 200 : 400).json(result)
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    })
  }
})

app.get('/api/health', async (_req, res) => {
  try {
    const c = await ensureClient()
    await c.db('admin').command({ ping: 1 })
    res.json({ ok: true, uri: currentUri })
  } catch (err) {
    res.status(503).json({
      ok: false,
      uri: currentUri,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.post('/api/connect', async (req, res) => {
  const uri =
    typeof req.body?.uri === 'string' && req.body.uri.trim()
      ? req.body.uri.trim()
      : DEFAULT_URI

  try {
    await ensureClient(uri)
    res.json({ ok: true, uri: currentUri })
  } catch (err) {
    await closeClient()
    res.status(503).json({
      ok: false,
      uri: currentUri,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.get('/api/databases', async (_req, res) => {
  try {
    const c = await ensureClient()
    const { databases } = await c.db().admin().listDatabases()
    const list = databases
      .filter((db) => !['admin', 'local', 'config'].includes(db.name))
      .map((db) => ({
        name: db.name,
        sizeOnDisk: db.sizeOnDisk ?? 0,
        empty: Boolean(db.empty),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    res.json({ databases: list })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.get('/api/databases/:db/collections', async (req, res) => {
  try {
    const c = await ensureClient()
    const db = c.db(req.params.db)
    const collections = await db.listCollections().toArray()
    const list = await Promise.all(
      collections.map(async (col) => {
        const count = await db.collection(col.name).estimatedDocumentCount()
        return { name: col.name, count, type: col.type ?? 'collection' }
      }),
    )
    list.sort((a, b) => a.name.localeCompare(b.name))
    res.json({ collections: list })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.delete('/api/databases/:db/collections/:coll', async (req, res) => {
  try {
    const dbName = req.params.db
    const collName = req.params.coll
    if (!dbName || !collName) {
      res.status(400).json({ error: '缺少数据库或集合名' })
      return
    }

    const c = await ensureClient()
    const db = c.db(dbName)
    const exists = await db.listCollections({ name: collName }).hasNext()
    if (!exists) {
      res.status(404).json({ error: `集合不存在: ${collName}` })
      return
    }

    await db.collection(collName).drop()
    res.json({ ok: true, db: dbName, collection: collName })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.post('/api/databases/:db/collections/:coll/clear', async (req, res) => {
  try {
    const dbName = req.params.db
    const collName = req.params.coll
    if (!dbName || !collName) {
      res.status(400).json({ error: '缺少数据库或集合名' })
      return
    }

    const c = await ensureClient()
    const db = c.db(dbName)
    const exists = await db.listCollections({ name: collName }).hasNext()
    if (!exists) {
      res.status(404).json({ error: `集合不存在: ${collName}` })
      return
    }

    const result = await db.collection(collName).deleteMany({})
    res.json({
      ok: true,
      db: dbName,
      collection: collName,
      deletedCount: result.deletedCount,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.get('/api/databases/:db/collections/:coll/documents', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    const skip = Math.max(Number(req.query.skip) || 0, 0)
    // createdAt 优先；没有则按 _id（ObjectId 含创建时间）
    const sortBy = req.query.sortBy === '_id' ? '_id' : 'createdAt'
    const order = req.query.order === 'asc' ? 1 : -1

    let filter: Document = {}
    const filterRaw = req.query.filter
    if (typeof filterRaw === 'string' && filterRaw.trim()) {
      try {
        filter = parseFilter(filterRaw)
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
    }

    const c = await ensureClient()
    const collection = c.db(req.params.db).collection(req.params.coll)

    let sort: Sort
    let usedSort: string

    if (sortBy === 'createdAt') {
      const sample = await collection.findOne(
        { ...filter, createdAt: { $exists: true } },
        { projection: { _id: 1 } },
      )
      if (sample) {
        sort = { createdAt: order, _id: order }
        usedSort = 'createdAt'
      } else {
        sort = { _id: order }
        usedSort = '_id'
      }
    } else {
      sort = { _id: order }
      usedSort = '_id'
    }

    const hasFilter = Object.keys(filter).length > 0
    const [documents, total] = await Promise.all([
      collection.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
      hasFilter
        ? collection.countDocuments(filter)
        : collection.estimatedDocumentCount(),
    ])

    res.json({
      documents: serializeDocs(documents),
      total,
      skip,
      limit,
      sortBy: usedSort,
      order: order === -1 ? 'desc' : 'asc',
      filter,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

function parseDocumentId(raw: string): unknown {
  const id = decodeURIComponent(raw)
  if (ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id)) {
    return new ObjectId(id)
  }
  if (/^-?\d+$/.test(id)) {
    const n = Number(id)
    if (Number.isSafeInteger(n)) return n
  }
  if (id === 'true') return true
  if (id === 'false') return false
  return id
}

app.delete(
  '/api/databases/:db/collections/:coll/documents/:id',
  async (req, res) => {
    try {
      const idRaw = req.params.id
      if (!idRaw) {
        res.status(400).json({ error: '缺少文档 _id' })
        return
      }

      const c = await ensureClient()
      const collection = c.db(req.params.db).collection(req.params.coll)
      const _id = parseDocumentId(idRaw)
      const result = await collection.deleteOne({ _id } as Document)

      if (result.deletedCount === 0) {
        res.status(404).json({ error: `未找到文档 _id=${idRaw}` })
        return
      }

      res.json({ ok: true, deletedId: idRaw, deletedCount: result.deletedCount })
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
)

/** 整文档替换（_id 以 URL 为准，不可改） */
app.put(
  '/api/databases/:db/collections/:coll/documents/:id',
  async (req, res) => {
    try {
      const idRaw = req.params.id
      if (!idRaw) {
        res.status(400).json({ error: '缺少文档 _id' })
        return
      }

      const body = req.body?.document ?? req.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ error: '请求体必须是 JSON 文档对象' })
        return
      }

      let document: Document
      try {
        document = reviveFilterValue(body) as Document
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }

      const _id = parseDocumentId(idRaw)
      // _id 以 URL 为准，防止编辑时误改主键
      document = { ...document, _id }

      const c = await ensureClient()
      const collection = c.db(req.params.db).collection(req.params.coll)
      const result = await collection.replaceOne({ _id } as Document, document)

      if (result.matchedCount === 0) {
        res.status(404).json({ error: `未找到文档 _id=${idRaw}` })
        return
      }

      const saved = await collection.findOne({ _id } as Document)
      res.json({
        ok: true,
        modifiedCount: result.modifiedCount,
        document: serializeValue(saved),
      })
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
)

/** 按条件批量更新（updateMany） */
app.post(
  '/api/databases/:db/collections/:coll/documents/bulk-update',
  async (req, res) => {
    try {
      const allowEmptyFilter = Boolean(req.body?.allowEmptyFilter)
      let filter: Document = {}
      const filterRaw = req.body?.filter

      if (typeof filterRaw === 'string' && filterRaw.trim()) {
        filter = parseFilter(filterRaw)
      } else if (
        filterRaw &&
        typeof filterRaw === 'object' &&
        !Array.isArray(filterRaw)
      ) {
        filter = reviveFilterValue(filterRaw) as Document
      } else if (filterRaw != null) {
        res.status(400).json({ error: 'filter 必须是 JSON 对象' })
        return
      }

      if (Object.keys(filter).length === 0 && !allowEmptyFilter) {
        res.status(400).json({
          error:
            '查询条件为空会修改整个集合。若确需如此，请勾选「确认修改全部文档」',
        })
        return
      }

      const updateRaw = req.body?.update
      if (
        !updateRaw ||
        typeof updateRaw !== 'object' ||
        Array.isArray(updateRaw)
      ) {
        res.status(400).json({ error: 'update 必须是 JSON 对象' })
        return
      }

      let updateDoc = reviveFilterValue(updateRaw) as Document
      const keys = Object.keys(updateDoc)
      if (keys.length === 0) {
        res.status(400).json({ error: '请至少提供一个要修改的字段或更新操作符' })
        return
      }

      const hasOperator = keys.some((k) => k.startsWith('$'))
      const allOperators = keys.every((k) => k.startsWith('$'))
      if (hasOperator && !allOperators) {
        res.status(400).json({
          error: '不能混用更新操作符（$set 等）与普通字段，请统一写法',
        })
        return
      }
      if (!hasOperator) {
        if ('_id' in updateDoc) {
          res.status(400).json({ error: '不能通过批量更新修改 _id' })
          return
        }
        updateDoc = { $set: updateDoc }
      } else {
        const setDoc = updateDoc.$set
        if (
          setDoc &&
          typeof setDoc === 'object' &&
          !Array.isArray(setDoc) &&
          '_id' in (setDoc as Document)
        ) {
          res.status(400).json({ error: '不能通过 $set 修改 _id' })
          return
        }
      }

      const c = await ensureClient()
      const collection = c.db(req.params.db).collection(req.params.coll)
      const matchedCount = await collection.countDocuments(filter)
      if (matchedCount === 0) {
        res.json({
          ok: true,
          matchedCount: 0,
          modifiedCount: 0,
          filter,
          update: updateDoc,
        })
        return
      }

      const result = await collection.updateMany(filter, updateDoc)
      res.json({
        ok: true,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        filter,
        update: serializeValue(updateDoc),
      })
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
)

app.post(
  '/api/databases/:db/collections/:coll/documents/bulk-delete',
  async (req, res) => {
    try {
      const idsRaw = req.body?.ids
      if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
        res.status(400).json({ error: '请提供要删除的 ids 数组' })
        return
      }
      if (idsRaw.length > 500) {
        res.status(400).json({ error: '单次最多删除 500 条' })
        return
      }

      const ids = idsRaw
        .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
        .map((id) => parseDocumentId(id))

      if (ids.length === 0) {
        res.status(400).json({ error: '没有有效的 _id' })
        return
      }

      const c = await ensureClient()
      const collection = c.db(req.params.db).collection(req.params.coll)
      const result = await collection.deleteMany({
        _id: { $in: ids },
      } as Document)

      res.json({
        ok: true,
        requested: ids.length,
        deletedCount: result.deletedCount,
      })
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
)

app.get('/api/databases/:db/collections/:coll/indexes', async (req, res) => {
  try {
    const c = await ensureClient()
    const indexes = await c
      .db(req.params.db)
      .collection(req.params.coll)
      .indexes()

    res.json({
      indexes: indexes.map((idx) => ({
        name: idx.name,
        key: idx.key,
        unique: Boolean(idx.unique),
        sparse: Boolean(idx.sparse),
        expireAfterSeconds: idx.expireAfterSeconds,
        partialFilterExpression: idx.partialFilterExpression,
        collated: Boolean(idx.collation),
      })),
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.post('/api/databases/:db/collections/:coll/indexes', async (req, res) => {
  try {
    const keysRaw = req.body?.keys
    if (!keysRaw || typeof keysRaw !== 'object' || Array.isArray(keysRaw)) {
      res.status(400).json({ error: '请提供 keys 对象，例如 {"createdAt":-1}' })
      return
    }

    const keys = keysRaw as Document
    const entries = Object.entries(keys)
    if (entries.length === 0) {
      res.status(400).json({ error: 'keys 不能为空' })
      return
    }
    for (const [field, dir] of entries) {
      if (!field.trim()) {
        res.status(400).json({ error: '字段名不能为空' })
        return
      }
      if (dir !== 1 && dir !== -1 && dir !== 'text' && dir !== 'hashed') {
        res.status(400).json({
          error: `字段 ${field} 的方向无效，请用 1 / -1 / "text" / "hashed"`,
        })
        return
      }
    }

    const options: Document = {}
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      options.name = req.body.name.trim()
    }
    if (req.body?.unique) options.unique = true
    if (req.body?.sparse) options.sparse = true
    if (
      req.body?.expireAfterSeconds !== undefined &&
      req.body?.expireAfterSeconds !== null &&
      req.body?.expireAfterSeconds !== ''
    ) {
      const ttl = Number(req.body.expireAfterSeconds)
      if (!Number.isFinite(ttl) || ttl < 0) {
        res.status(400).json({ error: 'expireAfterSeconds 必须是非负数字' })
        return
      }
      options.expireAfterSeconds = ttl
    }

    const c = await ensureClient()
    const collection = c.db(req.params.db).collection(req.params.coll)
    const name = await collection.createIndex(keys, options)
    const indexes = await collection.indexes()

    res.json({
      ok: true,
      name,
      indexes: indexes.map((idx) => ({
        name: idx.name,
        key: idx.key,
        unique: Boolean(idx.unique),
        sparse: Boolean(idx.sparse),
        expireAfterSeconds: idx.expireAfterSeconds,
        partialFilterExpression: idx.partialFilterExpression,
        collated: Boolean(idx.collation),
      })),
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.delete(
  '/api/databases/:db/collections/:coll/indexes/:name',
  async (req, res) => {
    try {
      const indexName = req.params.name
      if (!indexName) {
        res.status(400).json({ error: '缺少索引名' })
        return
      }
      if (indexName === '_id_') {
        res.status(400).json({ error: '不能删除默认 _id 索引' })
        return
      }

      const c = await ensureClient()
      const collection = c.db(req.params.db).collection(req.params.coll)
      await collection.dropIndex(indexName)
      const indexes = await collection.indexes()

      res.json({
        ok: true,
        indexes: indexes.map((idx) => ({
          name: idx.name,
          key: idx.key,
          unique: Boolean(idx.unique),
          sparse: Boolean(idx.sparse),
          expireAfterSeconds: idx.expireAfterSeconds,
          partialFilterExpression: idx.partialFilterExpression,
          collated: Boolean(idx.collation),
        })),
      })
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
)

app.get('/api/databases/:db/export', async (req, res) => {
  try {
    const dbName = req.params.db
    if (!dbName) {
      res.status(400).json({ error: '缺少数据库名' })
      return
    }

    await ensureClient()
    const file = await dumpDatabaseToFile(currentUri, dbName)
    res.setHeader('Content-Type', file.contentType)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.fileName)}"`,
    )
    res.send(file.data)
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.get('/api/databases/:db/collections/:coll/export', async (req, res) => {
  try {
    const dbName = req.params.db
    const collName = req.params.coll
    if (!dbName || !collName) {
      res.status(400).json({ error: '缺少数据库或集合名' })
      return
    }

    await ensureClient()
    const file = await dumpCollectionToFile(currentUri, dbName, collName)
    res.setHeader('Content-Type', file.contentType)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.fileName)}"`,
    )
    res.send(file.data)
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) {
    next()
    return
  }
  const anyErr = err as { type?: string; status?: number; message?: string }
  if (anyErr.type === 'entity.too.large') {
    res.status(413).json({ error: '导入文件过大（上限约 1GB）' })
    return
  }
  res.status(anyErr.status || 500).json({
    error: anyErr.message || String(err),
  })
})

export const API_PORT = readPort()

export function startServer(opts?: { host?: string; port?: number }): Promise<void> {
  // 桌面默认只绑本机；网页版传入 0.0.0.0 或通过 HOST/PORT 环境变量
  const host = opts?.host ?? readHost(DEFAULT_HOST)
  const port = opts?.port ?? readPort(DEFAULT_PORT)

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`[mongodb] http://${host}:${port}`)
      console.log(`[mongodb] 默认 URI → ${currentUri}`)
      resolve()
    })
    server.on('error', reject)
  })
}

let staticReady = false

export function attachRendererStatic(distPath: string) {
  if (staticReady) return
  staticReady = true
  app.use(express.static(distPath))
  // 未匹配的 /api 必须回 JSON，避免被 SPA 的 index.html 吞掉导致前端「响应不是 JSON」
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在' })
  })
  app.get(/.*/, (_req, res) => {
    res.sendFile('index.html', { root: distPath })
  })
}

