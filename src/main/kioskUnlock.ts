import { net } from 'electron'
import { readConfig } from './config'

/**
 * KIOSK 관리자 PIN 확인 (store-app.md §5.3). <b>셸은 PIN 을 비교하지 않습니다</b> — Device
 * Server 에 물어봅니다(해시는 거기에만). 서버에 닿지 않으면 풀 수 없습니다: 그때는 Windows
 * 쪽(작업 관리자 등)으로 끕니다. 오프라인에서 풀리는 PIN 은 PC 를 가진 사람이 풀 수 있는 PIN 입니다.
 */
export async function unlockKiosk(pin: string): Promise<{ ok: boolean; error?: string }> {
  const config = readConfig()
  if (!config) return { ok: false, error: '페어링되지 않은 기기입니다' }
  try {
    const res = await net.fetch(`${config.serverUrl}/pos/kiosk/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Device ${config.token}` },
      body: JSON.stringify({ pin })
    })
    const body = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
    return res.ok && body.ok ? { ok: true } : { ok: false, error: body.error ?? `확인하지 못했습니다 (${res.status})` }
  } catch {
    return { ok: false, error: '서버에 닿지 않아 확인할 수 없습니다' }
  }
}
