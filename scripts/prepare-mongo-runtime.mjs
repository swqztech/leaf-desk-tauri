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
const mongodumpMarker = path.join(
  toolsBinDir,
  process.platform === 'win32' ? 'mongodump.exe' : 'mongodump',
)
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

function copyToolsFromSystemBin() {
  if (process.platform !== 'darwin') return false
  const binDirs = ['/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of binDirs) {
    const dump = path.join(dir, 'mongodump')
    if (!existsSync(dump)) continue
    mkdirSync(toolsBinDir, { recursive: true })
    for (const name of readdirSync(dir)) {
      if (
        !name.startsWith('mongo') &&
        name !== 'bsondump' &&
        !name.startsWith('mongofiles')
      ) {
        continue
      }
      const src = path.join(dir, name)
      try {
        if (!existsSync(src)) continue
        copyFileSync(src, path.join(toolsBinDir, name))
        execSync(`chmod +x ${JSON.stringify(path.join(toolsBinDir, name))}`, {
          stdio: 'ignore',
        })
      } catch {
        // ignore single binary
      }
    }
    if (existsSync(mongodumpMarker)) {
      console.log('已从系统复制 MongoDB Database Tools 到', toolsBinDir)
      return true
    }
  }
  return false
}

function installToolsBinFromExtract(extractDir, markerName) {
  const top = readdirSync(extractDir, { withFileTypes: true }).find((e) => e.isDirectory())
  if (!top) {
    throw new Error('解压 MongoDB Tools 失败：未找到目录')
  }
  const srcBin = path.join(extractDir, top.name, 'bin')
  if (!existsSync(path.join(srcBin, markerName))) {
    throw new Error(`解压 MongoDB Tools 失败：${srcBin} 内无 ${markerName}`)
  }
  mkdirSync(toolsBinDir, { recursive: true })
  cpSync(srcBin, toolsBinDir, { recursive: true })
  if (process.platform !== 'win32') {
    for (const name of readdirSync(toolsBinDir)) {
      const bin = path.join(toolsBinDir, name)
      try {
        execSync(`chmod +x ${JSON.stringify(bin)}`, { stdio: 'ignore' })
      } catch {
        // ignore
      }
    }
  }
}

async function ensureMongoDatabaseTools() {
  if (existsSync(mongodumpMarker)) {
    console.log('MongoDB Database Tools 已就绪。')
    return
  }

  if (process.platform === 'win32') {
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
    installToolsBinFromExtract(extractDir, 'mongodump.exe')
    execSync(
      `powershell -NoProfile -Command "Remove-Item -Recurse -Force ${psQuote(zipPath)}, ${psQuote(extractDir)}"`,
      { stdio: 'inherit' },
    )
    console.log('MongoDB Database Tools 已安装到', toolsBinDir)
    return
  }

  if (process.platform === 'darwin') {
    if (copyToolsFromSystemBin()) return
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
    const zipName = `mongodb-database-tools-macos-${arch}-${MONGO_TOOLS_VERSION}.zip`
    const url = `https://fastdl.mongodb.org/tools/db/${zipName}`
    const zipPath = path.join(destDir, zipName)
    const extractDir = path.join(destDir, '_tools_extract')
    console.log('正在下载 MongoDB Database Tools…', url)
    await downloadFile(url, zipPath)
    mkdirSync(extractDir, { recursive: true })
    execSync(`unzip -q -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(extractDir)}`, {
      stdio: 'inherit',
    })
    installToolsBinFromExtract(extractDir, 'mongodump')
    execSync(`rm -rf ${JSON.stringify(zipPath)} ${JSON.stringify(extractDir)}`, {
      stdio: 'inherit',
    })
    console.log('MongoDB Database Tools 已安装到', toolsBinDir)
    return
  }

  console.log('当前平台未自动下载 Database Tools，请设置 MONGO_TOOLS_DIR 或安装 mongodump 到 PATH')
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
