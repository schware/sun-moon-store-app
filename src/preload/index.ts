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
    /** 이 기기의 단말 등록을 지우고 셋업 화면으로. */
    forget: () => ipcRenderer.invoke('identity:forget')
  }
}

// 원장 (§6.1) — POS·KIOSK 로 등록된 셸에만. 웹 POS 의 IndexedDB 모듈과 같은 이름.
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

// 프린터 (§6.3, §7). 화면은 작업 번호나 내용만 넘깁니다 — 바이트와 주소는 main 이.
if (deviceType === 'KDS' && identity?.kdsRole === 'MAIN') {
  api.printer = {
    label: (jobId: number) => ipcRenderer.invoke('printer:label', jobId),
    queuedLabels: () => ipcRenderer.invoke('printer:queuedLabels')
  }
}
if (deviceType === 'POS' || deviceType === 'KIOSK') {
  api.printer = {
    receipt: (content: unknown) => ipcRenderer.invoke('printer:receipt', content)
  }
  api.drawer = { open: () => ipcRenderer.invoke('drawer:open') }
}

// KIOSK 결제 (§9). 그 전까지 썬앤문페이(가상) — VAN 이 정해지면 main 만 바뀝니다.
if (deviceType === 'KIOSK') {
  api.payment = { approve: (amount: number) => ipcRenderer.invoke('payment:approve', amount) }

  // 관리자 탈출 (§5.3): 왼쪽 위 구석(80px)을 3초 안에 5번. 화면 코드는 모릅니다 — 셸이 듣습니다.
  if (!location.href.startsWith('sunmoon://app/setup/')) {
    let taps: number[] = []
    window.addEventListener('pointerdown', (e) => {
      if (e.clientX > 80 || e.clientY > 80) return
      const now = Date.now()
      taps = [...taps.filter((t) => now - t < 3000), now]
      if (taps.length >= 5) {
        taps = []
        ipcRenderer.send('kiosk:escape')
      }
    }, true)
  }
}

if (location.href.startsWith('sunmoon://app/setup/unlock.html')) {
  api.kioskAdmin = {
    unlock: (pin: string) => ipcRenderer.invoke('kiosk:unlock', pin),
    act: (act: string) => ipcRenderer.invoke('kiosk:act', act)
  }
}

if (location.href.startsWith('sunmoon://app/setup/')) {
  api.setup = {
    defaults: () => ipcRenderer.invoke('setup:defaults'),
    save: (serverUrl: string, storeId: string, deviceId: string, kind: string) =>
      ipcRenderer.invoke('setup:save', serverUrl, storeId, deviceId, kind)
  }
}

contextBridge.exposeInMainWorld('sunmoon', api)
