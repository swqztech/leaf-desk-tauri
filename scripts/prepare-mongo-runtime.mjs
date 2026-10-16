import { copyFileSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { pipeline } from 'node:stream/promises'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const NODE_VERSION = 'v20.18.0'
const destDir = path.join(root, 'src-tauri', 'resources', 'mongo-api')
const nodeExe = path.join(destDir, 'node.exe')
const serverSrc = path.join(root, 'mongo-server', 'dist', 'server.cjs')
const serverDest = path.join(destDir, 'server.cjs')

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

if (existsSync(nodeExe)) {
  console.log('Portable node.exe already present.')
  process.exit(0)
}

const zipName = `node-${NODE_VERSION}-win-x64.zip`
const url = `https://nodejs.org/dist/${NODE_VERSION}/${zipName}`
const zipPath = path.join(destDir, zipName)
const extractDir = path.join(destDir, '_extract')
console.log('Downloading', url)

await new Promise((resolve, reject) => {
  const file = createWriteStream(zipPath)
  https
    .get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location
        if (!loc) return reject(new Error('Redirect without location'))
        https.get(loc, (r2) => pipeline(r2, file).then(resolve).catch(reject))
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      pipeline(res, file).then(resolve).catch(reject)
    })
    .on('error', reject)
})

mkdirSync(extractDir, { recursive: true })
execSync(
  `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}'"`,
  { stdio: 'inherit' },
)
copyFileSync(path.join(extractDir, `node-${NODE_VERSION}-win-x64`, 'node.exe'), nodeExe)
execSync(
  `powershell -NoProfile -Command "Remove-Item -Recurse -Force '${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}'"`,
  { stdio: 'inherit' },
)
console.log('mongo-api runtime ready')
