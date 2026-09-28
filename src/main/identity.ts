import { net } from 'electron'
import { normaliseServerUrl, screenFor, type Device } from './roles'
import { writeConfig } from './config'

/**
 * 페어링 코드를 기기 토큰으로 (store-app.md §3, §5.1).
 *
 * <p>요청은 <b>main 프로세스</b>가 합니다. 화면(셋업 페이지)은 코드와 서버 주소만
 * 넘기고 토큰은 끝내 보지 않습니다 — 화면에 구멍이 있어도 토큰은 거기 없습니다.
 * (페어링 뒤 화면이 요청에 쓰려고 토큰을 받아 가는 것은 별개이고, 그건 §5.2 대로입니다.)
 */
export async function pair(rawServerUrl: string, code: string): Promise<{ ok: true; device: Device } | { ok: false; error: string }> {
  const serverUrl = normaliseServerUrl(rawServerUrl)
  if (!serverUrl) {
    return { ok: false, error: '서버 주소가 올바르지 않습니다 (예: http://211.217.183.232:8087)' }
  }
  const digits = code.replace(/\s/g, '')
  if (!/^[0-9]{6}$/.test(digits)) {
    return { ok: false, error: '코드는 숫자 6자리입니다' }
  }

  let res: Response
  try {
    res = await net.fetch(`${serverUrl}/pos/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: digits })
    })
  } catch (e) {
    return { ok: false, error: `서버에 연결할 수 없습니다 (${serverUrl})` }
  }
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    return { ok: false, error: typeof body.error === 'string' ? body.error : `페어링 실패 (${res.status})` }
  }

  const device: Device = {
    storeId: String(body.storeId),
    deviceId: String(body.deviceId),
    deviceType: String(body.deviceType),
    kdsRole: body.kdsRole == null ? null : String(body.kdsRole)
  }
  const target = screenFor(device)
  if ('refused' in target) {
    // 코드는 이미 쓰였습니다(한 번만). BO 에서 맞는 장비의 코드를 새로 받아야 합니다.
    return { ok: false, error: `${target.refused} (이 코드는 이미 쓰였습니다 — BO 에서 새로 받으십시오)` }
  }
  writeConfig(serverUrl, device, String(body.token))
  return { ok: true, device }
}
