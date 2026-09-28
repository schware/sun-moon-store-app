import * as iconv from 'iconv-lite'

/**
 * ESC/POS 바이트 (store-app.md §6.3). 외부 라이브러리 없이 명령만 씁니다.
 *
 * <p><b>화면은 바이트를 모릅니다.</b> 무엇을 찍을지(라벨 content, 영수증 내용)만 넘기고
 * 모양은 여기서 만듭니다 — 프린터가 바뀌면 이 파일만 바뀝니다.
 *
 * <p>한글은 ▶ 기본값 <b>CP949</b>. 한국 모델 ESC/POS 프린터는 {@code FS &} 로 2바이트
 * 모드를 켭니다. 다른 코드페이지를 쓰는 프린터면 {@link Encoding} 만 바꾸십시오.
 */

const ESC = 0x1b
const GS = 0x1d
const FS = 0x1c
const LF = 0x0a

export type Encoding = 'cp949'

class Bytes {
  private readonly parts: Buffer[] = []

  constructor(private readonly encoding: Encoding = 'cp949') {}

  raw(...bytes: number[]): this {
    this.parts.push(Buffer.from(bytes))
    return this
  }

  text(s: string): this {
    this.parts.push(iconv.encode(s, this.encoding))
    return this
  }

  line(s = ''): this {
    return this.text(s).raw(LF)
  }

  align(where: 'left' | 'center' | 'right'): this {
    return this.raw(ESC, 0x61, where === 'left' ? 0 : where === 'center' ? 1 : 2)
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0)
  }

  /** 가로·세로 배율 1~8. */
  size(width: number, height: number): this {
    const w = Math.min(8, Math.max(1, width)) - 1
    const h = Math.min(8, Math.max(1, height)) - 1
    return this.raw(GS, 0x21, (w << 4) | h)
  }

  /** QR (GS ( k) — 모델 2, 오류 정정 M. */
  qr(data: string, moduleSize = 6): this {
    const bytes = Buffer.from(data, 'utf8')
    const len = bytes.length + 3
    this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00)             // model 2
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, Math.min(16, Math.max(1, moduleSize)))
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31)                   // ECC M
    this.raw(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30)
    this.parts.push(bytes)
    return this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30)             // print
  }

  /** 조금 밀고 부분 자르기. */
  cut(): this {
    return this.raw(GS, 0x56, 66, 3)
  }

  build(): Buffer {
    return Buffer.concat(this.parts)
  }
}

function begin(): Bytes {
  // 초기화 + 한국어 2바이트 모드.
  return new Bytes().raw(ESC, 0x40).raw(FS, 0x26)
}

export interface LabelContent {
  pickupNo?: string | null
  menuName?: string | null
  unitNo?: number | null
  unitTotal?: number | null
  tableLabel?: string | null
  orderedAt?: string | null
  copyNo?: number | null
}

function hhmm(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' })
}

/**
 * 라벨 한 장. 컵에 붙는 것이라 <b>번호가 제일 크게</b>, 그다음 메뉴, 몇 번째 잔인지.
 * 재출력이면 "재출력 N" 을 크게 — 같은 라벨이 두 장 돌 때 어느 것이 나중 것인지 보이게.
 */
export function label(c: LabelContent): Buffer {
  const b = begin().align('center')
  if (c.copyNo && c.copyNo > 0) {
    b.size(2, 2).bold(true).line(`재출력 ${c.copyNo}`).bold(false).size(1, 1)
  }
  b.size(3, 3).bold(true).line(c.pickupNo ?? '-').bold(false)
  b.size(2, 2).line(c.menuName ?? '')
  b.size(1, 1)
  if (c.unitTotal && c.unitTotal > 1) b.line(`${c.unitNo ?? 1} / ${c.unitTotal}`)
  const bottom = [c.tableLabel, hhmm(c.orderedAt)].filter(Boolean).join('  ·  ')
  if (bottom) b.line(bottom)
  return b.line().cut().build()
}

export interface ReceiptContent {
  storeName?: string | null
  pickupNo?: string | null
  tranNo?: string | null
  businessDate?: string | null
  lines: Array<{ menuName: string; quantity: number; lineAmount: number }>
  total: number
  payment?: { method: string; approvalNo: string | null; amount: number } | null
  /** 손님이 주문 상태를 보는 주소 (영수증 QR, ADR-0007). 없으면 QR 을 안 찍습니다. */
  claimUrl?: string | null
}

const WON = new Intl.NumberFormat('ko-KR')

/** 영수증 — POS 화면의 Receipt 와 같은 내용 + 주문 QR (§6.3). 한 줄 42자(80mm, 폰트 A). */
export function receipt(r: ReceiptContent): Buffer {
  const b = begin()
  b.align('center').size(2, 2).bold(true).line(r.storeName ?? 'SunMoon').bold(false).size(1, 1)
  if (r.pickupNo) b.size(2, 2).line(`번호 ${r.pickupNo}`).size(1, 1)
  b.line([r.businessDate, r.tranNo ? `거래 ${r.tranNo}` : null].filter(Boolean).join('  '))
  b.align('left').line('-'.repeat(42))
  for (const l of r.lines) {
    const left = `${l.menuName} x${l.quantity}`
    const right = WON.format(l.lineAmount)
    b.line(pad(left, right, 42))
  }
  b.line('-'.repeat(42)).bold(true).line(pad('합계', WON.format(r.total), 42)).bold(false)
  if (r.payment) {
    b.line(pad(r.payment.method, WON.format(r.payment.amount), 42))
    if (r.payment.approvalNo) b.line(`승인 ${r.payment.approvalNo}`)
  }
  if (r.claimUrl) {
    b.line().align('center').qr(r.claimUrl).line().line('주문 상태는 QR 로 확인하세요')
  }
  return b.line().cut().build()
}

/** 돈통 열기 (ESC p). 영수증 프린터에 붙어 있습니다. */
export function drawer(): Buffer {
  return new Bytes().raw(ESC, 0x40).raw(ESC, 0x70, 0, 25, 250).build()
}

/** 한글은 두 칸을 차지합니다 — 칸 수로 맞춥니다. */
function width(s: string): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1
  return w
}

function pad(left: string, right: string, cols: number): string {
  const gap = cols - width(left) - width(right)
  return gap >= 1 ? left + ' '.repeat(gap) + right : `${left}\n${' '.repeat(Math.max(0, cols - width(right)))}${right}`
}
