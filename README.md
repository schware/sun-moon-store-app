# sun-moon-store-app

매장 단말 셸 — **POS · KDS-MAIN** (KIOSK 는 7단계). Electron.

설계: umbrella `sun-moon-java-platform/docs/design/store-app.md` §5, ADR-0015.
셸은 **하드웨어가 있는 자리**에만 갑니다. KDS SUB 와 DID 는 웹 화면 그대로입니다.

## 하는 일

- **페어링** — BO 장비 화면의 6자리 코드. 토큰은 main 프로세스가 받아
  `safeStorage`(Windows DPAPI)로 암호화해 `%APPDATA%/SunMoon Store/config.json` 에 둡니다.
- **역할의 화면 열기** — POS → `ui/pos`, KDS-MAIN → `ui/kds`. 화면은
  `sunmoon://app/<화면>/` 으로 엽니다(번들이 `/pos/assets/…` 절대 경로로 빌드돼 있어서).
- **늘 켜져 있기** — Windows 로그인 시 시작, 화면이 죽으면 다시 띄움(1분에 3번 넘으면
  멈추고 알림), 새벽 4시에 화면 새로 띄움, 두 번 켜면 첫 창으로.
- **화면 가두기** (§2.1, 바꾸지 마십시오) — `contextIsolation`, `sandbox`, Node 없음,
  셸 밖으로 이동·새 창 금지, CSP(스크립트는 셸 안, 연결은 Device Server 한 곳), 권한 요청 전부 거절.
  화면에 여는 것은 `window.sunmoon` 하나이고, 채널은 `src/main/ipc.ts` 의 목록뿐입니다.

화면 코드는 셸이 있든 없든 돕니다 — `window.sunmoon` 이 있으면 셸의 신원과 서버 주소를,
없으면 웹 방식(자기 페어링 화면)을 씁니다(`src/lib/pairing.ts`, 세 단말 저장소에 같은 복사본).

## 개발

```bash
npm install            # electron 설치 스크립트는 npm approve-scripts electron 으로 허용
npm test               # 순수 함수 시험 (역할→화면, 서버 주소, CSP)
npm run ui             # 옆 저장소의 dist/ 를 ui/ 로 (먼저 각 단말 저장소에서 npm run build)
SUNMOON_WINDOWED=1 npm start   # 창으로 띄우기 (기본은 전체 화면)
```

**사람 화면을 가리지 않는 확인** — 창을 띄우지 않고 셋업·POS·KDS 화면을 열어 봅니다:

```bash
SUNMOON_SMOKE=1 npx electron .
```

코드까지 주면 진짜로 페어링하고, 화면이 그 토큰으로 Device Server 를 부르는지 봅니다.
개발 PC 의 설정을 건드리지 않게 **반드시 따로 쓸 폴더**와 함께, 시험 매장의 코드로:

```bash
SUNMOON_SMOKE=1 SUNMOON_SMOKE_CODE=123456 SUNMOON_USER_DATA=/tmp/shell-test npx electron .
```

끝나면 서버의 시험 자격을 지우십시오(BO 장비 화면 [해제], 또는 시험 매장 행 삭제).

## 설치 파일

```bash
npm run dist           # release/ 에 NSIS 설치 파일. ▶ 코드 서명 없음(시연 단계)
```

결과는 `release/SunMoon Store Setup <버전>.exe` (약 115MB, 서명 없음). 2026-09-29 에 만들어
`release/win-unpacked` 를 창 없는 점검으로 돌려 봤습니다 — 셋업·POS·KDS 화면이 `resources/ui` 에서 뜨고
외부 연결은 막힙니다. `win.signAndEditExecutable: false` 는 **코드 서명 인증서가 없어서**입니다: 켜 두면
electron-builder 가 winCodeSign 을 풀다가 Windows 심볼릭 링크 권한(개발자 모드·관리자)이 없어 멈춥니다.
인증서가 생기면 되돌리십시오.

화면 번들은 설치 파일에 같이 들어갑니다(1단계). 두 층 업데이트(서명 검증)는 6단계이고,
**Device Server 인증을 `enforce` 로 올리기 전에는 자동 업데이트를 켜지 마십시오**(§2.2, §11).

## 원장·프린터 (4·5단계)

- **원장**: `%APPDATA%/SunMoon Store/ledger.sqlite` (`node:sqlite`, WAL). POS·KIOSK 만.
- **프린터**: ESC/POS over TCP 9100. 프린터는 BO 장비(`RECEIPT_PRINTER` / `LABEL_PRINTER`,
  IP·포트)이고, 셸은 Device Server 가 알려 준 **이 매장의 프린터로만** 찍습니다.
  라벨은 KDS-MAIN, 영수증·돈통은 POS·KIOSK.

## 화면 번들 업데이트 (6단계) — **기본값 꺼짐**

켜려면 `SUNMOON_UI_UPDATES=on`. **Device Server 인증을 `enforce` 로 올린 뒤에** 켜십시오(설계 §11).

```bash
node scripts/keygen.mjs                              # 한 번만 — 개인키는 ~/.sunmoon/ 에
node scripts/pack-ui.mjs pos 2026.09.28-1            # release/ui-pos-….sunmoonui (+ .sig), checksum 출력
```

두 파일을 서버 `:8000/releases/ui/` 에 올리고 BO 배포 화면에 `program=ui-pos`, 주소, checksum 을
등록합니다. 셸은 checksum 과 **서명(공개키는 `src/main/updateKey.ts` 에 박힘)** 을 둘 다 확인한 뒤
`userData/ui/<화면>.next` 에 풀고, **다음 시작 때** 적용합니다(옛 것은 `.prev`). 적용 30초 안에
화면이 죽으면 자동으로 되돌리고 FAILED 로 알립니다. 형식은 zip 이 아니라 gzip(JSON) — Node 내장만.

## 아직 없는 것

- 셸 자체의 자동 업데이트(`electron-updater`) — 코드 서명 인증서가 생긴 뒤(§8.2)
- KIOSK 화면·관리자 탈출 PIN — 7단계
- 실물 프린터로의 확인 — 지금까지는 가짜 프린터(TCP)로만
