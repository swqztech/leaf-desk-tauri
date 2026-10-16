import { invoke } from '@tauri-apps/api/core'

export const desktopApi = {
  getPathForFile: (_file: File): string => '',
  showItem: (filePath: string): Promise<boolean> =>
    invoke('show_item_in_folder', { path: filePath }).then(() => true),
  openPath: (filePath: string): Promise<boolean> =>
    invoke('open_path', { path: filePath }),
}

declare global {
  interface Window {
    api?: typeof desktopApi
  }
}

export function installDesktopApi() {
  window.api = desktopApi
}
