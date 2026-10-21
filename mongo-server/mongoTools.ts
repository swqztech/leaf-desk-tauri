import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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

/** 从宝塔备份文件名解析源库名 */
export function parseSourceDbFromFileName(fileName: string) {
  const base = path.basename(fileName).replace(/\.(zip|gz|archive)$/i, '')
  const matched = base.match(/^(.+)_bson_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/)
  return matched?.[1] ?? null
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

/**
 * 导出为宝塔同款 zip：
 * mongodump --out → zip，内含 {db}/*.bson + *.metadata.json
 */
export async function dumpDatabaseToFile(uri: string, db: string) {
  const mongodump = await resolveMongoTool('mongodump')
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
) {
  const mongodump = await resolveMongoTool('mongodump')
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

  return withTempDir(async (dir) => {
    const dropArgs = mode === 'replace' ? ['--drop'] : []

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
      const sourceDb = sourceDbHint || targetDb
      if (sourceDb !== targetDb) {
        args.push('--nsFrom', `${sourceDb}.*`, '--nsTo', `${targetDb}.*`)
      }
      await runTool(mongorestore, args)
      return { ok: true as const, db: targetDb, mode, format: 'archive-gzip' }
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
      const sourceDb = sourceDbHint || targetDb
      if (sourceDb !== targetDb) {
        args.push('--nsFrom', `${sourceDb}.*`, '--nsTo', `${targetDb}.*`)
      }
      await runTool(mongorestore, args)
      return { ok: true as const, db: targetDb, mode, format: 'archive-gzip' }
    }
  })
}
