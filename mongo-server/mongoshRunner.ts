import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function stripAnsi(text: string) {
  return text.replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

async function pathIfExists(filePath: string) {
  try {
    await fs.access(filePath)
    return filePath
  } catch {
    return null
  }
}

export async function resolveMongosh() {
  const exeName = process.platform === 'win32' ? 'mongosh.exe' : 'mongosh'
  const candidates: string[] = []

  if (process.env.MONGOSH_PATH) {
    candidates.push(process.env.MONGOSH_PATH)
  }
  if (process.env.MONGO_TOOLS_DIR) {
    candidates.push(path.join(process.env.MONGO_TOOLS_DIR, exeName))
  }
  candidates.push(path.join(process.cwd(), 'tools', 'bin', exeName))
  candidates.push(path.join(process.cwd(), 'tools', exeName))

  const home = os.homedir()
  candidates.push(
    path.join(home, 'Downloads', 'mongosh-2.8.2-win32-x64', 'bin', exeName),
  )
  candidates.push(
    path.join(home, 'AppData', 'Local', 'Programs', 'mongosh', exeName),
  )

  for (const item of candidates) {
    const hit = await pathIfExists(item)
    if (hit) return hit
  }

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(cmd, ['mongosh'], {
      windowsHide: true,
    })
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (first) return first
  } catch {
    // ignore
  }

  throw new Error(
    '未找到 mongosh。请安装 MongoDB Shell，或设置环境变量 MONGOSH_PATH',
  )
}

/** 把库名接到连接串上 */
export function uriWithDb(uri: string, db?: string | null) {
  if (!db?.trim()) return uri
  const matched = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/i)
  if (!matched) return uri
  return `${matched[1]}/${encodeURIComponent(db.trim())}${matched[3] || ''}`
}

export async function runMongoshScript(options: {
  uri: string
  db?: string | null
  script: string
  timeoutMs?: number
}) {
  const script = options.script.trim()
  if (!script) {
    throw new Error('请输入 mongosh 命令或脚本')
  }
  if (script.length > 200_000) {
    throw new Error('脚本过长（上限约 200KB）')
  }

  const mongosh = await resolveMongosh()
  const conn = uriWithDb(options.uri, options.db)
  const timeoutMs = options.timeoutMs ?? 120_000
  // Windows 命令行长度有限：短脚本用 --eval（会打印表达式结果），长脚本落盘 --file
  const useEval = Buffer.byteLength(script, 'utf8') < 24_000
  const tmpDir = useEval
    ? null
    : await fs.mkdtemp(path.join(os.tmpdir(), 'leaf-mongosh-'))
  const scriptPath = tmpDir ? path.join(tmpDir, 'script.js') : null

  const args = useEval
    ? [conn, '--quiet', '--norc', '--eval', script]
    : [conn, '--quiet', '--norc', '--file', scriptPath!]

  try {
    if (scriptPath) {
      await fs.writeFile(scriptPath, `${script}\n`, 'utf8')
    }
    const { stdout, stderr } = await execFileAsync(mongosh, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        MONGOSH_SKIP_SHELL_API_WARNING: '1',
      },
    })

    return {
      ok: true as const,
      stdout: stripAnsi(stdout || ''),
      stderr: stripAnsi(stderr || ''),
      uri: conn,
    }
  } catch (err) {
    const e = err as {
      stdout?: string
      stderr?: string
      message?: string
      killed?: boolean
      code?: number | string
    }
    if (e.killed) {
      throw new Error(`执行超时（>${Math.round(timeoutMs / 1000)}s）`)
    }
    const out = stripAnsi(e.stdout || '')
    const errText = stripAnsi(e.stderr || e.message || String(err))
    return {
      ok: false as const,
      stdout: out,
      stderr: errText,
      uri: conn,
      code: e.code,
    }
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }
}
