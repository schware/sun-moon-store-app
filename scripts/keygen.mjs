// 화면 번들 서명 키 (store-app.md §8.1). **빌드하는 PC 에서 한 번만.**
//
// 개인키는 ~/.sunmoon/ui-signing-ed25519.pem (이 사용자만 읽음). 서버에도 저장소에도 두지
// 마십시오 — 서명은 "우리 빌드 기계가 만든 것만 돈다" 를 셸이 확인하는 마지막 벽이고,
// 개인키가 서버에 있으면 서버를 뺏긴 날 그 벽도 함께 넘어갑니다.
//
// 공개키는 출력합니다 — src/main/updateKey.ts 에 붙여 넣으십시오(공개해도 되는 값).
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = path.join(os.homedir(), '.sunmoon')
const file = path.join(dir, 'ui-signing-ed25519.pem')
if (existsSync(file)) {
  console.error(`이미 있습니다: ${file} — 바꾸려면 먼저 옮기십시오(바꾸면 모든 셸의 공개키도 바꿔야 합니다)`)
  process.exit(1)
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
mkdirSync(dir, { recursive: true })
writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
console.log(`개인키: ${file}`)
console.log('공개키 (updateKey.ts 에):')
console.log(publicKey.export({ type: 'spki', format: 'pem' }))
