// 화면 번들을 묶고 서명합니다 (store-app.md §8.1). 빌드하는 PC 에서.
//
//   node scripts/pack-ui.mjs pos 2026.09.28-1 [../sun-moon-terminal-pos/dist]
//
// 결과: release/ui-pos-<버전>.sunmoonui (+ .sig), 그리고 BO 배포 화면에 넣을 checksum.
// 형식은 gzip(JSON {screen, version, files: {경로: base64}}) — zip 라이브러리 없이 Node 내장만.
// 서명은 묶음 바이트 전체에 대한 ed25519. 셸은 checksum 과 서명을 둘 다 확인합니다.
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const [screen, version, distArg] = process.argv.slice(2)
if (!screen || !version || !/^[a-z]+$/.test(screen) || !/^[0-9A-Za-z.\-]+$/.test(version)) {
  console.error('사용법: node scripts/pack-ui.mjs <pos|kds> <버전> [dist 경로]')
  process.exit(1)
}
const dist = distArg ?? path.resolve('..', `sun-moon-terminal-${screen}`, 'dist')
const keyFile = process.env.SUNMOON_UI_KEY ?? path.join(os.homedir(), '.sunmoon', 'ui-signing-ed25519.pem')

const files = {}
function walk(dir, prefix = '') {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) walk(full, rel)
    else files[rel] = readFileSync(full).toString('base64')
  }
}
walk(dist)
if (!files['index.html']) {
  console.error(`index.html 이 없습니다: ${dist} — 그 저장소에서 npm run build 부터`)
  process.exit(1)
}

const bundle = gzipSync(Buffer.from(JSON.stringify({ screen, version, files })))
const signature = sign(null, bundle, createPrivateKey(readFileSync(keyFile)))
mkdirSync('release', { recursive: true })
const out = path.join('release', `ui-${screen}-${version}.sunmoonui`)
writeFileSync(out, bundle)
writeFileSync(`${out}.sig`, signature.toString('base64'))
console.log(`${out} (${bundle.length} bytes, ${Object.keys(files).length} files)`)
console.log(`checksum (SHA-256): ${createHash('sha256').update(bundle).digest('hex')}`)
console.log('서버 :8000/releases/ui/ 에 두 파일을 올리고, BO 배포 화면에 program=ui-' + screen + ' 로 등록하십시오.')
