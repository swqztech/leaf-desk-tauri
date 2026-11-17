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
const nodeBinName = process.platform === 'win32' ? 'node.exe' : 'node'
const nodeExe = path.join(destDir, nodeBinName)
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

async function ensurePortableNode() {
  if (existsSync(nodeExe)) {
    console.log(`Portable ${nodeBinName} already present.`)
    return
  }

  if (process.platform === 'win32') {
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
    return
  }

  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const tarName = `node-${NODE_VERSION}-darwin-${arch}.tar.gz`
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${tarName}`
    const tarPath = path.join(destDir, tarName)
    const extractDir = path.join(destDir, '_extract')
    console.log('Downloading', url)
    await downloadFile(url, tarPath)
    mkdirSync(extractDir, { recursive: true })
    execSync(`tar -xzf ${JSON.stringify(tarPath)} -C ${JSON.stringify(extractDir)}`, {
      stdio: 'inherit',
    })
    const inner = path.join(extractDir, `node-${NODE_VERSION}-darwin-${arch}`, 'bin', 'node')
    copyFileSync(inner, nodeExe)
    execSync(`chmod +x ${JSON.stringify(nodeExe)}`, { stdio: 'inherit' })
    execSync(`rm -rf ${JSON.stringify(tarPath)} ${JSON.stringify(extractDir)}`, {
      stdio: 'inherit',
    })
    return
  }

  console.error('当前平台请自行将 Node 可执行文件放到', nodeExe)
  process.exit(1)
}

await ensurePortableNode()
console.log('mongo-api runtime ready')
