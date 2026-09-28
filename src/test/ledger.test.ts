import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Ledger, tranId } from '../main/ledger'

function fresh(): { ledger: Ledger; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const file = path.join(dir, 'ledger.sqlite')
  return { ledger: new Ledger(file), file }
}

test('번호는 판매일자마다 1부터, 여섯 자리', () => {
  const { ledger } = fresh()
  assert.equal(ledger.mint('s1', 'pos-01', '2026-09-28', 10).tranNo, '000001')
  assert.equal(ledger.mint('s1', 'pos-01', '2026-09-28', 11).tranNo, '000002')
  assert.equal(ledger.mint('s1', 'pos-01', '2026-09-29', 12).tranNo, '000001')
  assert.equal(ledger.mint('s1', 'pos-02', '2026-09-28', 13).tranNo, '000001', '단말마다 따로')
})

test('수락 → PENDING → SENT, 실패는 VOID 로 남고 번호를 돌려주지 않는다', () => {
  const { ledger } = fresh()
  const a = ledger.mint('s1', 'pos-01', '2026-09-28', 1)
  const b = ledger.mint('s1', 'pos-01', '2026-09-28', 2)
  ledger.confirm(a.id, { header: { tranNo: a.tranNo } })
  ledger.discard(b.id, '409')

  assert.equal(ledger.unsentCount('s1', 'pos-01'), 1)
  assert.deepEqual(ledger.pending('s1', 'pos-01')[0].payload, { header: { tranNo: '000001' } })

  ledger.markFailed([a.id], '네트워크')
  assert.equal(ledger.pending('s1', 'pos-01')[0].attempts, 1)
  ledger.markSent([a.id])
  assert.equal(ledger.unsentCount('s1', 'pos-01'), 0)

  assert.equal(ledger.mint('s1', 'pos-01', '2026-09-28', 3).tranNo, '000003', '버린 번호 뒤로')
})

test('번호만 끊고 멈춘 것은 MINTED 로 보인다', () => {
  const { ledger } = fresh()
  const a = ledger.mint('s1', 'pos-01', '2026-09-28', 1)
  assert.deepEqual(ledger.minted('s1', 'pos-01').map((r) => r.id), [a.id])
})

test('다시 열어도 원장이 남는다 — 이 기능의 이유', () => {
  const { ledger, file } = fresh()
  const a = ledger.mint('s1', 'pos-01', '2026-09-28', 1)
  ledger.confirm(a.id, { x: 1 })
  ledger.close()

  const again = new Ledger(file)
  assert.equal(again.unsentCount('s1', 'pos-01'), 1)
  assert.equal(again.mint('s1', 'pos-01', '2026-09-28', 2).tranNo, '000002')
})

test('옮겨오기: 카운터는 큰 쪽, 거래는 있는 것 우선, 한 번만', () => {
  const { ledger } = fresh()
  ledger.mint('s1', 'pos-01', '2026-09-28', 1)                   // SQLite 에 이미 1
  assert.equal(ledger.migrated(), false)

  const imported = ledger.importRows(
    [{ key: 's1:pos-01:2026-09-28', last: 7 }, { key: 's1:pos-01:2026-09-27', last: 0 }],
    [{
      id: tranId('s1', 'pos-01', '2026-09-28', '000005'), storeId: 's1', deviceId: 'pos-01',
      businessDate: '2026-09-28', tranNo: '000005', state: 'PENDING', orderId: 5, payload: { p: 5 },
      mintedAt: '2026-09-28T01:00:00Z', sentAt: null, attempts: 0, lastError: null
    }])

  assert.deepEqual(imported, { counters: 1, trans: 1 })
  assert.equal(ledger.migrated(), true)
  assert.equal(ledger.mint('s1', 'pos-01', '2026-09-28', 8).tranNo, '000008', '큰 쪽(7) 다음')
  assert.equal(ledger.unsentCount('s1', 'pos-01'), 1)
})
