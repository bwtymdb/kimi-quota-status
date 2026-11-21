import test from 'node:test'
import assert from 'node:assert/strict'
import { createMonthlyReader } from '../browser-monthly.js'
import { createQuotaReader } from '../fetcher.js'

process.env.TZ = 'Asia/Shanghai'

const NOW = Date.parse('2026-11-20T08:00:00.000Z')
const FETCHED_AT = '2026-11-20T08:00:00.000Z'
const RESET_AT = '2026-11-29T03:49:00.000Z'
const PAGE_URL = 'https://www.kimi.com/membership/subscription?tab=quota'
const SETTINGS_URL = 'https://www.kimi.com/settings/subscription?tab=quota'
const EVAL_SOURCE = 'JSON.stringify({url:location.href,readyState:document.readyState,text:document.body?.innerText?.slice(0,20000)})'
const SAMPLE = 'Usage progress\n\nTotal usage\n73.84%\n\nView details\nKimi\nCode\nResets 2026-11-29 11:49\n\n5-hour usage\nCode\n8.24%'
const LOGIN = 'Welcome to Kimi\nLog in'
const response = payload => ({ ok: true, status: 200, json: async () => payload })
const deferred = () => {
  let resolve
  const promise = res => { resolve = res }
  return { promise: new Promise(promise), resolve }
}

function createProxy(evalTexts = [SAMPLE], { newGate } = {}) {
  const calls = []
  const counts = { new: 0, eval: 0, close: 0 }
  let rejectAll = false
  let rejectEval = false
  let closeStatus = 200
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url))
    const kind = parsed.pathname.slice(1)
    if (kind in counts) counts[kind] += 1
    calls.push({ url: String(url), method: options.method, body: options.body, signal: options.signal })
    if (rejectAll || (rejectEval && kind === 'eval')) throw new TypeError('Proxy offline')
    if (kind === 'new') {
      if (newGate !== undefined) await newGate
      return response({ targetId: 'tab-1' })
    }
    if (kind === 'eval') {
      assert.equal(parsed.searchParams.get('target'), 'tab-1')
      const text = evalTexts.length > 1 ? evalTexts.shift() : evalTexts[0]
      return response({ value: JSON.stringify({ url: SETTINGS_URL, readyState: 'complete', text }) })
    }
    if (kind === 'close') {
      assert.equal(parsed.searchParams.get('target'), 'tab-1')
      return { ok: closeStatus === 200, status: closeStatus, json: async () => ({}) }
    }
    throw new Error(`Unexpected Proxy URL: ${url}`)
  }
  return {
    calls, counts, fetchImpl,
    set rejectAll(value) { rejectAll = value },
    set rejectEval(value) { rejectEval = value },
    set closeStatus(value) { closeStatus = value },
  }
}

function createReader(proxy, now = () => NOW) {
  return createMonthlyReader({ fetchImpl: proxy.fetchImpl, now, delayImpl: async () => {} })
}

test('success returns only a safe snapshot and closes the tab', async () => {
  const proxy = createProxy()
  const reader = createReader(proxy)
  const result = await reader.read()
  assert.deepEqual(result, {
    status: 'available', usedPercent: 73.84, resetAt: RESET_AT, fetchedAt: FETCHED_AT, error: null,
  })
  assert.equal(reader.hasSuccess(), true)
  assert.deepEqual(proxy.counts, { new: 1, eval: 1, close: 1 })
  const [open, evaluate, close] = proxy.calls
  assert.deepEqual({ url: open.url, method: open.method, body: open.body }, {
    url: 'http://localhost:3456/new', method: 'POST', body: PAGE_URL,
  })
  assert.deepEqual({ url: evaluate.url, method: evaluate.method, body: evaluate.body }, {
    url: 'http://localhost:3456/eval?target=tab-1', method: 'POST', body: EVAL_SOURCE,
  })
  assert.deepEqual({ url: close.url, method: close.method }, {
    url: 'http://localhost:3456/close?target=tab-1', method: 'POST',
  })
  assert.equal(JSON.stringify(result).includes('Total usage'), false)
  assert.equal(JSON.stringify(result).toLowerCase().includes('token'), false)
  await reader.dispose()
})

test('login-required retains and reuses the tab, then clears old success on later logout', async () => {
  const proxy = createProxy([LOGIN, SAMPLE, LOGIN])
  const reader = createReader(proxy)
  const login = await reader.read()
  assert.deepEqual(login, {
    status: 'unavailable', usedPercent: null, resetAt: null, fetchedAt: null,
    error: { code: 'login-required' },
  })
  assert.equal(reader.hasSuccess(), false)
  assert.deepEqual(proxy.counts, { new: 1, eval: 1, close: 0 })

  const success = await reader.read({ force: true })
  assert.equal(success.status, 'available')
  assert.deepEqual(proxy.counts, { new: 1, eval: 2, close: 1 })
  assert.ok(proxy.calls.every(call => !call.url.includes('target=tab-2')))

  const loggedOut = await reader.read({ force: true })
  assert.equal(loggedOut.error.code, 'login-required')
  assert.equal(loggedOut.usedPercent, null)
  assert.equal(loggedOut.resetAt, null)
  assert.equal(loggedOut.fetchedAt, null)
  assert.equal(reader.hasSuccess(), false)
  assert.deepEqual(proxy.counts, { new: 2, eval: 3, close: 1 })
  await reader.dispose()
})

test('parse-failed closes the tab without inventing a percentage', async () => {
  const proxy = createProxy(['Total usage\nNaN%'])
  const reader = createReader(proxy)
  const result = await reader.read()
  assert.deepEqual(result, {
    status: 'unavailable', usedPercent: null, resetAt: null, fetchedAt: null,
    error: { code: 'parse-failed' },
  })
  assert.equal(reader.hasSuccess(), false)
  assert.deepEqual(proxy.counts, { new: 1, eval: 1, close: 1 })
  await reader.dispose()
})

test('Proxy failures are recoverable and preserve only previous successful values', async () => {
  const proxy = createProxy()
  const reader = createReader(proxy)
  proxy.rejectAll = true
  const unavailable = await reader.read()
  assert.equal(unavailable.error.code, 'browser-unavailable')
  assert.equal(unavailable.usedPercent, null)
  assert.equal(reader.hasSuccess(), false)

  proxy.rejectAll = false
  const success = await reader.read({ force: true })
  assert.equal(success.error, null)
  proxy.rejectEval = true
  const failed = await reader.read({ force: true })
  assert.deepEqual(failed, { ...success, error: { code: 'browser-unavailable' } })
  assert.equal(reader.hasSuccess(), true)
  assert.equal(proxy.counts.close, 2)

  proxy.rejectEval = false
  const recovered = await reader.read({ force: true })
  assert.equal(recovered.status, 'available')
  assert.equal(recovered.error, null)
  await reader.dispose()
})

test('concurrent reads create one tab and share the same snapshot', async () => {
  const gate = deferred()
  const proxy = createProxy([SAMPLE], { newGate: gate.promise })
  const reader = createReader(proxy)
  const first = reader.read()
  const second = reader.read({ force: true })
  await Promise.resolve()
  assert.equal(proxy.counts.new, 1)
  gate.resolve()
  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(left, right)
  assert.deepEqual(proxy.counts, { new: 1, eval: 1, close: 1 })
  await reader.dispose()
})

test('dispose closes a retained login tab and rejects later reads', async () => {
  const proxy = createProxy([LOGIN])
  const reader = createReader(proxy)
  await reader.read()
  assert.equal(proxy.counts.close, 0)
  await reader.dispose()
  assert.equal(proxy.counts.close, 1)
  await assert.rejects(reader.read(), /disposed/)
})

test('successful snapshots cache for ten minutes and force bypasses the cache', async () => {
  let now = NOW
  const proxy = createProxy()
  const reader = createReader(proxy, () => now)
  await reader.read()
  now += 599_999
  await reader.read()
  assert.equal(proxy.counts.new, 1)
  await reader.read({ force: true })
  assert.equal(proxy.counts.new, 2)
  now += 600_000
  await reader.read()
  assert.equal(proxy.counts.new, 3)
  assert.equal(proxy.counts.close, 3)
  await reader.dispose()
})

test('bounded waiting maps to browser-timeout and closes the tab', async () => {
  const proxy = createProxy(['Loading'])
  const delays = []
  const reader = createMonthlyReader({
    fetchImpl: proxy.fetchImpl, now: () => NOW,
    delayImpl: async ms => { delays.push(ms) },
  })
  const result = await reader.read()
  assert.equal(result.error.code, 'browser-timeout')
  assert.equal(result.usedPercent, null)
  assert.equal(proxy.counts.eval, 30)
  assert.equal(proxy.counts.close, 1)
  assert.deepEqual(delays, Array(30).fill(500))
  await reader.dispose()
})

test('caller cancellation only cancels its wait for the shared task', async () => {
  const gate = deferred()
  const proxy = createProxy([SAMPLE], { newGate: gate.promise })
  const reader = createReader(proxy)
  const controller = new AbortController()
  const cancelled = reader.read({ signal: controller.signal })
  const shared = reader.read()
  await Promise.resolve()
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(cancelled, /caller cancelled/)
  assert.equal(proxy.calls[0].signal?.aborted ?? false, false)
  gate.resolve()
  assert.equal((await shared).status, 'available')
  assert.equal(proxy.counts.new, 1)
  await reader.dispose()
})

test('Host caller cancellation does not downgrade a shared forced monthly refresh', async () => {
  const proxy = createProxy([SAMPLE, 'Total usage\n8%'])
  const baseFetch = proxy.fetchImpl
  const forcedNewStarted = deferred()
  const releaseForcedNew = deferred()
  let blockForcedNew = false
  const fetchImpl = async (url, options) => {
    if (blockForcedNew && new URL(String(url)).pathname === '/new') {
      blockForcedNew = false
      forcedNewStarted.resolve()
      await releaseForcedNew.promise
    }
    return baseFetch(url, options)
  }
  const monthlyReader = createMonthlyReader({ fetchImpl, now: () => NOW, delayImpl: async () => {} })
  assert.equal((await monthlyReader.read()).usedPercent, 73.84)
  blockForcedNew = true
  const quotaReader = createQuotaReader({
    credentials: { resolve: async () => ({ value: 'test-secret', source: 'test' }) },
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({
        limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '28' } }],
        usage: { limit: '100', used: '52' },
      }),
    }),
    now: () => NOW, monthlyReader,
  })
  const controller = new AbortController()
  const cancelled = quotaReader.read(true, controller.signal, true)
  const survivor = quotaReader.read(true, undefined, true)
  await forcedNewStarted.promise
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(cancelled, /caller cancelled/)
  releaseForcedNew.resolve()
  const snapshot = await survivor
  assert.equal(snapshot.error, null)
  assert.equal(snapshot.windows.monthly.usedPercent, 8)
  assert.equal(proxy.counts.new, 2)
  assert.equal(proxy.counts.eval, 2)
  assert.equal(proxy.counts.close, 2)
  quotaReader.dispose()
  await monthlyReader.dispose()
})

test('close failure retains the owned tab for disposal retry without reopening', async () => {
  const proxy = createProxy()
  proxy.closeStatus = 500
  const reader = createReader(proxy)
  assert.equal((await reader.read()).status, 'available')
  assert.equal(proxy.counts.close, 1)
  proxy.closeStatus = 200
  await reader.dispose()
  assert.equal(proxy.counts.close, 2)
  assert.equal(proxy.counts.new, 1)
})

test('dispose waits for an unresponsive new request and closes its tab exactly once', async () => {
  const gate = deferred()
  const proxy = createProxy([SAMPLE], { newGate: gate.promise })
  const reader = createReader(proxy)
  const pending = reader.read()
  await Promise.resolve()
  const disposing = reader.dispose()
  assert.equal(proxy.counts.new, 1)
  gate.resolve()
  await disposing
  await assert.rejects(pending, /disposed/)
  assert.equal(proxy.counts.eval, 0)
  assert.equal(proxy.counts.close, 1)
  assert.equal(proxy.calls[0].signal?.aborted ?? false, false)
  await assert.rejects(reader.read(), /disposed/)
})

test('default fetch retains its global receiver', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async function (url, _options) {
    'use strict'
    const baseUrl = this.proxyBaseUrl
    assert.equal(this, globalThis)
    assert.equal(baseUrl, undefined)
    const path = new URL(String(url)).pathname
    calls.push(path)
    if (path === '/new') return response({ targetId: 'tab-1' })
    if (path === '/eval') {
      return response({ value: JSON.stringify({ url: SETTINGS_URL, readyState: 'complete', text: SAMPLE }) })
    }
    if (path === '/close') return response({})
    throw new Error(`Unexpected Proxy URL: ${url}`)
  }
  const reader = createMonthlyReader()
  try {
    const result = await reader.read()
    assert.equal(result.status, 'available')
    assert.equal(result.usedPercent, 73.84)
    assert.deepEqual(calls, ['/new', '/eval', '/close'])
  } finally {
    await reader.dispose()
    globalThis.fetch = originalFetch
  }
})
