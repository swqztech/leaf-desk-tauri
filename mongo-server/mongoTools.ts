import { execFile } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

const execFileAsync = promisify(execFile)

/** 打包后的 server.cjs 与开发时 mongo-server 根目录 */
function apiRuntimeRoots(): string[] {
  const roots: string[] = []
  if (typeof __dirname === 'string') {
    roots.push(__dirname)
    roots.push(path.join(__dirname, '..'))
  }
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url))
    roots.push(moduleDir)
    roots.push(path.join(moduleDir, '..'))
  } catch {
    // CJS bundle 无 import.meta
  }
  return [...new Set(roots)]
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/** 宝塔风格文件名：db_bson_YYYY-MM-DD_HH-MM-SS_mc.zip */
export function btBackupFileName(db: string, coll?: string) {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  if (coll) return `${db}_${coll}_bson_${stamp}_mc.zip`
  return `${db}_bson_${stamp}_mc.zip`
}

/** 1Panel 风格文件名：库名_YYYYMMDDHHmmss + 5 位随机.gz */
export function onePanelBackupFileName(db: string, coll?: string) {
  const d = new Date()
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 5; i++) suffix += alphabet[randomInt(alphabet.length)]
  const prefix = coll ? `${db}_${coll}` : db
  return `${prefix}_${stamp}${suffix}.gz`
}

function validDbName(name: string | undefined | null) {
  return !!name && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)
}

/** 从宝塔或 1Panel 备份文件名解析源库名 */
export function parseSourceDbFromFileName(fileName: string) {
  const base = path.basename(fileName).replace(/\.(zip|gz|gzip|archive)$/i, '')
  const baota = base.match(/^(.+)_bson_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/)
  if (validDbName(baota?.[1])) return baota![1]
  // 例如 wallet_20261111022547w0uov
  const onePanel = base.match(/^(.+)_(\d{14})([A-Za-z0-9]{3,8})?$/)
  if (validDbName(onePanel?.[1])) return onePanel![1]
  return null
}

/** 从 mongodump --gzip --archive 的文件头读出库名 */
export function readArchiveDbName(fileBuf: Buffer): Promise<string | null> {
  if (!looksLikeGzip(fileBuf)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const gunzip = zlib.createGunzip()
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (name: string | null) => {
      if (settled) return
      settled = true
      gunzip.destroy()
      resolve(name)
    }
    gunzip.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      if (size >= 8192) finish(extractDbFromPrelude(Buffer.concat(chunks)))
    })
    gunzip.on('end', () => finish(extractDbFromPrelude(Buffer.concat(chunks))))
    gunzip.on('error', () => {
      if (chunks.length) finish(extractDbFromPrelude(Buffer.concat(chunks)))
      else finish(null)
    })
    gunzip.end(fileBuf.subarray(0, Math.min(fileBuf.length, 512 * 1024)))
  })
}

function extractDbFromPrelude(buf: Buffer) {
  const key = Buffer.from('db\0')
  let from = 0
  while (from < buf.length - 8) {
    const idx = buf.indexOf(key, from)
    if (idx <= 0) return null
    if (buf[idx - 1] !== 0x02) {
      from = idx + 1
      continue
    }
    const len = buf.readInt32LE(idx + key.length)
    if (len < 2 || len > 80 || idx + key.length + 4 + len > buf.length) {
      from = idx + 1
      continue
    }
    const name = buf
      .subarray(idx + key.length + 4, idx + key.length + 4 + len - 1)
      .toString('utf8')
    if (validDbName(name)) return name
    from = idx + 1
  }
  return null
}

async function pathIfExists(filePath: string) {
  try {
    await fs.access(filePath)
    return filePath
  } catch {
    return null
  }
}

export async function resolveMongoTool(tool: 'mongodump' | 'mongorestore') {
  const exeName = process.platform === 'win32' ? `${tool}.exe` : tool
  const candidates: string[] = []

  if (process.env.MONGO_TOOLS_DIR) {
    candidates.push(path.join(process.env.MONGO_TOOLS_DIR, exeName))
  }
  for (const root of apiRuntimeRoots()) {
    candidates.push(path.join(root, 'tools', 'bin', exeName))
    candidates.push(path.join(root, 'tools', exeName))
  }
  candidates.push(path.join(process.cwd(), 'tools', 'bin', exeName))
  candidates.push(path.join(process.cwd(), 'tools', exeName))

  const home = os.homedir()
  candidates.push(
    path.join(
      home,
      'Downloads',
      'mongodb-database-tools-windows-x86_64-100.16.0',
      'bin',
      exeName,
    ),
  )
  if (process.platform === 'win32') {
    candidates.push(
      path.join('C:\\Program Files\\MongoDB\\Tools\\100\\bin', exeName),
      path.join('C:\\mongodb\\bin', exeName),
    )
  }

  for (const item of candidates) {
    const hit = await pathIfExists(item)
    if (hit) return hit
  }

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(cmd, [tool], { windowsHide: true })
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (first) return first
  } catch {
    // ignore
  }

  throw new Error(
    `未找到 ${tool}。请重新执行 npm run build:api 以内置 Database Tools，或安装 MongoDB Database Tools 并设置环境变量 MONGO_TOOLS_DIR 指向其 bin 目录`,
  )
}

async function runTool(bin: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { stdout, stderr }
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(e.stderr || e.message || String(err))
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leaf-desk-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function psQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

/** 把目录打成 zip（根目录含库名文件夹，兼容宝塔 mongorestore） */
async function zipDirectory(sourceDir: string, zipPath: string) {
  if (existsSync(zipPath)) {
    await fs.rm(zipPath, { force: true })
  }

  if (process.platform === 'win32') {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          `$src = ${psQuote(sourceDir)}`,
          `$dst = ${psQuote(zipPath)}`,
          `if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }`,
          `Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dst -CompressionLevel Optimal`,
        ].join('; '),
      ],
      { windowsHide: true },
    )
    return
  }

  try {
    await execFileAsync('zip', ['-r', '-q', zipPath, '.'], {
      cwd: sourceDir,
      windowsHide: true,
    })
    return
  } catch {
    // fallback python
  }

  const outBase = zipPath.replace(/\.zip$/i, '')
  await execFileAsync(
    'python3',
    [
      '-c',
      `import shutil; shutil.make_archive(${JSON.stringify(outBase)}, "zip", ${JSON.stringify(sourceDir)})`,
    ],
    { windowsHide: true },
  )
}

async function unzipToDirectory(zipPath: string, outDir: string) {
  await fs.mkdir(outDir, { recursive: true })
  if (process.platform === 'win32') {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(outDir)} -Force`,
      ],
      { windowsHide: true },
    )
    return
  }
  await execFileAsync('unzip', ['-q', zipPath, '-d', outDir], {
    windowsHide: true,
  })
}

function looksLikeGzip(buf: Buffer) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
}

function looksLikeZip(buf: Buffer) {
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b
}

async function findDumpRoot(extractDir: string): Promise<string> {
  const entries = await fs.readdir(extractDir, { withFileTypes: true })
  if (entries.some((e) => e.isFile() && e.name.endsWith('.bson'))) {
    return extractDir
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = path.join(extractDir, entry.name)
    const childEntries = await fs.readdir(child)
    if (childEntries.some((name) => name.endsWith('.bson'))) {
      return extractDir
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    return findDumpRoot(path.join(extractDir, entry.name))
  }

  return extractDir
}

export type BackupFormat = 'baota' | '1panel'

/**
 * 导出数据库。
 * baota：zip，里面是 {库名}/*.bson，面板能直接恢复。
 * 1panel：mongodump --gzip --archive，文件名像 wallet_20261111022547w0uov.gz。
 */
export async function dumpDatabaseToFile(
  uri: string,
  db: string,
  format: BackupFormat = 'baota',
) {
  const mongodump = await resolveMongoTool('mongodump')
  if (format === '1panel') {
    return withTempDir(async (dir) => {
      const fileName = onePanelBackupFileName(db)
      const archivePath = path.join(dir, fileName)
      await runTool(mongodump, [
        '--uri',
        uri,
        '--db',
        db,
        '--gzip',
        `--archive=${archivePath}`,
      ])
      const data = await fs.readFile(archivePath)
      if (!looksLikeGzip(data)) {
        throw new Error('打包 1Panel 备份失败：生成文件不是 gzip')
      }
      return { fileName, data, contentType: 'application/gzip' }
    })
  }
  return withTempDir(async (dir) => {
    const dumpRoot = path.join(dir, 'dump')
    await fs.mkdir(dumpRoot, { recursive: true })
    await runTool(mongodump, ['--uri', uri, '--db', db, '--out', dumpRoot])

    const dbDir = path.join(dumpRoot, db)
    if (!existsSync(dbDir)) {
      throw new Error(`mongodump 未生成数据库目录：${db}`)
    }

    const fileName = btBackupFileName(db)
    const zipPath = path.join(dir, fileName)
    await zipDirectory(dumpRoot, zipPath)
    const data = await fs.readFile(zipPath)
    if (!looksLikeZip(data)) {
      throw new Error('打包 zip 失败：生成文件不是有效 zip')
    }
    return { fileName, data, contentType: 'application/zip' }
  })
}

export async function dumpCollectionToFile(
  uri: string,
  db: string,
  coll: string,
  format: BackupFormat = 'baota',
) {
  const mongodump = await resolveMongoTool('mongodump')
  if (format === '1panel') {
    return withTempDir(async (dir) => {
      const fileName = onePanelBackupFileName(db, coll)
      const archivePath = path.join(dir, fileName)
      await runTool(mongodump, [
        '--uri',
        uri,
        '--db',
        db,
        '--collection',
        coll,
        '--gzip',
        `--archive=${archivePath}`,
      ])
      const data = await fs.readFile(archivePath)
      if (!looksLikeGzip(data)) {
        throw new Error('打包 1Panel 备份失败：生成文件不是 gzip')
      }
      return { fileName, data, contentType: 'application/gzip' }
    })
  }
  return withTempDir(async (dir) => {
    const dumpRoot = path.join(dir, 'dump')
    await fs.mkdir(dumpRoot, { recursive: true })
    await runTool(mongodump, [
      '--uri',
      uri,
      '--db',
      db,
      '--collection',
      coll,
      '--out',
      dumpRoot,
    ])

    const fileName = btBackupFileName(db, coll)
    const zipPath = path.join(dir, fileName)
    await zipDirectory(dumpRoot, zipPath)
    const data = await fs.readFile(zipPath)
    if (!looksLikeZip(data)) {
      throw new Error('打包 zip 失败：生成文件不是有效 zip')
    }
    return { fileName, data, contentType: 'application/zip' }
  })
}

export async function restoreDatabaseFromBuffer(
  uri: string,
  targetDb: string,
  fileBuf: Buffer,
  mode: 'merge' | 'replace',
  sourceDbHint?: string | null,
) {
  const mongorestore = await resolveMongoTool('mongorestore')
  const archiveDb = looksLikeGzip(fileBuf) ? await readArchiveDbName(fileBuf) : null

  return withTempDir(async (dir) => {
    const dropArgs = mode === 'replace' ? ['--drop'] : []
    const gzipSourceDb = archiveDb || sourceDbHint || targetDb

    if (looksLikeZip(fileBuf)) {
      const zipPath = path.join(dir, 'backup.zip')
      await fs.writeFile(zipPath, fileBuf)
      const extractDir = path.join(dir, 'extract')
      await unzipToDirectory(zipPath, extractDir)
      const dumpRoot = await findDumpRoot(extractDir)

      const entries = await fs.readdir(dumpRoot, { withFileTypes: true })
      const dbDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      const sourceDb = sourceDbHint || dbDirs[0] || targetDb

      if (dbDirs.length > 0) {
        await runTool(mongorestore, [
          '--uri',
          uri,
          ...dropArgs,
          '--dir',
          dumpRoot,
          '--nsFrom',
          `${sourceDb}.*`,
          '--nsTo',
          `${targetDb}.*`,
        ])
      } else {
        await runTool(mongorestore, [
          '--uri',
          uri,
          ...dropArgs,
          '--db',
          targetDb,
          '--dir',
          dumpRoot,
        ])
      }

      return { ok: true as const, db: targetDb, mode, format: 'bson-zip' }
    }

    if (looksLikeGzip(fileBuf)) {
      const archivePath = path.join(dir, 'backup.gz')
      await fs.writeFile(archivePath, fileBuf)
      const args = [
        '--uri',
        uri,
        ...dropArgs,
        '--gzip',
        `--archive=${archivePath}`,
      ]
      if (gzipSourceDb !== targetDb) {
        args.push('--nsFrom', `${gzipSourceDb}.*`, '--nsTo', `${targetDb}.*`)
      }
      await runTool(mongorestore, args)
      return { ok: true as const, db: targetDb, mode, format: '1panel-gzip' }
    }

    // 宝塔下载有时无扩展名，先按 zip 再按 gzip 试
    const rawPath = path.join(dir, 'backup.bin')
    await fs.writeFile(rawPath, fileBuf)
    try {
      const extractDir = path.join(dir, 'extract-raw')
      await unzipToDirectory(rawPath, extractDir)
      const dumpRoot = await findDumpRoot(extractDir)
      const entries = await fs.readdir(dumpRoot, { withFileTypes: true })
      const dbDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      const sourceDb = sourceDbHint || dbDirs[0] || targetDb
      if (dbDirs.length > 0) {
        await runTool(mongorestore, [
          '--uri',
          uri,
          ...dropArgs,
          '--dir',
          dumpRoot,
          '--nsFrom',
          `${sourceDb}.*`,
          '--nsTo',
          `${targetDb}.*`,
        ])
      } else {
        await runTool(mongorestore, [
          '--uri',
          uri,
          ...dropArgs,
          '--db',
          targetDb,
          '--dir',
          dumpRoot,
        ])
      }
      return { ok: true as const, db: targetDb, mode, format: 'bson-zip' }
    } catch {
      const args = [
        '--uri',
        uri,
        ...dropArgs,
        '--gzip',
        `--archive=${rawPath}`,
      ]
      if (gzipSourceDb !== targetDb) {
        args.push('--nsFrom', `${gzipSourceDb}.*`, '--nsTo', `${targetDb}.*`)
      }
      await runTool(mongorestore, args)
      return { ok: true as const, db: targetDb, mode, format: '1panel-gzip' }
    }
  })
}
