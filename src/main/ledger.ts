import { DatabaseSync } from 'node:sqlite'

/**
 * POS 거래 원장 — SQLite (umbrella docs/adr/0010 2단계, store-app.md §6.1).
 *
 * <p>웹 POS 의 IndexedDB 원장({@code sun-moon-terminals/pos/src/lib/ledger.ts})과
 * <b>같은 모양, 같은 규칙</b>입니다. 바뀌는 것은 저장소뿐이고, 그래서 얻는 것은
 * 하나입니다: <b>브라우저 데이터를 지워도 원장이 남습니다.</b>
 *
 * <p>Electron 을 부르지 않아 셸 없이 시험합니다. Node 내장 {@code node:sqlite} 를
 * 씁니다 — 네이티브 모듈을 빌드하지 않아도 되는 대신 Electron 이 Node 22.13 이상을
 * 실어야 합니다(Electron 44 = Node 24).
 *
 * <p><b>이 원장이 이 단말 거래의 원본입니다.</b> 서버는 올라온 것을 모으는 곳이고,
 * 어긋나면 이쪽이 맞습니다.
 */

export type TranState = 'MINTED' | 'PENDING' | 'SENT' | 'VOID'

export interface TranRow {
  id: string
  storeId: string
  deviceId: string
  businessDate: string
  tranNo: string
  state: TranState
  orderId: number
  payload: unknown | null
  mintedAt: string
  sentAt: string | null
  attempts: number
  lastError: string | null
}

export interface CounterRow {
  key: string
  last: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counter (key TEXT PRIMARY KEY, last INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tran (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL, device_id TEXT NOT NULL, business_date TEXT NOT NULL, tran_no TEXT NOT NULL,
  state TEXT NOT NULL,
  order_id INTEGER, payload TEXT,
  minted_at TEXT NOT NULL, sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE INDEX IF NOT EXISTS tran_state ON tran(state);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

function counterKey(storeId: string, deviceId: string, businessDate: string): string {
  return `${storeId}:${deviceId}:${businessDate}`
}

export function tranId(storeId: string, deviceId: string, businessDate: string, tranNo: string): string {
  return `${storeId}:${deviceId}:${businessDate}:${tranNo}`
}

interface Row {
  id: string
  store_id: string
  device_id: string
  business_date: string
  tran_no: string
  state: string
  order_id: number | null
  payload: string | null
  minted_at: string
  sent_at: string | null
  attempts: number
  last_error: string | null
}

function toTran(r: Row): TranRow {
  return {
    id: r.id,
    storeId: r.store_id,
    deviceId: r.device_id,
    businessDate: r.business_date,
    tranNo: r.tran_no,
    state: r.state as TranState,
    orderId: r.order_id ?? 0,
    payload: r.payload === null ? null : JSON.parse(r.payload),
    mintedAt: r.minted_at,
    sentAt: r.sent_at,
    attempts: r.attempts,
    lastError: r.last_error
  }
}

export class Ledger {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    // WAL: 쓰는 동안 읽기가 막히지 않고, 전원이 나가도 커밋된 것은 남습니다.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  private tx<T>(work: () => T): T {
    // IMMEDIATE: 시작할 때 쓰기 잠금을 잡습니다 — 두 창이 같은 번호를 읽는 틈이 없습니다.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * 거래번호를 끊고 <b>같은 트랜잭션에서</b> 거래를 적습니다 — 이 기능의 전부입니다.
   * 번호와 거래가 같이 나거나 같이 안 남습니다.
   */
  mint(storeId: string, deviceId: string, businessDate: string, orderId: number): TranRow {
    return this.tx(() => {
      const key = counterKey(storeId, deviceId, businessDate)
      const current = this.db.prepare('SELECT last FROM counter WHERE key = ?').get(key) as
        { last: number } | undefined
      const next = (current && current.last > 0 ? current.last : 0) + 1
      const tranNo = String(next).padStart(6, '0')
      const row: TranRow = {
        id: tranId(storeId, deviceId, businessDate, tranNo),
        storeId, deviceId, businessDate, tranNo,
        state: 'MINTED', orderId, payload: null,
        mintedAt: new Date().toISOString(), sentAt: null, attempts: 0, lastError: null
      }
      this.db.prepare('INSERT INTO counter (key, last) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last = excluded.last')
        .run(key, next)
      this.db.prepare(`INSERT INTO tran (id, store_id, device_id, business_date, tran_no, state, order_id,
                         payload, minted_at, sent_at, attempts, last_error)
                       VALUES (?, ?, ?, ?, ?, 'MINTED', ?, NULL, ?, NULL, 0, NULL)`)
        .run(row.id, storeId, deviceId, businessDate, tranNo, orderId, row.mintedAt)
      return row
    })
  }

  /** 수락이 확인됐습니다 — 이제 올릴 것이 됩니다. */
  confirm(id: string, payload: unknown): void {
    this.db.prepare("UPDATE tran SET state = 'PENDING', payload = ? WHERE id = ?").run(JSON.stringify(payload), id)
  }

  /** 수락 실패. <b>번호는 돌려주지 않습니다</b> — 구멍이 중복보다 낫습니다. */
  discard(id: string, reason: string): void {
    this.db.prepare("UPDATE tran SET state = 'VOID', last_error = ? WHERE id = ?").run(reason, id)
  }

  pending(storeId: string, deviceId: string): TranRow[] {
    return (this.db.prepare(
      "SELECT * FROM tran WHERE state = 'PENDING' AND store_id = ? AND device_id = ? ORDER BY minted_at")
      .all(storeId, deviceId) as unknown as Row[]).map(toTran)
  }

  unsentCount(storeId: string, deviceId: string): number {
    const r = this.db.prepare(
      "SELECT count(*) AS n FROM tran WHERE state = 'PENDING' AND store_id = ? AND device_id = ?")
      .get(storeId, deviceId) as { n: number }
    return Number(r.n)
  }

  markSent(ids: string[]): void {
    const now = new Date().toISOString()
    const stmt = this.db.prepare("UPDATE tran SET state = 'SENT', sent_at = ?, last_error = NULL WHERE id = ?")
    this.tx(() => { for (const id of ids) stmt.run(now, id) })
  }

  markFailed(ids: string[], reason: string): void {
    const stmt = this.db.prepare('UPDATE tran SET attempts = attempts + 1, last_error = ? WHERE id = ?')
    this.tx(() => { for (const id of ids) stmt.run(reason, id) })
  }

  /** 번호만 끊고 멈춘 것들 — 판단은 서버에 물을 수 있는 화면이 합니다. */
  minted(storeId: string, deviceId: string): TranRow[] {
    return (this.db.prepare(
      "SELECT * FROM tran WHERE state = 'MINTED' AND store_id = ? AND device_id = ? ORDER BY minted_at")
      .all(storeId, deviceId) as unknown as Row[]).map(toTran)
  }

  migrated(): boolean {
    return this.db.prepare("SELECT 1 FROM meta WHERE key = 'indexeddbImported'").get() !== undefined
  }

  /**
   * 이 셸에서 IndexedDB 로 돌던 원장을 한 번만 옮겨옵니다(셸 0.1 → 0.2).
   *
   * <p>카운터는 <b>큰 쪽을 남깁니다</b> — 어느 쪽이 앞서 있든 뒤로 가면 번호가 겹칩니다.
   * 거래는 이미 있으면 그대로(SQLite 가 앞선 사실). 끝나면 다시 옮기지 않게 적어 둡니다.
   */
  importRows(counters: CounterRow[], trans: TranRow[]): { counters: number; trans: number } {
    return this.tx(() => {
      let c = 0
      let t = 0
      const up = this.db.prepare(`INSERT INTO counter (key, last) VALUES (?, ?)
                                  ON CONFLICT(key) DO UPDATE SET last = max(last, excluded.last)`)
      for (const row of counters) {
        if (Number.isFinite(row.last) && row.last > 0) {
          up.run(row.key, row.last)
          c++
        }
      }
      const ins = this.db.prepare(`INSERT OR IGNORE INTO tran (id, store_id, device_id, business_date, tran_no,
                                     state, order_id, payload, minted_at, sent_at, attempts, last_error)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const r of trans) {
        const res = ins.run(r.id, r.storeId, r.deviceId, r.businessDate, r.tranNo, r.state, r.orderId,
          r.payload === null ? null : JSON.stringify(r.payload), r.mintedAt, r.sentAt, r.attempts, r.lastError)
        t += Number(res.changes)
      }
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('indexeddbImported', ?)")
        .run(new Date().toISOString())
      return { counters: c, trans: t }
    })
  }
}
