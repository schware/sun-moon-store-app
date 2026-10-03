// 화면 번들을 셸에 싣습니다 (store-app.md §5.4 — 1단계에서는 설치 파일에 같이).
//
// 화면은 sun-moon-terminals 저장소에서 빌드합니다(npm run build). 여기는 그 <화면>/dist 를 ui/<화면>/ 로 옮길 뿐입니다.
// 옆에 저장소가 없거나 빌드 전이면 그 화면은 건너뛰고 말합니다 — 조용히 빈 화면을
// 싣는 것보다 낫습니다. 경로는 SUNMOON_TERMINALS 로 바꿀 수 있습니다.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = process.env.SUNMOON_TERMINALS ?? path.resolve('..')
const screens = {
  pos: path.join(root, 'sun-moon-terminals', 'pos', 'dist'),
  kds: path.join(root, 'sun-moon-terminals', 'kds', 'dist'),
  // KIOSK 는 손님 화면(channel-order frontend)을 그대로 씁니다 — 그 빌드는 Spring 의 static 으로 나옵니다.
  kiosk: process.env.SUNMOON_KIOSK_DIST ?? path.resolve(root, '..', 'Java-Platform',
    'sun-moon-java-platform-channel-order', 'src', 'main', 'resources', 'static')
}

let missing = 0
for (const [screen, dist] of Object.entries(screens)) {

  const target = path.join('ui', screen)
  if (!existsSync(path.join(dist, 'index.html'))) {
    console.warn(`건너뜀: ${screen} — ${dist} 에 빌드가 없습니다 (sun-moon-terminals 에서 npm run build)`)
    missing++
    continue
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(dist, target, { recursive: true })
  console.log(`${dist} → ui/${screen}`)
}
if (missing > 0) process.exitCode = 1
