/**
 * 어느 기기가 이 셸을 쓰고, 어느 화면을 여는가 (umbrella docs/design/store-app.md §5.1).
 *
 * 셸은 <b>하드웨어가 있는 자리</b>에만 갑니다(ADR-0015): POS, KIOSK, KDS-MAIN.
 * KDS SUB 와 DID 는 웹 화면 그대로입니다 — 그런 설정이 셸에 오면 여기서 돌려보냅니다.
 *
 * Electron 을 부르지 않는 순수 함수라 셸 없이 시험합니다.
 */

export interface Device {
  storeId: string
  deviceId: string
  deviceType: string
  kdsRole: string | null
}

export type Screen = 'pos' | 'kds' | 'kiosk'

/** 이 기기가 셸에서 열 화면. 셸이 아닌 기기면 이유를 담아 거절합니다. */
export function screenFor(device: Device): { screen: Screen } | { refused: string } {
  switch (device.deviceType) {
    case 'POS':
      return { screen: 'pos' }
    case 'KIOSK':
      return { screen: 'kiosk' }
    case 'KDS':
      return device.kdsRole === 'MAIN'
        ? { screen: 'kds' }
        : { refused: 'KDS 생산 주방은 셸 없이 웹 KDS 화면에서 엽니다.' }
    case 'DID':
      return { refused: 'DID 는 셸 없이 웹 DID 화면에서 엽니다.' }
    default:
      return { refused: `셸이 모르는 단말 종류입니다: ${device.deviceType}` }
  }
}

/**
 * 화면의 주소 첫 칸. 번들은 자기 base 로 빌드돼 있어서(POS /pos/, KDS /kds/, 손님 화면
 * /channel-order/) 주소도 그것을 따라야 자산이 제자리에서 풀립니다. KIOSK 는 손님 화면을
 * 그대로 쓰므로 주소는 /channel-order/, 디스크의 자리는 ui/kiosk 입니다.
 */
export function urlPrefix(screen: Screen): string {
  return screen === 'kiosk' ? 'channel-order' : screen
}

/** 주소 첫 칸 → ui/ 아래 폴더. */
export function folderFor(prefix: string): string {
  return prefix === 'channel-order' ? 'kiosk' : prefix
}

/**
 * KIOSK 결제 — ▶ 기본값 썬앤문페이(가상) (store-app.md §9). VAN 이 정해지면 이 자리가
 * VAN 호출로 바뀝니다. 가상 승인번호는 SMK- 로 시작해서 진짜 승인과 섞이지 않습니다.
 */
export function virtualApproval(amount: unknown, now = new Date(), random = Math.random):
  { approved: boolean; method: string; approvalNo: string | null; amount: number; message?: string } {
  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0 || value >= 10_000_000) {
    return { approved: false, method: 'SUNMOON_PAY', approvalNo: null, amount: 0, message: '결제 금액이 올바르지 않습니다' }
  }
  // 서울 날짜 — UTC 로 찍으면 자정~오전 9시 승인이 전날 번호가 됩니다.
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).replace(/-/g, '')
  const tail = Math.floor(random() * 36 ** 6).toString(36).toUpperCase().padStart(6, '0')
  return { approved: true, method: 'SUNMOON_PAY', approvalNo: `SMK-${ymd}-${tail}`, amount: value }
}

/**
 * 서버 주소는 http(s) 이고 경로가 없어야 합니다. 설정 화면에서 사람이 치는 값이라
 * 끝의 / 같은 것은 흘려 넘기고, 모양이 틀리면 저장하지 않습니다.
 */
export function normaliseServerUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return `${url.protocol}//${url.host}`
}

/**
 * 화면의 CSP (§2.1). 스크립트는 셸 안의 파일만, 연결은 Device Server 한 곳만.
 * 화면의 작은 구멍(XSS)이 매장 PC 탈취가 되지 않게 하는 두 번째 벽입니다.
 */
export function contentSecurityPolicy(serverUrl: string | null): string {
  const connect = serverUrl ? `${serverUrl} ${serverUrl.replace(/^http/, 'ws')}` : ''
  return [
    "default-src 'self'",
    "script-src 'self'",
    // React 의 style 속성과 Vite 가 넣는 스타일 — 스크립트가 아니라서 여기만 엽니다.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${connect}`.trim(),
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; ')
}
