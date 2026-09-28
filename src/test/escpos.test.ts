import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as net from 'node:net'
import * as iconv from 'iconv-lite'
import { drawer, label, receipt } from '../main/escpos'

const INIT = Buffer.from([0x1b, 0x40])
const CUT = Buffer.from([0x1d, 0x56, 66, 3])

function contains(haystack: Buffer, needle: Buffer): boolean {
  return haystack.indexOf(needle) >= 0
}

test('라벨은 초기화로 시작하고 자르기로 끝난다', () => {
  const bytes = label({ pickupNo: 'A-12', menuName: '아메리카노', unitNo: 2, unitTotal: 3, copyNo: 0 })
  assert.ok(bytes.subarray(0, 2).equals(INIT))
  assert.ok(bytes.subarray(bytes.length - 4).equals(CUT))
  assert.ok(contains(bytes, iconv.encode('아메리카노', 'cp949')), '한글은 CP949')
  assert.ok(contains(bytes, Buffer.from('2 / 3')))
  assert.ok(!contains(bytes, iconv.encode('재출력', 'cp949')))
})

test('재출력이면 "재출력 N" 이 찍힌다', () => {
  const bytes = label({ pickupNo: 'A-12', menuName: '라떼', copyNo: 2 })
  assert.ok(contains(bytes, iconv.encode('재출력 2', 'cp949')))
})

test('영수증에 결제와 주문 QR', () => {
  const bytes = receipt({
    storeName: '1매장', pickupNo: '12', tranNo: '000001', businessDate: '2026-09-28',
    lines: [{ menuName: '짜장면', quantity: 2, lineAmount: 14000 }], total: 14000,
    payment: { method: 'SUNMOON_PAY', approvalNo: 'SMP-1', amount: 14000 },
    claimUrl: 'http://example/channel-order/o/abc'
  })
  assert.ok(contains(bytes, Buffer.from('SMP-1')))
  assert.ok(contains(bytes, Buffer.from('http://example/channel-order/o/abc')), 'QR 데이터')
  assert.ok(contains(bytes, Buffer.from([0x1d, 0x28, 0x6b])), 'GS ( k')
  assert.ok(bytes.subarray(bytes.length - 4).equals(CUT))
})

test('돈통은 ESC p', () => {
  assert.ok(contains(drawer(), Buffer.from([0x1b, 0x70, 0])))
})

test('TCP 9100 으로 보낸 바이트가 그대로 도착한다 (가짜 프린터)', async () => {
  // printer.ts 는 electron 을 부르므로, send 와 같은 방식을 여기서 직접 재현하지 않고
  // 소켓 수준만 확인합니다: 연결 → 쓰기 → 닫기 뒤 받은 쪽이 같은 바이트를 가졌는가.
  const received: Buffer[] = []
  const server = net.createServer((s) => s.on('data', (d) => received.push(d)))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  const bytes = label({ pickupNo: '7', menuName: '물' })
  await new Promise<void>((resolve, reject) => {
    const c = net.createConnection({ host: '127.0.0.1', port }, () => c.end(bytes))
    c.on('close', () => resolve())
    c.on('error', reject)
  })
  await new Promise((r) => setTimeout(r, 50))
  server.close()
  assert.ok(Buffer.concat(received).equals(bytes))
})
