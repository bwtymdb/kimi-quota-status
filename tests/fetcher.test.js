import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuotaReader } from '../fetcher.js'

const OLD = {
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '28', remaining: '72' } }],
  usage: { limit: '100', used: '52', remaining: '48' },
}
const NOW = Date.parse('2026-11-20T08:00:00.000Z')
const credentials = (value = 'test-secret') => ({
  async resolve(ref) {
    assert.equal(ref, 'KIMI_API_KEY')
    return value === undefined ? undefined : { value, source: 'test' }
  },
})
const ok = (payload = OLD) => ({ ok: true, status: 200, json: async () => payload })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('successful reads return normalized secret-free snapshots', async () => {
  let request
  const reader = createQuotaReader({
    credentials: credentials(), now: () => NOW,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return ok()
    },
  })
  const snapshot = await reader.read()
  assert.equal(request.url, 'https://api.kimi.com/coding/v1/usages')
  assert.equal(request.options.headers.Authorization, 'Bearer test-secret')
  assert.equal(request.options.headers.Accept, 'application/json')
  assert.deepEqual(snapshot, {
    fetchedAt: '2026-11-20T08:00:00.000Z', error: null,
    windows: {
      fiveHour: { status: 'available', usedPercent: 28, resetAt: null },
      weekly: { status: 'available', usedPercent: 52, resetAt: null },
      monthly: { status: 'unavailable', usedPercent: null, resetAt: null },
    },
  })
  assert.equal(JSON.stringify(snapshot).includes('test-secret'), false)
  reader.dispose()
})

test('reads use a 60 second cache and force bypasses it', async () => {
  let now = NOW, calls = 0
  const reader = createQuotaReader({
    credentials: credentials(), now: () => now,
    fetchImpl: async () => { calls += 1; return ok() },
  })
  await reader.read()
  now += 59_999
  await reader.read()
  assert.equal(calls, 1)
  await reader.read(true)
  assert.equal(calls, 2)
  now += 60_000
  await reader.read()
  assert.equal(calls, 3)
  reader.dispose()
})

test('concurrent reads share one inflight network request', async () => {
  const pending = deferred()
  let calls = 0
  const reader = createQuotaReader({
    credentials: credentials(), now: () => NOW,
    fetchImpl: () => { calls += 1; return pending.promise },
  })
  const first = reader.read()
  const second = reader.read(true)
  await Promise.resolve()
  assert.equal(calls, 1)
  pending.resolve(ok())
  const snapshots = await Promise.all([first, second])
  assert.deepEqual(snapshots[0], snapshots[1])
  assert.equal(calls, 1)
  reader.dispose()
})

test('failed refreshes preserve the last good snapshot', async () => {
  let fail = false
  const reader = createQuotaReader({
    credentials: credentials(), now: () => NOW,
    fetchImpl: async () => fail ? { ok: false, status: 500 } : ok(),
  })
  const good = await reader.read()
  fail = true
  const failed = await reader.read(true)
  assert.equal(failed.error.code, 'http-error')
  assert.equal(failed.fetchedAt, good.fetchedAt)
  assert.deepEqual(failed.windows, good.windows)
  reader.dispose()
})

test('missing credentials produce a safe error without fetching', async () => {
  let calls = 0
  const reader = createQuotaReader({
    credentials: { resolve: async () => undefined }, now: () => NOW,
    fetchImpl: async () => { calls += 1; return ok() },
  })
  const snapshot = await reader.read()
  assert.equal(calls, 0)
  assert.deepEqual(snapshot, {
    fetchedAt: null, error: { code: 'credential-missing' },
    windows: {
      fiveHour: { status: 'unavailable', usedPercent: null, resetAt: null },
      weekly: { status: 'unavailable', usedPercent: null, resetAt: null },
      monthly: { status: 'unavailable', usedPercent: null, resetAt: null },
    },
  })
  reader.dispose()
})

test('HTTP 401, 403, and 429 map to stable safe error codes', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate-limited']]) {
    const reader = createQuotaReader({
      credentials: credentials(), now: () => NOW,
      fetchImpl: async () => ({ ok: false, status }),
    })
    const snapshot = await reader.read()
    assert.equal(snapshot.error.code, code)
    assert.equal(snapshot.fetchedAt, null)
    reader.dispose()
  }
})

test('request timeouts map to timeout errors', async () => {
  const reader = createQuotaReader({
    credentials: credentials(), now: () => NOW, timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const snapshot = await reader.read()
  assert.equal(snapshot.error.code, 'timeout')
  reader.dispose()
})

test('caller cancellation neither aborts nor releases the shared request early', async () => {
  const pending = deferred()
  const controller = new AbortController()
  let calls = 0, requestSignal
  const reader = createQuotaReader({
    credentials: credentials(), now: () => NOW,
    fetchImpl: (_url, { signal }) => {
      calls += 1
      requestSignal = signal
      return pending.promise
    },
  })
  const cancelled = reader.read(false, controller.signal)
  const shared = reader.read()
  await Promise.resolve()
  assert.equal(calls, 1)
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(cancelled, /caller cancelled/)
  assert.equal(requestSignal.aborted, false)
  const stillShared = reader.read(true)
  await Promise.resolve()
  assert.equal(calls, 1)
  pending.resolve(ok())
  await Promise.all([shared, stillShared])
  assert.equal(requestSignal.aborted, false)
  reader.dispose()
})

test('network, invalid JSON, and unsupported payloads map distinctly', async () => {
  const cases = [
    [async () => { throw new TypeError('offline') }, 'network'],
    [async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON') } }), 'invalid-response'],
    [async () => ok({ unknown: true }), 'unsupported-response'],
  ]
  for (const [fetchImpl, code] of cases) {
    const reader = createQuotaReader({ credentials: credentials(), fetchImpl, now: () => NOW })
    const snapshot = await reader.read()
    assert.equal(snapshot.error.code, code)
    reader.dispose()
  }
})

test('dispose aborts inflight work and rejects subsequent reads', async () => {
  let requestSignal
  const reader = createQuotaReader({
    credentials: credentials(), now: () => NOW,
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  const pending = reader.read()
  await Promise.resolve()
  assert.equal(requestSignal.aborted, false)
  reader.dispose()
  assert.equal(requestSignal.aborted, true)
  await assert.rejects(pending, error => error?.name === 'AbortError')
  await assert.rejects(reader.read(), /Kimi quota reader is disposed/)
})
