const unavailable = () => ({ status: 'unavailable', usedPercent: null, resetAt: null })
const unlimited = () => ({ status: 'unlimited', usedPercent: null, resetAt: null })

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function finite(value) {
  if (typeof value === 'string' && value.trim() === '') return undefined
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? number : undefined
}

function resetAt(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    if (match === null) continue
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = Number(match[6])
    const offsetHour = match[8] === undefined ? 0 : Number(match[8])
    const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) continue
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    if (day < 1 || day > daysInMonth) continue
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return null
}

function percent(value) {
  if (!Number.isFinite(value)) return null
  return Math.round(Math.min(1, Math.max(0, value)) * 100)
}

function available(usedPercent, reset) {
  return usedPercent === null
    ? { ...unavailable(), resetAt: reset }
    : { status: 'available', usedPercent, resetAt: reset }
}

function fromQuota(value) {
  const quota = record(value)
  if (quota === undefined) return unavailable()
  const limit = finite(quota.limit)
  const used = finite(quota.used)
  const remaining = finite(quota.remaining)
  const reset = resetAt(quota.resetTime, quota.reset_time, quota.resetAt)
  if (limit === undefined || limit <= 0) return { ...unavailable(), resetAt: reset }
  if (Object.hasOwn(quota, 'used')) {
    return used === undefined
      ? { ...unavailable(), resetAt: reset }
      : available(percent(used / limit), reset)
  }
  if (remaining !== undefined) return available(percent(1 - remaining / limit), reset)
  return { ...unavailable(), resetAt: reset }
}

function fromRatio(value) {
  const quota = record(value)
  if (quota === undefined) return unavailable()
  const ratio = finite(quota.used_ratio) ?? finite(quota.usedRatio)
  const reset = resetAt(quota.reset_time, quota.resetAt, quota.resetTime)
  return ratio === undefined ? { ...unavailable(), resetAt: reset } : available(percent(ratio), reset)
}

function selectWindow(container, ...names) {
  let present = false
  let selected
  for (const name of names) {
    if (!Object.hasOwn(container, name)) continue
    present = true
    const candidate = fromRatio(container[name])
    if (candidate.status === 'available') return { present, window: candidate }
    if (selected === undefined) selected = candidate
  }
  return { present, window: selected === undefined ? unavailable() : selected }
}

function legacyFiveHour(payload) {
  const limits = Array.isArray(payload.limits) ? payload.limits : []
  const match = limits.find(candidate => {
    const item = record(candidate)
    const window = record(item?.window)
    return window?.timeUnit === 'TIME_UNIT_MINUTE' && finite(window.duration) === 300
  })
  return { present: match !== undefined, detail: record(match)?.detail }
}

export function normalizeQuota(input) {
  const payload = record(input)
  if (payload === undefined) throw new Error('unsupported Kimi usage response')
  const modern = record(payload.usages)
  const oldFiveHour = legacyFiveHour(payload)
  const oldWeekly = record(payload.usage)
  if (modern === undefined && !oldFiveHour.present && oldWeekly === undefined) {
    throw new Error('unsupported Kimi usage response')
  }

  const fiveHour = oldFiveHour.present
    ? fromQuota(oldFiveHour.detail)
    : modern === undefined ? unavailable() : selectWindow(modern, 'limit_5h', 'limit5h').window

  let weekly
  if (oldWeekly !== undefined) weekly = fromQuota(oldWeekly)
  else if (modern === undefined) weekly = unavailable()
  else {
    const selected = selectWindow(modern, 'limit_7d', 'limit7d')
    weekly = selected.present ? selected.window : unlimited()
  }

  let monthly = unavailable()
  if (modern !== undefined) {
    const total = selectWindow(modern, 'limit_month_total', 'monthTotal')
    const selected = total.present ? total : selectWindow(modern, 'limit_month_code', 'monthCode')
    monthly = selected.window
  }
  return { windows: { fiveHour, weekly, monthly } }
}
