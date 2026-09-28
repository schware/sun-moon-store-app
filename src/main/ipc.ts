import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { forgetConfig, readConfig } from './config'
import { pair } from './identity'
import type { CounterRow, Ledger, TranRow } from './ledger'

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
  setupPair: 'setup:pair',
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
  ledgerImport: 'ledger:import'
} as const

/** 원장을 여는 역할 (§1 표). KDS-MAIN 은 거래를 만들지 않습니다. */
export function ledgerAllowed(deviceType: string | undefined): boolean {
  return deviceType === 'POS' || deviceType === 'KIOSK'
}

/** 셋업 화면 밖에서는 페어링 채널을 안 받습니다. 화면을 가리는 것은 보낸 쪽의 주소입니다. */
function fromSetup(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url?.startsWith('sunmoon://app/setup/') === true
}

function fromShell(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url?.startsWith('sunmoon://app/') === true
}

export function registerIpc(opts: {
  defaultServerUrl: string
  onPaired: () => void
  onForgotten: () => void
  ledger: () => Ledger
}): void {
  // 원장 채널: 셸 화면에서, POS·KIOSK 로 페어링된 기기일 때만. 매장·단말은 화면이
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
      token: config.token,
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

  ipcMain.handle(CHANNELS.setupPair, async (event, serverUrl: unknown, code: unknown) => {
    if (!fromSetup(event)) return { ok: false, error: '셋업 화면에서만 페어링합니다' }
    const result = await pair(String(serverUrl ?? ''), String(code ?? ''))
    if (result.ok) opts.onPaired()
    return result
  })
}
