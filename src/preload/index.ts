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

// 원장 (§6.1) — POS·KIOSK 로 페어링된 셸에만. 웹 POS 의 IndexedDB 모듈과 같은 이름.
// 매장·단말 인자는 받되 main 이 이 기기의 신원으로 바꿉니다.
const deviceType = identity?.deviceType
if (deviceType === 'POS' || deviceType === 'KIOSK') {
  api.ledger = {
    mint: (storeId: string, deviceId: string, businessDate: string, orderId: number) =>
      ipcRenderer.invoke('ledger:mint', storeId, deviceId, businessDate, orderId),
    confirm: (id: string, payload: unknown) => ipcRenderer.invoke('ledger:confirm', id, payload),
    discard: (id: string, reason: string) => ipcRenderer.invoke('ledger:discard', id, reason),
    pending: () => ipcRenderer.invoke('ledger:pending'),
    unsentCount: () => ipcRenderer.invoke('ledger:unsentCount'),
    markSent: (ids: string[]) => ipcRenderer.invoke('ledger:markSent', ids),
    markFailed: (ids: string[], reason: string) => ipcRenderer.invoke('ledger:markFailed', ids, reason),
    minted: () => ipcRenderer.invoke('ledger:minted'),
    migrated: () => ipcRenderer.invoke('ledger:migrated'),
    importRows: (counters: unknown[], trans: unknown[]) => ipcRenderer.invoke('ledger:import', counters, trans)
  }
}

if (location.href.startsWith('sunmoon://app/setup/')) {
  api.setup = {
    defaults: () => ipcRenderer.invoke('setup:defaults'),
    pair: (serverUrl: string, code: string) => ipcRenderer.invoke('setup:pair', serverUrl, code)
  }
}

contextBridge.exposeInMainWorld('sunmoon', api)
