import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { BundleRejected, installedVersion, promote, rollback, unpack, verifyBundle } from '../main/bundle'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function make(files: Record<string, string>, version = '1') {
  const bytes = gzipSync(Buffer.from(JSON.stringify({
    screen: 'pos', version,
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')]))
  })))
  return { bytes, sig: sign(null, bytes, privateKey).toString('base64'),
           sum: createHash('sha256').update(bytes).digest('hex') }
}

test('서명과 checksum 이 맞으면 풀린다', () => {
  const b = make({ 'index.html': '<html>', 'assets/a.js': 'x' })
  const bundle = verifyBundle(b.bytes, b.sig, b.sum, PUB)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'))
  unpack(bundle, path.join(dir, 'pos.next'))
  assert.equal(fs.readFileSync(path.join(dir, 'pos.next', 'assets', 'a.js'), 'utf8'), 'x')
  assert.equal(installedVersion(path.join(dir, 'pos.next')), '1')
})

test('다른 키로 서명한 번들은 거절 — 서버를 뺏겨도 코드는 못 넣는다', () => {
  const b = make({ 'index.html': '<html>' })
  const other = generateKeyPairSync('ed25519')
  const forged = sign(null, b.bytes, other.privateKey).toString('base64')
  assert.throws(() => verifyBundle(b.bytes, forged, b.sum, PUB), BundleRejected)
})

test('한 바이트라도 바뀌면 거절', () => {
  const b = make({ 'index.html': '<html>' })
  const tampered = Buffer.from(b.bytes)
  tampered[tampered.length - 5] ^= 0xff
  assert.throws(() => verifyBundle(tampered, b.sig, null, PUB), BundleRejected)
  assert.throws(() => verifyBundle(b.bytes, b.sig, 'deadbeef', PUB), BundleRejected, 'checksum')
})

test('번들 밖을 가리키는 경로는 풀지 않는다', () => {
  const b = make({ 'index.html': '<html>', '../../evil.txt': 'x' })
  const bundle = verifyBundle(b.bytes, b.sig, b.sum, PUB)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'))
  assert.throws(() => unpack(bundle, path.join(dir, 'pos.next')), BundleRejected)
  assert.equal(fs.existsSync(path.join(dir, '..', 'evil.txt')), false)
})

test('적용하면 옛 것은 prev 로, 되돌리면 prev 가 다시 지금 것', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'))
  unpack(verifyBundle(make({ 'index.html': 'v1' }, '1').bytes, make({ 'index.html': 'v1' }, '1').sig, null, PUB),
    path.join(dir, 'pos'))
  const v2 = make({ 'index.html': 'v2' }, '2')
  unpack(verifyBundle(v2.bytes, v2.sig, v2.sum, PUB), path.join(dir, 'pos.next'))

  assert.equal(promote(dir, 'pos'), '2')
  assert.equal(installedVersion(path.join(dir, 'pos')), '2')
  assert.equal(installedVersion(path.join(dir, 'pos.prev')), '1')
  assert.equal(promote(dir, 'pos'), null, '받아 둔 것이 없으면 아무것도 안 함')

  assert.equal(rollback(dir, 'pos'), true)
  assert.equal(installedVersion(path.join(dir, 'pos')), '1')
})
