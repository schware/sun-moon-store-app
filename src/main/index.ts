import { app, BrowserWindow, protocol, net, session } from 'electron'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readConfig } from './config'
import { registerIpc } from './ipc'
import { Ledger } from './ledger'
import * as updater from './updater'
import { existsSync } from 'node:fs'
import { contentSecurityPolicy, folderFor, screenFor, urlPrefix } from './roles'

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
  const [prefix, ...rest] = parts
  const first = folderFor(prefix)
  // 받아서 적용한 번들(§8.1)이 있으면 그것이, 없으면 설치 파일에 들어 있던 것.
  const updated = path.join(updater.updatesRoot(), first)
  const root = first === 'setup' ? setupRoot()
    : existsSync(path.join(updated, 'index.html')) ? updated : path.join(uiRoot(), first)
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
  return 'screen' in target ? `${ORIGIN}/${urlPrefix(target.screen)}/index.html` : `${ORIGIN}/setup/index.html`
}

let window: BrowserWindow | null = null
let adminWindow: BrowserWindow | null = null

/** KIOSK 관리자 창 (§5.3) — 같은 가두기 설정의 작은 모달. */
function openAdmin(): void {
  if (adminWindow || !window) {
    adminWindow?.focus()
    return
  }
  adminWindow = new BrowserWindow({
    parent: window, modal: true, width: 480, height: 560, resizable: false,
    minimizable: false, maximizable: false, autoHideMenuBar: true, backgroundColor: '#111418',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false,
      preload: path.join(__dirname, '..', 'preload', 'index.js')
    }
  })
  adminWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  adminWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  adminWindow.on('closed', () => { adminWindow = null })
  void adminWindow.loadURL(`${ORIGIN}/setup/unlock.html`)
}
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
    // 방금 적용한 번들 탓이면 되돌리고 다시 띄웁니다(§8.1 5).
    if (updater.rollbackIfFresh()) {
      window?.loadURL(startUrl())
      return
    }
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
        if (paired.device.deviceType === 'KIOSK') {
          await probe.loadURL(startUrl())
          await new Promise((r) => setTimeout(r, 3000))   // 메뉴판을 읽을 시간
          result.kiosk = await probe.webContents.executeJavaScript(`(async () => ({
            url: location.pathname,
            kioskMode: document.querySelector('[data-kind="kiosk"]') !== null,
            tiles: document.querySelectorAll('.tile').length,
            payment: await window.sunmoon.payment.approve(1000),
            ledger: typeof window.sunmoon.ledger?.mint === 'function'
          }))()`)
          if (process.env.SUNMOON_SMOKE_PIN) {
            // 관리자 탈출: 구석을 5번 → 관리자 창 → 틀린 PIN → 맞는 PIN → 창 모드
            window = probe
            await probe.webContents.executeJavaScript(`(() => {
              for (let i = 0; i < 5; i++) window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10 }))
            })()`)
            for (let i = 0; i < 20 && !adminWindow; i++) await new Promise((r) => setTimeout(r, 100))
            const admin = adminWindow as BrowserWindow | null
            if (!admin) {
              result.kioskEscape = { error: '관리자 창이 안 열렸습니다' }
            } else {
              await new Promise<void>((r) => admin.webContents.once('did-finish-load', () => r()))
              const wrong = await admin.webContents.executeJavaScript('window.sunmoon.kioskAdmin.unlock("0000")')
              const right = await admin.webContents.executeJavaScript(
                `window.sunmoon.kioskAdmin.unlock(${JSON.stringify(process.env.SUNMOON_SMOKE_PIN)})`)
              const act = await admin.webContents.executeJavaScript('window.sunmoon.kioskAdmin.act("window")')
              result.kioskEscape = { opened: true, wrong, right, act, adminClosed: adminWindow === null }
            }
          }
          if (process.env.SUNMOON_SMOKE_ORDER === '1') {
            // 손님처럼 누릅니다: 첫 메뉴 → 결제하기 → 끝 화면의 번호.
            result.kioskOrder = await probe.webContents.executeJavaScript(`(async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms))
              const tile = [...document.querySelectorAll('.tile')].find((t) => !t.disabled)
              if (!tile) return { error: '누를 메뉴가 없습니다', page: document.body.innerText.slice(0, 200) }
              tile.click()
              await wait(300)
              const pay = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('결제하기'))
              if (!pay) return { error: '결제하기 버튼이 없습니다' }
              pay.click()
              for (let i = 0; i < 40 && !document.querySelector('.kiosk-done'); i++) await wait(250)
              const done = document.querySelector('.kiosk-done')
              return done
                ? { number: document.querySelector('.kiosk-done-number')?.textContent, text: done.innerText.slice(0, 160) }
                : { error: document.querySelector('.error')?.textContent ?? '끝 화면이 안 떴습니다' }
            })()`)
            await new Promise((r) => setTimeout(r, 2000))   // 매출 올리기
            result.kioskLedger = await probe.webContents.executeJavaScript(
              '(async () => ({ pending: (await window.sunmoon.ledger.pending()).length }))()')
          }
        }
        if (paired.device.deviceType === 'KDS' && paired.device.kdsRole === 'MAIN') {
          // 쌓인 라벨을 찍는 길 — 화면이 셸에 작업 번호만 넘기고, 셸이 프린터를 골라 찍고 ack.
          result.labels = await probe.webContents.executeJavaScript(
            'window.sunmoon.printer ? window.sunmoon.printer.queuedLabels() : "no printer bridge"')
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
      onForgotten: () => window?.loadURL(`${ORIGIN}/setup/index.html`),
      kiosk: {
        openAdmin,
        closeAdmin: () => { adminWindow?.close() },
        windowMode: () => {
          window?.setKiosk(false)
          window?.setFullScreen(false)
        },
        quit: () => app.quit()
      }
    })
    if (app.isPackaged) {
      // Windows 로그인 시 자동 시작 (§5.3).
      app.setLoginItemSettings({ openAtLogin: true })
    }
    if (process.env.SUNMOON_SMOKE === '1') {
      void smoke()
      return
    }
    // 받아 둔 화면 번들은 시작할 때만 적용합니다 — 영업 중에 화면이 바뀌지 않게(§8.1 3).
    const screenNow = () => {
      const config = readConfig()
      const target = config ? screenFor(config.device) : null
      return target && 'screen' in target ? target.screen : null
    }
    const screen = screenNow()
    if (screen) updater.applyPending(screen)
    createWindow()
    scheduleDailyReload()
    updater.startPolling(screenNow)
  })

  app.on('window-all-closed', () => app.quit())
  // 원장을 닫고 끝냅니다 — WAL 이 본 파일로 합쳐집니다.
  app.on('will-quit', () => ledger?.close())
}
