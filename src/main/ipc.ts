import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { forgetConfig, readConfig } from './config'
import { pair } from './identity'

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
  setupDefaults: 'setup:defaults'
} as const

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
}): void {
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
