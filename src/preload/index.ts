import { contextBridge, ipcRenderer } from 'electron'

/**
 * 화면에 여는 것은 {@code window.sunmoon} 하나 (store-app.md §1, §2.1).
 *
 * <p>sandbox 라서 여기서는 electron 의 일부만 씁니다. 채널 이름은 main 의
 * {@code ipc.ts} 와 같아야 합니다 — sandbox preload 는 다른 파일을 require 할 수
 * 없어서 두 곳에 적습니다.
 */

const identity = ipcRenderer.sendSync('identity:get') as Record<string, unknown> | null

const api: Record<string, unknown> = {
  /** 셸 안에서 돌고 있다는 표시. 화면은 {@code window.sunmoon} 이 있으면 셸입니다. */
  shell: { version: '0.1.0' },
  identity: {
    get: () => identity,
    /** 이 기기의 페어링을 지우고 셋업 화면으로. */
    forget: () => ipcRenderer.invoke('identity:forget')
  }
}

if (location.href.startsWith('sunmoon://app/setup/')) {
  api.setup = {
    defaults: () => ipcRenderer.invoke('setup:defaults'),
    pair: (serverUrl: string, code: string) => ipcRenderer.invoke('setup:pair', serverUrl, code)
  }
}

contextBridge.exposeInMainWorld('sunmoon', api)
