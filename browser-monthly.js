import { parseMonthlyUsage } from './monthly-page.js'

const PAGE_URL = 'https://www.kimi.com/membership/subscription?tab=quota'
const EVAL_SOURCE = 'JSON.stringify({url:location.href,readyState:document.readyState,text:document.body?.innerText?.slice(0,20000)})'
const unavailable = code => ({
  status: 'unavailable', usedPercent: null, resetAt: null, fetchedAt: null, error: { code },
})
function waitWithSignal(task, signal) {
  if (signal === undefined) return task
  if (signal.aborted) return Promise.reject(signal.reason)
  let listener
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
  })
  return Promise.race([task, cancelled]).finally(() => signal.removeEventListener('abort', listener))
}

export function createMonthlyReader({
  proxyBaseUrl = 'http://localhost:3456',
  fetchImpl = globalThis.fetch.bind(globalThis),
  now = () => Date.now(),
  cacheTtlMs = 600_000,
  delayImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let previousSuccess, cacheAt, inflight, targetId, closePromise
  let disposed = false
  const lifetime = new AbortController()

  function failure(code) {
    if (code === 'login-required') {
      previousSuccess = undefined
      cacheAt = undefined
      return unavailable(code)
    }
    return previousSuccess === undefined ? unavailable(code) : { ...previousSuccess, error: { code } }
  }

  async function request(path, body, cancellable = true) {
    const options = { method: 'POST', body }
    if (cancellable) options.signal = lifetime.signal
    const response = await fetchImpl(`${proxyBaseUrl}${path}`, options)
    if (!response.ok) throw new Error('browser-unavailable')
    return response.json()
  }

  function closeOwned() {
    if (targetId === undefined) return Promise.resolve()
    if (closePromise !== undefined) return closePromise
    const id = targetId
    const task = (async () => {
      try {
        const response = await fetchImpl(`${proxyBaseUrl}/close?target=${encodeURIComponent(id)}`, { method: 'POST' })
        if (response.ok && targetId === id) targetId = undefined
      } catch {}
    })()
    closePromise = task
    const clear = () => { if (closePromise === task) closePromise = undefined }
    void task.then(clear, clear)
    return task
  }

  async function perform() {
    let retainTab = false
    try {
      if (targetId === undefined) {
        const opened = await request('/new', PAGE_URL, false)
        if (typeof opened?.targetId !== 'string') throw new Error('browser-unavailable')
        targetId = opened.targetId
      }
      if (disposed) throw new Error('Kimi monthly reader is disposed')
      lifetime.signal.throwIfAborted()
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await request(`/eval?target=${encodeURIComponent(targetId)}`, EVAL_SOURCE)
        lifetime.signal.throwIfAborted()
        if (result?.error !== undefined || typeof result?.value !== 'string') throw new Error('browser-unavailable')
        const page = JSON.parse(result.value)
        const text = typeof page?.text === 'string' ? page.text : ''
        if (/Total usage/i.test(text)) {
          let parsed
          try { parsed = parseMonthlyUsage(text) } catch { return failure('parse-failed') }
          const at = now()
          const snapshot = {
            status: 'available', usedPercent: parsed.usedPercent, resetAt: parsed.resetAt,
            fetchedAt: new Date(at).toISOString(), error: null,
          }
          previousSuccess = snapshot
          cacheAt = at
          return snapshot
        }
        if (/Log in|登录/i.test(text)) {
          retainTab = true
          return failure('login-required')
        }
        await waitWithSignal(Promise.resolve().then(() => delayImpl(500)), lifetime.signal)
      }
      return failure('browser-timeout')
    } catch (error) {
      if (disposed) throw new Error('Kimi monthly reader is disposed')
      if (lifetime.signal.aborted) throw error
      return failure('browser-unavailable')
    } finally {
      if (!retainTab) await closeOwned()
    }
  }

  function read({ force = false, signal } = {}) {
    if (disposed) return Promise.reject(new Error('Kimi monthly reader is disposed'))
    try { signal?.throwIfAborted() } catch (error) { return Promise.reject(error) }
    if (!force && previousSuccess !== undefined && now() - cacheAt < cacheTtlMs) {
      return waitWithSignal(Promise.resolve(previousSuccess), signal)
    }
    if (inflight !== undefined) return waitWithSignal(inflight, signal)
    const task = perform()
    inflight = task
    const clear = () => { if (inflight === task) inflight = undefined }
    void task.then(clear, clear)
    return waitWithSignal(task, signal)
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    lifetime.abort()
    const task = inflight
    if (task !== undefined) await task.catch(() => {})
    await closeOwned()
  }

  return { read, hasSuccess: () => previousSuccess !== undefined, dispose }
}
