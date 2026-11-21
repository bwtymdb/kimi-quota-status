import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createQuotaReader } from '../fetcher.js'

const NOW = Date.parse('2026-11-20T08:00:00.000Z')
const OLD = {
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '28', remaining: '72' } }],
  usage: { limit: '100', used: '52', remaining: '48' },
}
const BROWSER_SUCCESS = {
  status: 'available', usedPercent: 73.84, resetAt: '2026-11-29T03:49:00.000Z',
  fetchedAt: '2026-11-20T08:01:00.000Z', error: null,
}
const credentials = { resolve: async () => ({ value: 'test-secret', source: 'test' }) }
const ok = (payload = OLD) => ({ ok: true, status: 200, json: async () => payload })
const deferred = () => {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

function monthlyStub(results = [], successful = false) {
  const calls = []
  let hasSuccess = successful
  return {
    calls,
    hasSuccess: () => hasSuccess,
    async read(options) {
      calls.push(options)
      const result = results.length > 1 ? results.shift() : results[0]
      hasSuccess = result.status === 'available' && result.error === null
      return result
    },
  }
}

test('browser monthly is opt-in and merges without replacing API windows', async () => {
  const monthlyReader = monthlyStub([BROWSER_SUCCESS])
  const controller = new AbortController()
  const reader = createQuotaReader({
    credentials, monthlyReader, now: () => NOW, fetchImpl: async () => ok(),
  })
  const initial = await reader.read()
  assert.equal(monthlyReader.calls.length, 0)
  assert.equal(initial.windows.monthly.status, 'unavailable')

  const snapshot = await reader.read(false, controller.signal, true)
  assert.deepEqual(monthlyReader.calls, [{ force: true }])
  assert.deepEqual(snapshot.windows.monthly, {
    status: 'available', usedPercent: 73.84, resetAt: BROWSER_SUCCESS.resetAt,
  })
  assert.equal(snapshot.windows.fiveHour.usedPercent, 28)
  assert.equal(snapshot.windows.weekly.usedPercent, 52)
  assert.equal(snapshot.fetchedAt, '2026-11-20T08:00:00.000Z')
  assert.equal(snapshot.error, null)
  reader.dispose()
})

test('previous browser success allows automatic reads without forcing the browser', async () => {
  const monthlyReader = monthlyStub([BROWSER_SUCCESS], true)
  const reader = createQuotaReader({
    credentials, monthlyReader, now: () => NOW, fetchImpl: async () => ok(),
  })
  const snapshot = await reader.read(false, undefined, false)
  assert.deepEqual(monthlyReader.calls, [{ force: false }])
  assert.equal(snapshot.windows.monthly.usedPercent, 73.84)
  reader.dispose()
})

test('API monthly values always win over the browser reader', async () => {
  const monthlyReader = monthlyStub([BROWSER_SUCCESS], true)
  const reader = createQuotaReader({
    credentials, monthlyReader, now: () => NOW,
    fetchImpl: async () => ok({ usages: { limit_month_total: { used_ratio: 0.19, reset_time: '2026-12-01T08:00:00.000Z' } } }),
  })
  const snapshot = await reader.read(true, undefined, true)
  assert.equal(monthlyReader.calls.length, 0)
  assert.deepEqual(snapshot.windows.monthly, {
    status: 'available', usedPercent: 19, resetAt: '2026-12-01T08:00:00.000Z',
  })
  reader.dispose()
})

test('browser errors retain prior success but login-required clears monthly values', async () => {
  const monthlyReader = monthlyStub([
    BROWSER_SUCCESS,
    { ...BROWSER_SUCCESS, error: { code: 'parse-failed' } },
    { status: 'unavailable', usedPercent: null, resetAt: null, fetchedAt: null, error: { code: 'login-required' } },
  ])
  let apiFails = false
  const reader = createQuotaReader({
    credentials, monthlyReader, now: () => NOW,
    fetchImpl: async () => apiFails ? { ok: false, status: 500 } : ok(),
  })
  const success = await reader.read(true, undefined, true)
  assert.equal(success.windows.monthly.usedPercent, 73.84)

  const failed = await reader.read(true, undefined, true)
  assert.equal(failed.error.code, 'parse-failed')
  assert.deepEqual(failed.windows.monthly, success.windows.monthly)

  const login = await reader.read(true, undefined, true)
  assert.equal(login.error.code, 'login-required')
  assert.deepEqual(login.windows.monthly, { status: 'unavailable', usedPercent: null, resetAt: null })

  apiFails = true
  const offline = await reader.read(true, undefined, true)
  assert.equal(offline.error.code, 'http-error')
  assert.deepEqual(offline.windows.monthly, { status: 'unavailable', usedPercent: null, resetAt: null })
  reader.dispose()
})

test('API failures never open the browser even when monthly was requested', async () => {
  const monthlyReader = monthlyStub([BROWSER_SUCCESS], true)
  const reader = createQuotaReader({
    credentials, monthlyReader, now: () => NOW,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  })
  const snapshot = await reader.read(true, undefined, true)
  assert.equal(snapshot.error.code, 'http-error')
  assert.equal(monthlyReader.calls.length, 0)
  reader.dispose()
})

test('explicit monthly read queues behind a non-monthly inflight request', async () => {
  const pending = deferred()
  const monthlyReader = monthlyStub([BROWSER_SUCCESS])
  const firstController = new AbortController()
  const monthlyController = new AbortController()
  let apiCalls = 0
  const reader = createQuotaReader({
    credentials, monthlyReader, now: () => NOW,
    fetchImpl: () => {
      apiCalls += 1
      return apiCalls === 1 ? pending.promise : Promise.resolve(ok())
    },
  })
  const initial = reader.read(false, firstController.signal, false)
  const monthly = reader.read(true, monthlyController.signal, true)
  await Promise.resolve()
  assert.equal(apiCalls, 1)
  pending.resolve(ok())
  const [, snapshot] = await Promise.all([initial, monthly])
  assert.equal(monthlyReader.calls.length, 1)
  assert.deepEqual(monthlyReader.calls[0], { force: true })
  assert.equal(snapshot.windows.monthly.status, 'available')
  assert.equal(snapshot.windows.monthly.usedPercent, 73.84)
  assert.equal(apiCalls, 2)
  reader.dispose()
})

test('multiple explicit monthly reads share one queued browser supplement', async () => {
  const pending = deferred()
  const monthlyReader = monthlyStub([BROWSER_SUCCESS])
  let apiCalls = 0
  const reader = createQuotaReader({
    credentials, monthlyReader, now: () => NOW,
    fetchImpl: () => {
      apiCalls += 1
      return apiCalls === 1 ? pending.promise : Promise.resolve(ok())
    },
  })
  const initial = reader.read(false, undefined, false)
  const firstMonthly = reader.read(true, undefined, true)
  const secondMonthly = reader.read(true, undefined, true)
  await Promise.resolve()
  assert.equal(apiCalls, 1)
  pending.resolve(ok())
  const [first, second] = await Promise.all([firstMonthly, secondMonthly])
  await initial
  assert.equal(monthlyReader.calls.length, 1)
  assert.equal(first.windows.monthly.usedPercent, 73.84)
  assert.deepEqual(second, first)
  assert.equal(apiCalls, 2)
  reader.dispose()
})

test('Host service constructs, reads, and disposes the monthly reader', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /import\s*\{\s*createMonthlyReader\s*\}\s*from\s*['"]\.\/browser-monthly\.js['"]/)
  assert.match(source, /this\.monthlyReader\s*=\s*createMonthlyReader\(\)/)
  assert.match(source, /createQuotaReader\(\{\s*credentials:\s*ctx\.credentials,\s*monthlyReader:\s*this\.monthlyReader\s*\}\)/)
  assert.match(source, /this\.reader\.read\(request\?\.force\s*===\s*true,\s*signal,\s*request\?\.monthly\s*===\s*true\)/)
  assert.match(source, /this\.monthlyReader\.dispose\(\)/)
})
