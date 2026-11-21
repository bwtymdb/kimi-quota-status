import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const contract = createRequire(import.meta.url)('../remote-contract.cjs')
const clientSource = readFileSync(new URL('../client-main.cjs', import.meta.url), 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}
const snapshot = (error = null) => ({
  fetchedAt: '2026-11-20T08:00:00.000Z', error,
  windows: {
    fiveHour: { status: 'available', usedPercent: 28, resetAt: null },
    weekly: { status: 'unlimited', usedPercent: null, resetAt: null },
    monthly: { status: 'unavailable', usedPercent: null, resetAt: null },
  },
})
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

function loadClient() {
  const module = { exports: {} }
  vm.runInNewContext(clientSource, {
    module, exports: module.exports, AbortController, AbortSignal,
    require(id) {
      if (id === 'react') return React
      if (id === './remote-contract.cjs') return contract
      throw new Error(`Unexpected require: ${id}`)
    },
  }, { filename: 'client-main.cjs' })
  return module.exports
}

function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.props?.className === className) return node
  for (const child of node.children ?? []) {
    const match = findByClass(child, className)
    if (match !== undefined) return match
  }
  return undefined
}

function createHarness() {
  let component, registration, translations
  let readHandler = async () => ({ ok: true, value: snapshot() })
  const calls = [], intervals = [], effects = []
  const disposed = { locale: 0, slot: 0, timer: 0, ui: 0, remote: 0 }
  const remote = {
    async $mount() { return async () => { disposed.remote += 1 } },
    kimiQuota: {
      read(request, signal) {
        calls.push({ force: request.force, monthly: request.monthly, signal })
        return readHandler()
      },
    },
  }
  const child = {
    remote,
    effect(callback) { effects.push(callback()) },
    locale: {
      register(_ns, resources) {
        translations = resources.en
        return () => { disposed.locale += 1 }
      },
      bind() {
        return key => key.split('.').reduce((value, part) => value?.[part], translations) ?? key
      },
      subscribe() { return () => {} },
      getSnapshot() { return 0 },
    },
    slots: {
      inject(_name, factory) { return factory() },
      register(options, quotaStatus) {
        registration = options
        component = quotaStatus
        return () => { disposed.slot += 1 }
      },
    },
    timer: {
      interval(callback, ms) {
        intervals.push({ callback, ms })
        return () => { disposed.timer += 1 }
      },
    },
  }
  const ctx = {
    remote,
    inject(_dependencies, callback) {
      callback(child)
      return {
        async dispose() {
          disposed.ui += 1
          for (const cleanup of effects.reverse()) {
            if (typeof cleanup === 'function') await cleanup()
          }
        },
      }
    },
  }
  return {
    ctx, client: loadClient(), calls, intervals, disposed,
    get component() { return component },
    get registration() { return registration },
    setRead(handler) { readHandler = handler },
    button() { return findByClass(component(), 'kimi-quota-status') },
    announcement() { return findByClass(component(), 'kimi-quota-status__sr-only').children[0] },
  }
}

function partText(harness, key) {
  const part = harness.button().children.find(child => child.props?.key === key)
  return part?.children.join('')
}

test('apply registers the dock component and performs an initial read', async () => {
  const harness = createHarness()
  const cleanup = await harness.client.apply(harness.ctx)
  await flush()
  assert.equal(harness.registration.id, 'kimi-quota')
  assert.equal(harness.registration.order, 2)
  assert.equal(typeof harness.component, 'function')
  assert.deepEqual(harness.calls.map(call => call.force), [false])
  assert.deepEqual(harness.calls.map(call => call.monthly), [false])
  assert.equal(harness.announcement(), '')
  await cleanup()
})

test('manual refresh deduplicates pending force requests and announces outcomes', async () => {
  const outcomes = [
    [{ ok: true, value: snapshot() }, /Kimi membership quota refreshed\./],
    [{ ok: false }, /Kimi membership quota refresh failed\./],
  ]
  for (const [outcome, expected] of outcomes) {
    const harness = createHarness()
    const cleanup = await harness.client.apply(harness.ctx)
    await flush()
    const pending = deferred()
    harness.setRead(() => pending.promise)
    const { onClick } = harness.button().props
    onClick()
    onClick()
    assert.deepEqual(harness.calls.map(call => call.force), [false, true])
    assert.match(harness.announcement(), /Updating Kimi membership quota/)
    pending.resolve(outcome)
    await flush()
    assert.match(harness.announcement(), expected)
    await cleanup()
  }
})

test('timer refreshes automatically and cleanup blocks all later work', async () => {
  const harness = createHarness()
  const cleanup = await harness.client.apply(harness.ctx)
  await flush()
  assert.equal(harness.intervals.length, 1)
  assert.equal(harness.intervals[0].ms, 60_000)
  harness.intervals[0].callback()
  assert.deepEqual(harness.calls.map(call => call.force), [false, false])
  await flush()

  const announcement = harness.announcement()
  const { onClick } = harness.button().props
  const signal = harness.calls[0].signal
  await cleanup()
  assert.deepEqual(harness.disposed, { locale: 1, slot: 1, timer: 1, ui: 1, remote: 1 })
  assert.equal(signal.aborted, true)

  harness.intervals[0].callback()
  onClick()
  await flush()
  assert.deepEqual(harness.calls.map(call => call.force), [false, false])
  assert.equal(harness.announcement(), announcement)
})

test('monthly click opts in once while later manual and timer reads do not force it', async () => {
  const harness = createHarness()
  const cleanup = await harness.client.apply(harness.ctx)
  await flush()
  assert.equal(partText(harness, 'monthly'), 'Month Log in')

  const available = snapshot()
  available.windows.monthly = {
    status: 'available', usedPercent: 73.84, resetAt: '2026-11-29T03:49:00.000Z',
  }
  harness.setRead(async () => ({ ok: true, value: available }))
  harness.button().props.onClick()
  await flush()
  assert.deepEqual(harness.calls.map(call => [call.force, call.monthly]), [[false, false], [true, true]])
  assert.equal(partText(harness, 'monthly'), 'Month 73.84%')

  harness.button().props.onClick()
  await flush()
  assert.deepEqual(harness.calls.at(-1), { force: true, monthly: false, signal: harness.calls.at(-1).signal })
  harness.intervals[0].callback()
  await flush()
  assert.deepEqual(harness.calls.map(call => [call.force, call.monthly]), [
    [false, false], [true, true], [true, false], [false, false],
  ])
  await cleanup()
})

test('monthly click queues behind pending automatic refresh with updating feedback', async () => {
  const available = snapshot()
  available.windows.monthly = {
    status: 'available', usedPercent: 73.84, resetAt: '2026-11-29T03:49:00.000Z',
  }
  for (const [outcome, expected] of [
    [available, 'Month 73.84%'],
    [snapshot({ code: 'login-required' }), 'Month Log in'],
  ]) {
    const harness = createHarness()
    const initial = deferred()
    harness.setRead(() => initial.promise)
    const cleanup = await harness.client.apply(harness.ctx)
    assert.deepEqual(harness.calls.map(call => [call.force, call.monthly]), [[false, false]])

    harness.button().props.onClick()
    harness.button().props.onClick()
    const pendingText = partText(harness, 'monthly')
    const pendingDisabled = harness.button().props['aria-disabled']
    assert.equal(harness.calls.length, 1)
    harness.setRead(async () => ({ ok: true, value: outcome }))
    initial.resolve({ ok: true, value: snapshot() })
    await flush()

    assert.deepEqual(harness.calls.map(call => [call.force, call.monthly]), [[false, false], [true, true]])
    assert.equal(pendingText, 'Month …')
    assert.equal(pendingDisabled, true)
    assert.equal(partText(harness, 'monthly'), expected)
    await cleanup()
  }
})

test('login-required keeps the monthly login label and explains manual login', async () => {
  const harness = createHarness()
  const cleanup = await harness.client.apply(harness.ctx)
  await flush()
  harness.setRead(async () => ({ ok: true, value: snapshot({ code: 'login-required' }) }))
  harness.button().props.onClick()
  await flush()
  assert.deepEqual(harness.calls.map(call => [call.force, call.monthly]), [[false, false], [true, true]])
  assert.equal(partText(harness, 'monthly'), 'Month Log in')
  assert.match(harness.button().props.title, /Kimi browser login is required/)
  assert.match(harness.button().props.title, /retained Kimi tab/)
  assert.match(harness.button().props['aria-label'], /retained Kimi tab/)
  await cleanup()
})

test('attempted browser failures show an unavailable monthly value and safe error text', async () => {
  const cases = [
    ['browser-unavailable', /browser bridge is unavailable/],
    ['browser-timeout', /subscription page timed out/],
    ['parse-failed', /valid monthly usage/],
  ]
  for (const [code, message] of cases) {
    const harness = createHarness()
    const cleanup = await harness.client.apply(harness.ctx)
    await flush()
    harness.setRead(async () => ({ ok: true, value: snapshot({ code }) }))
    harness.button().props.onClick()
    await flush()
    assert.equal(partText(harness, 'monthly'), 'Month —', code)
    assert.match(harness.button().props.title, message, code)
    assert.doesNotMatch(harness.button().props.title, /refresh failed\. Existing values are retained\.?$/i)
    await cleanup()
  }
})
