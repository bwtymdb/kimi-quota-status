import { normalizeQuota } from './quota.js'
const ENDPOINT = 'https://api.kimi.com/coding/v1/usages'
const CREDENTIAL_REF = 'KIMI_API_KEY'
const unavailable = () => ({ status: 'unavailable', usedPercent: null, resetAt: null })
const emptyWindows = () => ({ fiveHour: unavailable(), weekly: unavailable(), monthly: unavailable() })
function waitWithSignal(task, signal) {
  if (signal === undefined) return task
  if (signal.aborted) return Promise.reject(signal.reason)
  let listener
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true })
  })
  return Promise.race([task, cancelled]).finally(() => signal.removeEventListener('abort', listener))
}
export function createQuotaReader({ credentials, fetchImpl = fetch, now = () => Date.now(), cacheTtlMs = 60_000, timeoutMs = 10_000, monthlyReader }) {
  let cache, lastGood, inflight, inflightMonthly
  let revision = 0, disposed = false
  const lifetime = new AbortController()
  function errorSnapshot(code, preserve = true) {
    return !preserve || lastGood === undefined
      ? { fetchedAt: null, error: { code }, windows: emptyWindows() }
      : { ...lastGood, error: { code } }
  }
  async function perform(observedRevision, includeMonthly) {
    let snapshot
    try {
      const credential = await credentials.resolve(CREDENTIAL_REF)
      if (credential === undefined) snapshot = errorSnapshot('credential-missing', false)
      else {
        lifetime.signal.throwIfAborted()
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)])
        const result = await fetchImpl(ENDPOINT, {
          headers: { Authorization: `Bearer ${credential.value}`, Accept: 'application/json' }, signal,
        })
        if (!result.ok) {
          const code = result.status === 401 ? 'unauthorized' : result.status === 403 ? 'forbidden'
            : result.status === 429 ? 'rate-limited' : 'http-error'
          snapshot = errorSnapshot(code)
        } else {
          let payload
          try { payload = await result.json() } catch { snapshot = errorSnapshot('invalid-response') }
          if (snapshot === undefined) {
            try {
              const { windows } = normalizeQuota(payload)
              snapshot = { fetchedAt: new Date(now()).toISOString(), error: null, windows }
            } catch { snapshot = errorSnapshot('unsupported-response') }
          }
        }
      }
    } catch (error) {
      if (disposed) throw error
      snapshot = errorSnapshot(error?.name === 'TimeoutError' ? 'timeout' : 'network')
    }
    if (!disposed && snapshot.error === null && snapshot.windows.monthly.status === 'unavailable'
      && monthlyReader !== undefined && (includeMonthly === true || monthlyReader.hasSuccess())) {
      const monthly = await monthlyReader.read({ force: includeMonthly })
      snapshot = {
        ...snapshot,
        error: monthly.error === null ? null : { code: monthly.error.code },
        windows: {
          ...snapshot.windows,
          monthly: monthly.status === 'available'
            ? { status: 'available', usedPercent: monthly.usedPercent, resetAt: monthly.resetAt }
            : unavailable(),
        },
      }
    }
    if (!disposed && observedRevision === revision) {
      cache = { at: now(), snapshot }
      if (snapshot.error === null) lastGood = snapshot
      else if (snapshot.error.code === 'login-required' && lastGood !== undefined) {
        lastGood = { ...lastGood, windows: { ...lastGood.windows, monthly: unavailable() } }
      }
    }
    return snapshot
  }
  async function read(force = false, callerSignal, includeMonthly = false) {
    if (disposed) throw new Error('Kimi quota reader is disposed')
    callerSignal?.throwIfAborted()
    if (!force && includeMonthly !== true && cache !== undefined && now() - cache.at < cacheTtlMs) return waitWithSignal(Promise.resolve(cache.snapshot), callerSignal)
    if (inflight !== undefined) {
      if (includeMonthly !== true || inflightMonthly) return waitWithSignal(inflight, callerSignal)
      const queued = inflight.then(() => {
        callerSignal?.throwIfAborted()
        return read(force, callerSignal, true)
      })
      return waitWithSignal(queued, callerSignal)
    }
    const observedRevision = ++revision
    const includesMonthly = monthlyReader !== undefined && (includeMonthly === true || monthlyReader.hasSuccess())
    const task = perform(observedRevision, includeMonthly)
    inflight = task
    inflightMonthly = includesMonthly
    const clear = () => {
      if (inflight === task) {
        inflight = undefined
        inflightMonthly = false
      }
    }
    void task.then(clear, clear)
    return waitWithSignal(task, callerSignal)
  }
  function dispose() { disposed = true; revision += 1; lifetime.abort() }
  return { read, dispose }
}
