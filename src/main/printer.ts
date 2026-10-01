import { net } from 'electron'
import * as tcp from 'node:net'
import { readConfig } from './config'
import * as escpos from './escpos'

/**
 * 프린터 (store-app.md §6.3, §7.2). ESC/POS 바이트를 TCP 9100 으로.
 *
 * <p><b>어디로 찍을지는 main 이 정합니다.</b> 화면은 작업 번호나 영수증 내용만 넘기고,
 * main 이 Device Server 에서 이 매장의 프린터 목록(BO 장비)을 받아 그중 하나로만
 * 연결합니다. 화면이 준 주소로 연결하면, 화면의 구멍 하나가 매장 PC 에서 아무 곳으로나
 * 연결을 여는 길이 됩니다.
 */

export interface Printer {
  deviceId: string
  type: 'RECEIPT_PRINTER' | 'LABEL_PRINTER'
  name: string | null
  ip: string | null
  port: number
}

/** Device Server 의 프린터·라벨 주소. 이 기기의 매장을 붙여 부릅니다 — 그 매장 것만 보입니다. */
async function api(path: string, init?: RequestInit): Promise<Response> {
  const config = readConfig()
  if (!config) throw new Error('매장·장비가 설정되지 않은 기기입니다')
  const join = path.includes('?') ? '&' : '?'
  return net.fetch(`${config.serverUrl}${path}${join}storeId=${encodeURIComponent(config.device.storeId)}`, init)
}

async function printers(): Promise<Printer[]> {
  const res = await api('/pos/printers')
  if (!res.ok) throw new Error(`프린터 목록을 받지 못했습니다 (${res.status})`)
  return (await res.json()) as Printer[]
}

/** 바이트를 보냅니다. 5초 안에 연결·전송이 안 되면 실패 — 매장 화면이 멈춰 기다리지 않게. */
export function send(ip: string, port: number, bytes: Buffer, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tcp.createConnection({ host: ip, port })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.setTimeout(timeoutMs, () => finish(new Error(`프린터가 응답하지 않습니다 (${ip}:${port})`)))
    socket.on('error', (e) => finish(new Error(`프린터에 연결하지 못했습니다 (${ip}:${port}): ${e.message}`)))
    socket.on('connect', () => socket.end(bytes, () => finish()))
  })
}

async function target(type: Printer['type'], deviceId?: string): Promise<Printer> {
  const list = (await printers()).filter((p) => p.type === type && p.ip)
  const found = deviceId ? list.find((p) => p.deviceId === deviceId) : list[0]
  if (!found || !found.ip) {
    throw new Error(type === 'LABEL_PRINTER'
      ? '이 매장에 쓸 수 있는 라벨 프린터가 없습니다 (BO 장비에 IP 를 넣으십시오)'
      : '이 매장에 쓸 수 있는 영수증 프린터가 없습니다 (BO 장비에 IP 를 넣으십시오)')
  }
  return found
}

interface Job {
  id: number
  printerId: string
  status: 'QUEUED' | 'PRINTED' | 'FAILED'
  content: escpos.LabelContent
}

async function ack(id: number, ok: boolean, error?: string): Promise<void> {
  await api(`/pos/print-jobs/ack?id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok, error: error ?? null })
  })
}

/**
 * 라벨 작업 하나를 찍고 결과를 서버에 적습니다. 이미 찍힌 작업은 다시 찍지 않습니다
 * (프레임이 두 번 와도 한 장). 실패는 FAILED 로 — 재처리 화면에서 다시 할 수 있습니다.
 */
export async function printLabel(jobId: number): Promise<{ ok: boolean; error?: string }> {
  const res = await api(`/pos/print-jobs?id=${jobId}`)
  if (!res.ok) return { ok: false, error: `작업을 받지 못했습니다 (${res.status})` }
  const job = (await res.json()) as Job
  if (job.status === 'PRINTED') return { ok: true }
  try {
    const printer = await target('LABEL_PRINTER', job.printerId)
    await send(printer.ip!, printer.port, escpos.label(job.content))
    await ack(job.id, true)
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await ack(job.id, false, error).catch(() => undefined)
    return { ok: false, error }
  }
}

/** 꺼져 있던 동안 쌓인 라벨 — 다시 붙을 때 한 장씩 (§7.2). */
export async function printQueuedLabels(): Promise<{ printed: number; failed: number }> {
  const res = await api('/pos/print-jobs?status=QUEUED')
  if (!res.ok) return { printed: 0, failed: 0 }
  const jobs = (await res.json()) as Job[]
  let printed = 0
  let failed = 0
  for (const job of jobs) {
    const result = await printLabel(job.id)
    if (result.ok) printed++
    else failed++
  }
  return { printed, failed }
}

export async function printReceipt(content: escpos.ReceiptContent): Promise<{ ok: boolean; error?: string }> {
  try {
    const printer = await target('RECEIPT_PRINTER')
    await send(printer.ip!, printer.port, escpos.receipt(content))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function openDrawer(): Promise<{ ok: boolean; error?: string }> {
  try {
    const printer = await target('RECEIPT_PRINTER')
    await send(printer.ip!, printer.port, escpos.drawer())
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
