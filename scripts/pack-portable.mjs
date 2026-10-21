/**
 * 叶桌绿色版：exe + dll + resources/mongo-api（内置 Node API）
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const RELEASE = join(root, 'src-tauri', 'target', 'release')
const EXE_NAME = 'leaf_desk.exe'
const DLL_NAME = 'leaf_desk_lib.dll'

function readMeta() {
  const confPath = join(root, 'src-tauri', 'tauri.conf.json')
  const raw = readFileSync(confPath, 'utf8')
  const productName = raw.match(/"productName"\s*:\s*"([^"]+)"/)?.[1] ?? 'LeafDesk'
  const version = raw.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? '0.0.0'
  return { productName, version }
}

function copyBinary(src, dest) {
  writeFileSync(dest, readFileSync(src))
}

function has7z() {
  return spawnSync('7z', ['-h'], { encoding: 'utf8', shell: true }).status === 0
}

function zipWith7z(outRoot, folderName, zipPath) {
  rmSync(zipPath, { force: true })
  const r = spawnSync('7z', ['a', '-tzip', zipPath, folderName], {
    cwd: outRoot,
    stdio: 'inherit',
    shell: true,
  })
  if (r.status !== 0) throw new Error('7z 打包失败')
}

function zipWithPowerShell(folderPath, zipPath) {
  rmSync(zipPath, { force: true })
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -LiteralPath '${folderPath.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit', shell: false },
  )
  if (r.status !== 0) throw new Error('Compress-Archive 失败')
}

function assertZipOk(zipPath) {
  if (!existsSync(zipPath) || statSync(zipPath).size < 1000) {
    throw new Error(`未生成有效 zip：${zipPath}`)
  }
}

function copyMongoApi(stageDir) {
  const candidates = [
    join(RELEASE, 'resources', 'mongo-api'),
    join(root, 'src-tauri', 'resources', 'mongo-api'),
  ]
  const src = candidates.find((p) => existsSync(join(p, 'node.exe')) && existsSync(join(p, 'server.cjs')))
  if (!src) {
    throw new Error('未找到 mongo-api 运行时，请先 npm run build:client')
  }
  const dest = join(stageDir, 'resources', 'mongo-api')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
}

function main() {
  const exe = join(RELEASE, EXE_NAME)
  const dllCandidates = [
    join(RELEASE, DLL_NAME),
    join(RELEASE, 'deps', DLL_NAME),
  ]
  const dll = dllCandidates.find((p) => existsSync(p))

  if (!existsSync(exe) || !dll) {
    console.error('未找到编译产物，请先执行：npm run build:client')
    console.error(`  exe: ${exe}`)
    process.exit(1)
  }

  const { productName, version } = readMeta()
  const folderName = `${productName}-${version}-x64-portable`
  const outRoot = join(root, 'dist-portable')
  const stageDir = join(outRoot, folderName)
  const zipPath = join(outRoot, `${folderName}.zip`)

  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })

  copyBinary(exe, join(stageDir, EXE_NAME))
  copyBinary(dll, join(stageDir, DLL_NAME))
  // 便于从 target/release 直接启动时也能找到 dll
  if (dll !== join(RELEASE, DLL_NAME) && !existsSync(join(RELEASE, DLL_NAME))) {
    try {
      copyBinary(dll, join(RELEASE, DLL_NAME))
    } catch {
      // ignore
    }
  }
  copyMongoApi(stageDir)

  writeFileSync(
    join(stageDir, '使用说明.txt'),
    `【叶桌 / ${productName}】绿色版 v${version}

解压后双击 ${EXE_NAME}，无需安装。
请保持 resources\\mongo-api 与 exe 相对位置不变。
需要 WebView2 运行时。
`,
    'utf8',
  )

  try {
    if (has7z()) zipWith7z(outRoot, folderName, zipPath)
    else zipWithPowerShell(stageDir, zipPath)
    assertZipOk(zipPath)
  } catch (e) {
    console.error(e.message ?? e)
    process.exit(1)
  }

  console.log('')
  console.log(`绿色版目录：${stageDir}`)
  console.log(`绿色版 zip ：${zipPath}`)
  console.log(`主程序    ：${join(stageDir, EXE_NAME)}`)
}

main()
