import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { forgetConfig, readConfig } from './config'
import { register } from './identity'
import { unlockKiosk } from './kioskUnlock'
import type { CounterRow, Ledger, TranRow } from './ledger'
import type { ReceiptContent } from './escpos'
import * as printer from './printer'
import { virtualApproval } from './roles'

/**
 * 화면이 부를 수 있는 채널 — <b>여기 없는 것은 없습니다</b> (store-app.md §2.1).
 *
 * <p>preload 도 이 목록만 씁니다. 화면에는 {@code ipcRenderer} 자체가 가지 않으므로
 * 임의의 채널을 부를 수 없습니다. 네이티브 기능(원장·프린터)이 생기면 여기에 더하고,
 * 역할별로 열어 주는 것은 {@link allowed} 가 정합니다.
 */
export const CHANNELS = {
  identityGet: 'identity:get',
  identityForget: 'identity:forget',
  setupSave: 'setup:save',
  setupDefaults: 'setup:defaults',
  // 원장 (§6.1) — POS·KIOSK 만. 함수 이름은 웹 POS 의 IndexedDB 모듈과 같습니다.
  ledgerMint: 'ledger:mint',
  ledgerConfirm: 'ledger:confirm',
  ledgerDiscard: 'ledger:discard',
  ledgerPending: 'ledger:pending',
  ledgerUnsentCount: 'ledger:unsentCount',
  ledgerMarkSent: 'ledger:markSent',
  ledgerMarkFailed: 'ledger:markFailed',
  ledgerMinted: 'ledger:minted',
  ledgerMigrated: 'ledger:migrated',
  ledgerImport: 'ledger:import',
  // 프린터 (§6.3, §7) — 어디로 찍을지는 main 이 정합니다.
  printerLabel: 'printer:label',
  printerQueuedLabels: 'printer:queuedLabels',
  printerReceipt: 'printer:receipt',
  drawerOpen: 'drawer:open',
  // KIOSK 결제 (§9) — 그 전까지 썬앤문페이(가상).
  paymentApprove: 'payment:approve',
  // KIOSK 관리자 탈출 (§5.3): 구석 5번 → 관리자 창 → PIN(서버가 확인) → 동작
  kioskEscape: 'kiosk:escape',
  kioskUnlock: 'kiosk:unlock',
  kioskAct: 'kiosk:act'
} as const

/** 관리자 창에서 온 것인가 — PIN·동작 채널은 이 창만 받습니다. */
function fromUnlock(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url?.startsWith('sunmoon://app/setup/unlock.html') === true
}

/** 라벨은 KDS-MAIN (라벨 프린터가 주방의 중심 옆에). 영수증·돈통은 계산대(POS·KIOSK). */
export function printerAllowed(kind: 'label' | 'receipt', device: { deviceType: string; kdsRole: string | null } | undefined): boolean {
  if (!device) return false
  return kind === 'label'
    ? device.deviceType === 'KDS' && device.kdsRole === 'MAIN'
    : device.deviceType === 'POS' || device.deviceType === 'KIOSK'
}

/** 원장을 여는 역할 (§1 표). KDS-MAIN 은 거래를 만들지 않습니다. */
export function ledgerAllowed(deviceType: string | undefined): boolean {
  return deviceType === 'POS' || deviceType === 'KIOSK'
}

/** 셋업 화면 밖에서는 설정 채널을 안 받습니다. 화면을 가리는 것은 보낸 쪽의 주소입니다. */
function fromSetup(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url?.startsWith('sunmoon://app/setup/') === true
}

function fromShell(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url?.startsWith('sunmoon://app/') === true
}

export function registerIpc(opts: {
  defaultServerUrl: string
  onConfigured: () => void
  onForgotten: () => void
  ledger: () => Ledger
  kiosk: {
    openAdmin: () => void
    closeAdmin: () => void
    windowMode: () => void
    quit: () => void
  }
}): void {
  // KIOSK 관리자 탈출. 잠금은 PIN 이 맞은 뒤 2분만 풀립니다.
  let unlockedUntil = 0
  const isKiosk = () => readConfig()?.device.deviceType === 'KIOSK'
  ipcMain.on(CHANNELS.kioskEscape, (event) => {
    if (fromShell(event) && isKiosk()) opts.kiosk.openAdmin()
  })
  ipcMain.handle(CHANNELS.kioskUnlock, async (event, pin: unknown) => {
    if (!fromUnlock(event) || !isKiosk()) return { ok: false, error: '관리자 창에서만' }
    const result = await unlockKiosk(String(pin ?? ''))
    if (result.ok) unlockedUntil = Date.now() + 2 * 60_000
    return result
  })
  ipcMain.handle(CHANNELS.kioskAct, (event, act: unknown) => {
    if (!fromUnlock(event) || !isKiosk()) return { error: '관리자 창에서만' }
    if (act === 'back') {
      opts.kiosk.closeAdmin()
      return {}
    }
    if (Date.now() > unlockedUntil) return { error: '잠금이 다시 걸렸습니다 — PIN 을 다시 넣으십시오' }
    opts.kiosk.closeAdmin()
    if (act === 'window') opts.kiosk.windowMode()
    else if (act === 'quit') opts.kiosk.quit()
    else if (act === 'forget') {
      forgetConfig()
      opts.onForgotten()
    }
    return {}
  })

  // 원장 채널: 셸 화면에서, POS·KIOSK 로 등록된 기기일 때만. 매장·단말은 화면이
  // 보낸 값이 아니라 <b>이 기기의 신원</b>으로 바꿉니다 — 화면이 다른 단말 행세를
  // 해서 남의 번호를 끊을 수 없게.
  const onLedger = <A extends unknown[], R>(channel: string, work: (l: Ledger, a: A) => R) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const config = readConfig()
      if (!fromShell(event) || !ledgerAllowed(config?.device.deviceType)) {
        throw new Error('이 기기에서는 원장을 쓸 수 없습니다')
      }
      return work(opts.ledger(), args as A)
    })
  }
  const me = () => readConfig()!.device
  onLedger<[string, string, string, number], unknown>(CHANNELS.ledgerMint,
    (l, [, , businessDate, orderId]) => l.mint(me().storeId, me().deviceId, String(businessDate), Number(orderId)))
  onLedger<[string, unknown], void>(CHANNELS.ledgerConfirm, (l, [id, payload]) => l.confirm(String(id), payload))
  onLedger<[string, string], void>(CHANNELS.ledgerDiscard, (l, [id, reason]) => l.discard(String(id), String(reason)))
  onLedger<[], unknown>(CHANNELS.ledgerPending, (l) => l.pending(me().storeId, me().deviceId))
  onLedger<[], number>(CHANNELS.ledgerUnsentCount, (l) => l.unsentCount(me().storeId, me().deviceId))
  onLedger<[string[]], void>(CHANNELS.ledgerMarkSent, (l, [ids]) => l.markSent((ids ?? []).map(String)))
  onLedger<[string[], string], void>(CHANNELS.ledgerMarkFailed,
    (l, [ids, reason]) => l.markFailed((ids ?? []).map(String), String(reason)))
  onLedger<[], unknown>(CHANNELS.ledgerMinted, (l) => l.minted(me().storeId, me().deviceId))
  onLedger<[], boolean>(CHANNELS.ledgerMigrated, (l) => l.migrated())
  onLedger<[CounterRow[], TranRow[]], unknown>(CHANNELS.ledgerImport,
    (l, [counters, trans]) => l.importRows(counters ?? [], trans ?? []))

  const onPrinter = (channel: string, kind: 'label' | 'receipt', work: (...args: unknown[]) => Promise<unknown>) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!fromShell(event) || !printerAllowed(kind, readConfig()?.device)) {
        throw new Error('이 기기에서는 이 프린터를 쓸 수 없습니다')
      }
      return work(...args)
    })
  }
  onPrinter(CHANNELS.printerLabel, 'label', (jobId) => printer.printLabel(Number(jobId)))
  onPrinter(CHANNELS.printerQueuedLabels, 'label', () => printer.printQueuedLabels())
  onPrinter(CHANNELS.printerReceipt, 'receipt', (content) => printer.printReceipt(content as ReceiptContent))
  onPrinter(CHANNELS.drawerOpen, 'receipt', () => printer.openDrawer())

  ipcMain.handle(CHANNELS.paymentApprove, (event, amount: unknown) => {
    if (!fromShell(event) || readConfig()?.device.deviceType !== 'KIOSK') {
      throw new Error('KIOSK 만 결제를 받습니다')
    }
    return virtualApproval(amount)
  })

  // 신원은 화면이 시작할 때 한 번 동기로 읽습니다(§5.2) — 화면 코드가 비동기
  // 초기화를 기다리지 않고 지금처럼 바로 매장·번호를 알 수 있게.
  ipcMain.on(CHANNELS.identityGet, (event) => {
    if (!fromShell(event)) {
      event.returnValue = null
      return
    }
    const config = readConfig()
    event.returnValue = config === null ? null : {
      ...config.device,
      serverUrl: config.serverUrl
    }
  })

  ipcMain.handle(CHANNELS.identityForget, (event) => {
    if (!fromShell(event)) return false
    forgetConfig()
    opts.onForgotten()
    return true
  })

  ipcMain.handle(CHANNELS.setupDefaults, (event) => {
    if (!fromSetup(event)) return null
    return { serverUrl: opts.defaultServerUrl }
  })

  ipcMain.handle(CHANNELS.setupSave, (event, serverUrl: unknown, storeId: unknown, deviceId: unknown, kind: unknown) => {
    if (!fromSetup(event)) return { ok: false, error: '설정 화면에서만 정합니다' }
    const result = register(String(serverUrl ?? ''), String(storeId ?? ''), String(deviceId ?? ''), String(kind ?? ''))
    if (result.ok) opts.onConfigured()
    return result
  })
}
