import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { pipeline } from 'node:stream/promises'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const NODE_VERSION = 'v20.18.0'
const MONGO_TOOLS_VERSION = '100.16.0'
const destDir = path.join(root, 'src-tauri', 'resources', 'mongo-api')
const nodeExe = path.join(destDir, 'node.exe')
const toolsBinDir = path.join(destDir, 'tools', 'bin')
const mongodumpExe = path.join(toolsBinDir, 'mongodump.exe')
const serverSrc = path.join(root, 'mongo-server', 'dist', 'server.cjs')
const serverDest = path.join(destDir, 'server.cjs')

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath)
    const request = (target) => {
      https
        .get(target, (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            const loc = res.headers.location
            if (!loc) return reject(new Error('Redirect without location'))
            request(loc)
            return
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${target}`))
            return
          }
          pipeline(res, file).then(resolve).catch(reject)
        })
        .on('error', reject)
    }
    request(url)
  })
}

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`
}

async function ensureMongoDatabaseTools() {
  if (process.platform !== 'win32') {
    console.log('MongoDB Database Tools 自动下载仅支持 Windows，请自行安装并配置 PATH 或 MONGO_TOOLS_DIR')
    return
  }
  if (existsSync(mongodumpExe)) {
    console.log('MongoDB Database Tools 已就绪。')
    return
  }

  const zipName = `mongodb-database-tools-windows-x86_64-${MONGO_TOOLS_VERSION}.zip`
  const url = `https://fastdl.mongodb.org/tools/db/${zipName}`
  const zipPath = path.join(destDir, zipName)
  const extractDir = path.join(destDir, '_tools_extract')
  console.log('正在下载 MongoDB Database Tools…', url)
  await downloadFile(url, zipPath)

  mkdirSync(extractDir, { recursive: true })
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Force -Path ${psQuote(zipPath)} -DestinationPath ${psQuote(extractDir)}"`,
    { stdio: 'inherit' },
  )

  const top = readdirSync(extractDir, { withFileTypes: true }).find((e) => e.isDirectory())
  if (!top) {
    throw new Error('解压 MongoDB Tools 失败：未找到目录')
  }
  const srcBin = path.join(extractDir, top.name, 'bin')
  if (!existsSync(path.join(srcBin, 'mongodump.exe'))) {
    throw new Error(`解压 MongoDB Tools 失败：${srcBin} 内无 mongodump.exe`)
  }
  mkdirSync(toolsBinDir, { recursive: true })
  cpSync(srcBin, toolsBinDir, { recursive: true })

  execSync(
    `powershell -NoProfile -Command "Remove-Item -Recurse -Force ${psQuote(zipPath)}, ${psQuote(extractDir)}"`,
    { stdio: 'inherit' },
  )
  console.log('MongoDB Database Tools 已安装到', toolsBinDir)
}

mkdirSync(destDir, { recursive: true })

if (!existsSync(serverSrc)) {
  console.error('Missing mongo-server/dist/server.cjs — run mongo-server build first.')
  process.exit(1)
}
copyFileSync(serverSrc, serverDest)

const pkg = {
  name: 'leaf-desk-api-runtime',
  private: true,
  type: 'commonjs',
  dependencies: {
    cors: '^2.8.6',
    express: '^5.2.1',
    mongodb: '^7.5.0',
  },
}
writeFileSync(path.join(destDir, 'package.json'), JSON.stringify(pkg, null, 2))
if (!existsSync(path.join(destDir, 'node_modules', 'mongodb'))) {
  execSync('npm install --omit=dev', { cwd: destDir, stdio: 'inherit' })
}

await ensureMongoDatabaseTools()

if (existsSync(nodeExe)) {
  console.log('Portable node.exe already present.')
  process.exit(0)
}

const zipName = `node-${NODE_VERSION}-win-x64.zip`
const url = `https://nodejs.org/dist/${NODE_VERSION}/${zipName}`
const zipPath = path.join(destDir, zipName)
const extractDir = path.join(destDir, '_extract')
console.log('Downloading', url)

await downloadFile(url, zipPath)

mkdirSync(extractDir, { recursive: true })
execSync(
  `powershell -NoProfile -Command "Expand-Archive -Force -Path ${psQuote(zipPath)} -DestinationPath ${psQuote(extractDir)}"`,
  { stdio: 'inherit' },
)
copyFileSync(path.join(extractDir, `node-${NODE_VERSION}-win-x64`, 'node.exe'), nodeExe)
execSync(
  `powershell -NoProfile -Command "Remove-Item -Recurse -Force ${psQuote(zipPath)}, ${psQuote(extractDir)}"`,
  { stdio: 'inherit' },
)
console.log('mongo-api runtime ready')
