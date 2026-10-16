import { invoke } from '@tauri-apps/api/core'

/** 从 Electron Leaf Desk 的 LevelDB 导入 localStorage（仅补缺项） */
export async function importElectronLocalStorage(): Promise<void> {
  try {
    const pairs = await invoke<Record<string, string>>('import_electron_local_storage')
    for (const [key, value] of Object.entries(pairs)) {
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, value)
      }
    }
  } catch {
    // 非 Tauri 环境忽略
  }
}
