import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contentSecurityPolicy, normaliseServerUrl, screenFor } from '../main/roles'

const base = { storeId: 'store-01', deviceId: 'x' }

test('셸은 하드웨어가 있는 자리만 연다', () => {
  assert.deepEqual(screenFor({ ...base, deviceType: 'POS', kdsRole: null }), { screen: 'pos' })
  assert.deepEqual(screenFor({ ...base, deviceType: 'KDS', kdsRole: 'MAIN' }), { screen: 'kds' })
  assert.ok('refused' in screenFor({ ...base, deviceType: 'KDS', kdsRole: 'SUB' }), 'SUB 는 웹')
  assert.ok('refused' in screenFor({ ...base, deviceType: 'DID', kdsRole: null }), 'DID 는 웹')
  assert.ok('refused' in screenFor({ ...base, deviceType: 'PRINTER', kdsRole: null }))
})

test('서버 주소는 http(s) 의 출처만', () => {
  assert.equal(normaliseServerUrl(' http://211.217.183.232:8087/ '), 'http://211.217.183.232:8087')
  assert.equal(normaliseServerUrl('https://pos.example.com/path'), 'https://pos.example.com')
  assert.equal(normaliseServerUrl('file:///C:/x'), null)
  assert.equal(normaliseServerUrl('javascript:alert(1)'), null)
  assert.equal(normaliseServerUrl('not a url'), null)
})

test('CSP 는 스크립트를 셸 안으로, 연결을 Device Server 로 묶는다', () => {
  const csp = contentSecurityPolicy('http://211.217.183.232:8087')
  assert.match(csp, /script-src 'self'(;|$)/)
  assert.match(csp, /connect-src 'self' http:\/\/211\.217\.183\.232:8087 ws:\/\/211\.217\.183\.232:8087/)
  assert.doesNotMatch(csp, /unsafe-eval/)
  assert.match(contentSecurityPolicy(null), /connect-src 'self'(;|$)/)
})
