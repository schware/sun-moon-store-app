import { app, BrowserWindow, protocol, net, session } from 'electron'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readConfig } from './config'
import { registerIpc } from './ipc'
import { Ledger } from './ledger'
import { contentSecurityPolicy, screenFor } from './roles'

/**
 * 매장 단말 셸 (umbrella docs/design/store-app.md §5, ADR-0015).
 *
 * <p>하는 일은 넷입니다: 페어링, 역할의 화면 열기, 늘 켜져 있기, 화면을 가두기.
 * 네이티브 기능(원장·프린터·업데이트)은 4~6단계에서 여기에 붙습니다.
 */

/** ▶ 기본값 서버 주소 (§5.1). 도메인이 생기면 바꿉니다. */
const DEFAULT_SERVER = process.env.SUNMOON_SERVER ?? 'http://211.217.183.232:8087'
const ORIGIN = 'sunmoon://app'

// 화면은 로컬 파일만 엽니다(§2.1). file:// 대신 전용 scheme 을 쓰는 이유: 화면
// 번들이 절대 경로(/pos/assets/…)로 빌드돼 있고, file:// 에서는 그게 디스크의
// 뿌리를 가리킵니다. secure 가 아닌 이유: Device Server 가 아직 http 라 secure
// 출처에서 부르면 mixed content 로 막힙니다(TLS 는 도메인이 생긴 뒤, ADR-0007).
// 시험할 때 개발 PC 의 진짜 설정을 건드리지 않게 — 따로 쓸 폴더.
if (process.env.SUNMOON_USER_DATA) app.setPath('userData', process.env.SUNMOON_USER_DATA)

protocol.registerSchemesAsPrivileged([
  { scheme: 'sunmoon', privileges: { standard: true, supportFetchAPI: true, corsEnabled: true } }
])

function uiRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.join(__dirname, '..', '..', 'ui')
}

function setupRoot(): string {
  return path.join(__dirname, '..', 'setup')
}

/** sunmoon://app/<화면>/… → 디스크의 파일. 뿌리 밖으로 나가는 경로는 거절합니다. */
function resolve(url: URL): string | null {
  const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean)
  if (parts.length === 0) return null
  const [first, ...rest] = parts
  const root = first === 'setup' ? setupRoot() : path.join(uiRoot(), first)
  const file = path.resolve(root, ...(rest.length === 0 ? ['index.html'] : rest))
  if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.resolve(root)) return null
  return file
}

function serve(): void {
  protocol.handle('sunmoon', async (request) => {
    const url = new URL(request.url)
    let file = url.host === 'app' ? resolve(url) : null
    if (file === null) return new Response('not found', { status: 404 })
    let res = await net.fetch(pathToFileURL(file).toString()).catch(() => null)
    // 화면 안의 주소(/pos/…)로 새로 고쳐도 화면이 뜨게 — SPA 의 index.html 로 돌립니다.
    if ((res === null || !res.ok) && !path.extname(file)) {
      const [first] = url.pathname.split('/').filter(Boolean)
      file = resolve(new URL(`${ORIGIN}/${first}/index.html`))
      res = file === null ? null : await net.fetch(pathToFileURL(file).toString()).catch(() => null)
    }
    if (res === null || !res.ok) return new Response('not found', { status: 404 })
    const headers = new Headers(res.headers)
    headers.set('Content-Security-Policy', contentSecurityPolicy(readConfig()?.serverUrl ?? null))
    return new Response(res.body, { status: 200, headers })
  })
}

function startUrl(): string {
  const config = readConfig()
  if (config === null) return `${ORIGIN}/setup/index.html`
  const target = screenFor(config.device)
  return 'screen' in target ? `${ORIGIN}/${target.screen}/index.html` : `${ORIGIN}/setup/index.html`
}

let window: BrowserWindow | null = null
let ledger: Ledger | null = null
const crashes: number[] = []

function createWindow(): void {
  const config = readConfig()
  const kiosk = config?.device.deviceType === 'KIOSK'
  const windowed = process.env.SUNMOON_WINDOWED === '1'
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#111418',
    autoHideMenuBar: true,
    // §2.1 — 고정. 바꾸지 마십시오.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, '..', 'preload', 'index.js')
    },
    kiosk: kiosk && !windowed,
    fullscreen: !windowed
  })

  // 셸 밖으로는 나가지 않습니다 — 링크든 스크립트든.
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // 화면이 죽으면 다시 띄웁니다(§5.3). 1분에 3번 넘게 죽으면 멈추고 알립니다 —
  // 무한 재시작은 매장에서 "화면이 깜빡이기만 한다" 로 보이고 원인을 가립니다.
  window.webContents.on('render-process-gone', (_event, details) => {
    const now = Date.now()
    crashes.push(now)
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift()
    console.error('화면 프로세스가 죽었습니다', details.reason)
    if (crashes.length > 3) {
      void window?.loadURL(`${ORIGIN}/setup/crashed.html`)
      return
    }
    window?.loadURL(startUrl())
  })

  void window.loadURL(startUrl())
}

/**
 * 하루 한 번 화면을 새로 띄웁니다(§5.3) — 며칠씩 켜 둔 브라우저의 메모리 누수.
 * ▶ 기본값: 새벽 4시(대부분 매장의 마감 뒤, 개점 전). 영업 중에는 하지 않습니다.
 */
function scheduleDailyReload(): void {
  let lastDay = new Date().toDateString()
  setInterval(() => {
    const now = new Date()
    if (now.getHours() === 4 && now.toDateString() !== lastDay) {
      lastDay = now.toDateString()
      window?.loadURL(startUrl())
    }
  }, 10 * 60_000)
}

/**
 * 창을 보이지 않고 셋업 화면과 화면 번들을 열어 봅니다 — 개발 PC·CI 에서 셸이 제대로
 * 묶였는지(scheme, preload, CSP) 사람 화면을 가리지 않고 확인하는 용도.
 * {@code SUNMOON_SMOKE=1 electron .} → 결과를 한 줄 JSON 으로 찍고 끝납니다.
 */
async function smoke(): Promise<void> {
  const probe = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, '..', 'preload', 'index.js')
    }
  })
  const result: Record<string, unknown> = {}
  try {
    // 코드가 주어지면 진짜로 페어링하고, 화면이 그 신원으로 Device Server 를 부르는지까지 봅니다.
    if (process.env.SUNMOON_SMOKE_CODE) {
      const { pair } = await import('./identity')
      const paired = await pair(DEFAULT_SERVER, process.env.SUNMOON_SMOKE_CODE)
      result.pair = paired.ok ? { ok: true, device: paired.device } : paired
      if (paired.ok) {
        const screen = paired.device.deviceType === 'POS' ? 'pos' : 'kds'
        await probe.loadURL(`${ORIGIN}/${screen}/index.html`)
        result.paired = await probe.webContents.executeJavaScript(`(async () => {
          const id = window.sunmoon.identity.get()
          const res = await fetch(id.serverUrl + '/orders', { headers: { Authorization: 'Device ' + id.token } })
          const body = await res.json()
          return { storeId: id.storeId, deviceId: id.deviceId, tokenLength: id.token.length,
                   ordersStatus: res.status, ordersOnlyOwnStore: body.every(o => o.storeId === id.storeId) }
        })()`)
        if (paired.device.deviceType === 'POS') {
          // 화면이 남의 매장·단말을 적어 보내도 main 이 이 기기의 신원으로 바꾸는지.
          result.ledger = await probe.webContents.executeJavaScript(`(async () => {
            const l = window.sunmoon.ledger
            const row = await l.mint('someone-else', 'pos-99', '2099-01-01', 1)
            await l.confirm(row.id, { smoke: true })
            return { tranNo: row.tranNo, storeId: row.storeId, deviceId: row.deviceId,
                     unsent: await l.unsentCount(), migrated: await l.migrated() }
          })()`)
          result.ledgerFile = require('node:fs').existsSync(
            require('node:path').join(app.getPath('userData'), 'ledger.sqlite'))
        }
        const { readConfig } = await import('./config')
        const raw = require('node:fs').readFileSync(
          require('node:path').join(app.getPath('userData'), 'config.json'), 'utf8')
        result.tokenOnDiskIsEncrypted = readConfig() !== null && !raw.includes(readConfig()!.token)
      }
    }
    await probe.loadURL(`${ORIGIN}/setup/index.html`)
    result.setup = await probe.webContents.executeJavaScript(
      `({ title: document.title, hasSetup: typeof window.sunmoon?.setup?.pair === 'function',
          hasRequire: typeof require !== 'undefined',
          // 토큰은 찍지 않습니다 — 로그로 새는 자격이 가장 흔한 누출입니다.
          identity: (() => { const id = window.sunmoon?.identity?.get(); return id ? { ...id, token: '(' + id.token.length + '자)' } : null })() })`)
    for (const screen of ['pos', 'kds']) {
      try {
        await probe.loadURL(`${ORIGIN}/${screen}/index.html`)
        result[screen] = await probe.webContents.executeJavaScript(
          `({ title: document.title, root: !!document.getElementById('root')?.children.length,
              hasSetup: typeof window.sunmoon?.setup !== 'undefined' })`)
      } catch (e) {
        result[screen] = `열지 못함: ${String(e)}`
      }
    }
    const blocked = await probe.webContents.executeJavaScript(
      `fetch('https://example.com').then(() => 'fetched', () => 'blocked')`)
    result.externalFetch = blocked
  } catch (e) {
    result.error = String(e)
  }
  console.log('SMOKE ' + JSON.stringify(result))
  app.exit(0)
}

// 같은 PC 에서 두 번 켜면 두 번째는 첫 번째를 앞으로 가져오고 끝납니다 —
// 같은 기기 신원으로 두 연결이 서로를 밀어내는 일(4001)을 셸 단에서 막습니다.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  app.whenReady().then(() => {
    // 화면에서 쓰지 않는 권한(카메라·위치·알림 등)은 전부 거절.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    serve()
    registerIpc({
      // 원장은 처음 쓸 때 엽니다 — KDS-MAIN 셸은 파일을 만들지도 않습니다.
      ledger: () => (ledger ??= new Ledger(path.join(app.getPath('userData'), 'ledger.sqlite'))),
      defaultServerUrl: DEFAULT_SERVER,
      onPaired: () => window?.loadURL(startUrl()),
      onForgotten: () => window?.loadURL(`${ORIGIN}/setup/index.html`)
    })
    if (app.isPackaged) {
      // Windows 로그인 시 자동 시작 (§5.3).
      app.setLoginItemSettings({ openAtLogin: true })
    }
    if (process.env.SUNMOON_SMOKE === '1') {
      void smoke()
      return
    }
    createWindow()
    scheduleDailyReload()
  })

  app.on('window-all-closed', () => app.quit())
  // 원장을 닫고 끝냅니다 — WAL 이 본 파일로 합쳐집니다.
  app.on('will-quit', () => ledger?.close())
}
