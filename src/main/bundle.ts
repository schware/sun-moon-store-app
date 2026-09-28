import { createHash, createPublicKey, verify } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'

/**
 * 화면 번들 확인과 풀기 (store-app.md §8.1). Electron 을 부르지 않아 셸 없이 시험합니다.
 *
 * <p>순서가 요점입니다: <b>checksum → 서명 → 모양 → 풀기</b>. 서명이 맞기 전에는 한 바이트도
 * 디스크에 풀지 않습니다. 경로는 번들 안의 값이라 뿌리 밖으로 나가는 경로(../)는 거절합니다.
 */

export interface Bundle {
  screen: string
  version: string
  files: Record<string, string>
}

export class BundleRejected extends Error {}

export function verifyBundle(bytes: Buffer, signatureB64: string, checksum: string | null,
                             publicKeyPem: string): Bundle {
  if (checksum) {
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual.toLowerCase() !== checksum.trim().toLowerCase()) {
      throw new BundleRejected(`checksum 이 다릅니다 (받은 것 ${actual.slice(0, 12)}…)`)
    }
  }
  const ok = verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(signatureB64.trim(), 'base64'))
  if (!ok) {
    throw new BundleRejected('서명이 맞지 않습니다 — 우리 빌드 기계가 만든 번들이 아닙니다')
  }
  let bundle: Bundle
  try {
    bundle = JSON.parse(gunzipSync(bytes).toString('utf8')) as Bundle
  } catch {
    throw new BundleRejected('번들 모양이 아닙니다')
  }
  if (!bundle.files || typeof bundle.files['index.html'] !== 'string') {
    throw new BundleRejected('번들에 index.html 이 없습니다')
  }
  return bundle
}

/** 확인된 번들을 {@code target} 에 풉니다(있던 것은 지움). 뿌리 밖으로 나가는 경로는 거절. */
export function unpack(bundle: Bundle, target: string): void {
  const root = path.resolve(target)
  fs.rmSync(root, { recursive: true, force: true })
  for (const [rel, b64] of Object.entries(bundle.files)) {
    const file = path.resolve(root, rel)
    if (!file.startsWith(root + path.sep)) {
      throw new BundleRejected(`번들 밖을 가리키는 경로입니다: ${rel}`)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(b64, 'base64'))
  }
  fs.writeFileSync(path.join(root, '.version'), bundle.version)
}

export function installedVersion(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, '.version'), 'utf8').trim() || null
  } catch {
    return null
  }
}

/**
 * 받아 둔 다음 번들을 지금 것과 바꿉니다: now → prev, next → now.
 * 적용 시점(셸 시작 때)에만 부릅니다 — 영업 중에는 받아만 둡니다.
 *
 * @return 바꿨으면 새 버전
 */
export function promote(base: string, screen: string): string | null {
  const next = path.join(base, `${screen}.next`)
  const now = path.join(base, screen)
  const prev = path.join(base, `${screen}.prev`)
  const version = installedVersion(next)
  if (!version) return null
  fs.rmSync(prev, { recursive: true, force: true })
  if (fs.existsSync(now)) fs.renameSync(now, prev)
  fs.renameSync(next, now)
  return version
}

/** 새 번들로 띄운 뒤 곧바로 죽으면 되돌립니다(§8.1 5). prev 가 없으면 아무것도 안 함. */
export function rollback(base: string, screen: string): boolean {
  const now = path.join(base, screen)
  const prev = path.join(base, `${screen}.prev`)
  if (!fs.existsSync(prev)) return false
  const broken = path.join(base, `${screen}.broken`)
  fs.rmSync(broken, { recursive: true, force: true })
  if (fs.existsSync(now)) fs.renameSync(now, broken)
  fs.renameSync(prev, now)
  return true
}
