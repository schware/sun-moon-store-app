import { normaliseServerUrl, screenFor, type Device } from './roles'
import { writeConfig } from './config'

/** 설정 화면에서 고르는 종류 — 셸은 하드웨어가 있는 자리에만 갑니다(ADR-0015). */
export type Kind = 'POS' | 'KIOSK' | 'KDS_MAIN'

/**
 * 설정 화면의 매장·장비·종류를 이 기기의 설정으로 (store-app.md §5.1). 웹 단말의 단말 등록과
 * 같은 값입니다. 장비가 BO 에 등록돼 있는지는 Device Server 가 연결할 때 확인합니다.
 */
export function register(rawServerUrl: string, storeId: string, deviceId: string, kind: string):
    { ok: true; device: Device } | { ok: false; error: string } {
  const serverUrl = normaliseServerUrl(rawServerUrl)
  if (!serverUrl) {
    return { ok: false, error: '서버 주소가 올바르지 않습니다 (예: http://61.73.134.2:8087)' }
  }
  const store = storeId.trim()
  const id = deviceId.trim()
  if (!store || !id) {
    return { ok: false, error: '매장 ID 와 장비 ID 를 넣으십시오' }
  }
  const device: Device = kind === 'KDS_MAIN'
    ? { storeId: store, deviceId: id, deviceType: 'KDS', kdsRole: 'MAIN' }
    : { storeId: store, deviceId: id, deviceType: kind, kdsRole: null }
  const target = screenFor(device)
  if ('refused' in target) {
    return { ok: false, error: target.refused }
  }
  writeConfig(serverUrl, device)
  return { ok: true, device }
}
