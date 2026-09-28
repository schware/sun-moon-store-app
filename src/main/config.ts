import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Device } from './roles'

/**
 * 이 기기가 누구인가 — {@code %APPDATA%/SunMoon Store/config.json} (store-app.md §5.1).
 *
 * <p>토큰은 {@code safeStorage}(Windows 에서는 DPAPI)로 암호화해 둡니다. 같은 Windows
 * 사용자만 풀 수 있어서, 파일을 복사해 가도 다른 PC 에서는 쓸 수 없습니다.
 *
 * <p>암호화를 못 쓰는 환경(드묾)에서도 <b>멈추지 않습니다</b> — 매장 화면엔 막다른
 * 길을 두지 않습니다. 평문으로 두되 {@code tokenProtected: false} 로 표시하고 로그에 남깁니다.
 */

export interface StoredConfig {
  serverUrl: string
  device: Device
  token: string
  tokenProtected: boolean
  pairedAt: string
}

interface OnDisk {
  serverUrl: string
  device: Device
  token: string          // base64(암호문) 또는 평문
  tokenProtected: boolean
  pairedAt: string
}

function file(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function readConfig(): StoredConfig | null {
  let raw: OnDisk
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as OnDisk
  } catch {
    return null
  }
  try {
    const token = raw.tokenProtected
      ? safeStorage.decryptString(Buffer.from(raw.token, 'base64'))
      : raw.token
    return { ...raw, token }
  } catch (e) {
    // 다른 사용자·다른 PC 에서 복사된 파일이면 여기서 풀리지 않습니다. 없는 것으로 보고
    // 다시 페어링하게 합니다 — 복사한 자격으로 다른 기기 행세를 못 하는 것이 목적입니다.
    console.warn('기기 토큰을 풀 수 없습니다 — 다시 페어링합니다', e)
    return null
  }
}

export function writeConfig(serverUrl: string, device: Device, token: string): void {
  const canProtect = safeStorage.isEncryptionAvailable()
  if (!canProtect) {
    console.warn('safeStorage 를 쓸 수 없어 기기 토큰을 평문으로 둡니다')
  }
  const onDisk: OnDisk = {
    serverUrl,
    device,
    token: canProtect ? safeStorage.encryptString(token).toString('base64') : token,
    tokenProtected: canProtect,
    pairedAt: new Date().toISOString()
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 })
}

export function forgetConfig(): void {
  try {
    fs.unlinkSync(file())
  } catch {
    // 없으면 이미 잊은 것입니다.
  }
}
