import { app, net } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readConfig } from './config'
import { BundleRejected, installedVersion, promote, rollback, unpack, verifyBundle } from './bundle'
import { UI_SIGNING_PUBLIC_KEY } from './updateKey'

/**
 * 화면 번들 업데이트 (store-app.md §8.1).
 *
 * <pre>
 *   몇 분마다 GET /pos/programs → ui-&lt;화면&gt; 새 버전 → 받기 → checksum·서명 확인
 *     → userData/ui/&lt;화면&gt;.next 에 풀기 → ack DOWNLOADED
 *   셸이 다음에 시작할 때 → .next 를 지금 것으로, 지금 것은 .prev 로 → ack INSTALLED
 *   새 번들로 띄운 뒤 30초 안에 화면이 죽으면 → .prev 로 되돌림 → ack FAILED
 * </pre>
 *
 * <p><b>기본값은 꺼져 있습니다</b>({@code SUNMOON_UI_UPDATES=on} 일 때만). 설계 §11:
 * Device Server 인증을 {@code enforce} 로 올리기 전에는 자동 업데이트를 켜지 않습니다.
 * 서명 확인이 있어도, 켜는 순서를 지키는 것이 설계의 약속입니다.
 *
 * <p>적용은 <b>시작할 때만</b>입니다(설계의 "마감 뒤 또는 다음 시작 때" 중 뒤쪽). 셸은 새벽
 * 4시에 화면을 새로 띄우지만 셸 자체는 다시 시작하지 않으므로, 영업 중에 화면이 바뀌는
 * 일은 없습니다.
 */

export function enabled(): boolean {
  return process.env.SUNMOON_UI_UPDATES === 'on'
}

export function updatesRoot(): string {
  return path.join(app.getPath('userData'), 'ui')
}

const POLL_MS = 10 * 60_000
const CRASH_WINDOW_MS = 30_000
let promotedAt: { screen: string; version: string; at: number } | null = null

async function api(p: string, init?: RequestInit): Promise<Response> {
  const config = readConfig()
  if (!config) throw new Error('페어링되지 않은 기기입니다')
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Device ${config.token}`)
  return net.fetch(`${config.serverUrl}${p}`, { ...init, headers })
}

async function ack(screen: string, version: string, status: 'DOWNLOADED' | 'INSTALLED' | 'FAILED', message?: string) {
  const config = readConfig()
  if (!config) return
  await api('/pos/programs/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeId: config.device.storeId, deviceType: config.device.deviceType, deviceNo: config.device.deviceId,
      program: `ui-${screen}`, version, status, message: message ?? null
    })
  }).catch((e) => console.warn('업데이트 결과를 알리지 못했습니다', e))
}

/** 시작할 때: 받아 둔 번들이 있으면 적용합니다. */
export function applyPending(screen: string): void {
  if (!enabled()) return
  try {
    const version = promote(updatesRoot(), screen)
    if (version) {
      promotedAt = { screen, version, at: Date.now() }
      console.log(`화면 번들 ${screen} ${version} 적용`)
      void ack(screen, version, 'INSTALLED')
    }
  } catch (e) {
    console.error('화면 번들을 적용하지 못했습니다 — 지금 것으로 계속합니다', e)
  }
}

/**
 * 화면이 죽었을 때 셸이 묻습니다: 방금 바꾼 번들 탓인가? 30초 안이면 되돌리고 참.
 * 되돌린 번들은 FAILED 로 알려서 BO 배포 현황에 보이게 합니다.
 */
export function rollbackIfFresh(): boolean {
  if (!promotedAt || Date.now() - promotedAt.at > CRASH_WINDOW_MS) return false
  const { screen, version } = promotedAt
  promotedAt = null
  if (rollback(updatesRoot(), screen)) {
    console.error(`화면 번들 ${screen} ${version} 이 곧바로 죽어 되돌렸습니다`)
    void ack(screen, version, 'FAILED', '적용 30초 안에 화면이 죽어 되돌림')
    return true
  }
  return false
}

async function check(screen: string): Promise<void> {
  const config = readConfig()
  if (!config) return
  const q = new URLSearchParams({
    storeId: config.device.storeId, deviceType: config.device.deviceType,
    deviceNo: config.device.deviceId, issue: 'true'
  })
  const res = await api(`/pos/programs?${q}`)
  if (!res.ok) return
  const body = await res.json() as { programs?: Array<Record<string, unknown>> }
  const plan = (body.programs ?? []).find((p) => p.program === `ui-${screen}`)
  if (!plan || plan.upToDate === true) return
  const version = String(plan.targetVersion)
  const next = path.join(updatesRoot(), `${screen}.next`)
  if (installedVersion(next) === version) return            // 이미 받아 둠 — 시작할 때 적용
  if (installedVersion(path.join(updatesRoot(), screen)) === version) return

  const url = String(plan.packageUrl ?? '')
  if (!/^https?:\/\//.test(url)) {
    await ack(screen, version, 'FAILED', `받을 주소가 올바르지 않습니다: ${url}`)
    return
  }
  try {
    const [bundleRes, sigRes] = await Promise.all([net.fetch(url), net.fetch(`${url}.sig`)])
    if (!bundleRes.ok || !sigRes.ok) throw new Error(`받지 못했습니다 (${bundleRes.status}/${sigRes.status})`)
    const bytes = Buffer.from(await bundleRes.arrayBuffer())
    const bundle = verifyBundle(bytes, await sigRes.text(),
      plan.checksum ? String(plan.checksum) : null, UI_SIGNING_PUBLIC_KEY)
    if (bundle.screen !== screen || bundle.version !== version) {
      throw new BundleRejected(`번들이 다른 것을 말합니다 (${bundle.screen} ${bundle.version})`)
    }
    fs.mkdirSync(updatesRoot(), { recursive: true })
    unpack(bundle, next)
    await ack(screen, version, 'DOWNLOADED')
    console.log(`화면 번들 ${screen} ${version} 받음 — 다음 시작 때 적용`)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`화면 번들 ${screen} ${version} 을 받지 못했습니다`, message)
    fs.rmSync(next, { recursive: true, force: true })
    await ack(screen, version, 'FAILED', message)
  }
}

export function startPolling(screen: () => string | null): void {
  if (!enabled()) {
    console.log('화면 번들 자동 업데이트: 꺼짐 (SUNMOON_UI_UPDATES=on 으로 켬 — Device Server enforce 뒤에)')
    return
  }
  const tick = () => {
    const s = screen()
    if (s) void check(s).catch((e) => console.warn('업데이트 확인 실패', e))
  }
  setTimeout(tick, 30_000)
  setInterval(tick, POLL_MS)
}
