import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Device } from './roles'

/**
 * 이 기기가 누구인가 — {@code %APPDATA%/SunMoon Store/config.json} (store-app.md §5.1).
 *
 * <p>첫 실행 때 설정 화면에서 넣은 서버 주소와 매장·장비·종류입니다. 웹 단말의 단말 등록과
 * 같은 값이고, 토큰은 없습니다(2026-10-01 — 단말 토큰 제외).
 */

export interface StoredConfig {
  serverUrl: string
  device: Device
  savedAt: string
}

function file(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function readConfig(): StoredConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<StoredConfig>
    if (!raw.serverUrl || !raw.device?.storeId || !raw.device?.deviceId) return null
    return { serverUrl: raw.serverUrl, device: raw.device, savedAt: raw.savedAt ?? '' }
  } catch {
    return null
  }
}

export function writeConfig(serverUrl: string, device: Device): void {
  const onDisk: StoredConfig = { serverUrl, device, savedAt: new Date().toISOString() }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(onDisk, null, 2), { encoding: 'utf8' })
}

export function forgetConfig(): void {
  try {
    fs.unlinkSync(file())
  } catch {
    // 없으면 이미 잊은 것입니다.
  }
}
