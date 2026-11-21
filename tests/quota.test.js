import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeQuota } from '../quota.js'

const OLD_PAYLOAD = {
  limits: [{
    window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '100', used: '28', remaining: '72', resetTime: '2026-11-20T08:00:00.000Z' },
  }],
  usage: { limit: '100', used: '52', remaining: '48', resetTime: '2026-11-27T08:00:00.000Z' },
}

const NEW_PAYLOAD = {
  usages: {
    limit_5h: { used_ratio: 0.28, reset_time: '2026-11-20T08:00:00.000Z' },
    limit_7d: { used_ratio: 0.52, reset_time: '2026-11-27T08:00:00.000Z' },
    limit_month_total: { used_ratio: 0.19, reset_time: '2026-12-01T08:00:00.000Z' },
  },
}

test('old payload exposes used percentages', () => {
  const { windows } = normalizeQuota(OLD_PAYLOAD)
  assert.deepEqual(windows.fiveHour, {
    status: 'available', usedPercent: 28, resetAt: '2026-11-20T08:00:00.000Z',
  })
  assert.equal(windows.weekly.status, 'available')
  assert.equal(windows.weekly.usedPercent, 52)
  assert.equal(windows.monthly.status, 'unavailable')
})

test('old payload uses supplied used directly', () => {
  const payload = structuredClone(OLD_PAYLOAD)
  delete payload.limits[0].detail.remaining
  assert.equal(normalizeQuota(payload).windows.fiveHour.usedPercent, 28)
})

test('old payload derives used from remaining only when used is missing', () => {
  const payload = structuredClone(OLD_PAYLOAD)
  delete payload.limits[0].detail.used
  assert.equal(normalizeQuota(payload).windows.fiveHour.usedPercent, 28)
})

test('old payload prioritizes supplied used over remaining', () => {
  const payload = structuredClone(OLD_PAYLOAD)
  payload.limits[0].detail.remaining = '65'
  assert.equal(normalizeQuota(payload).windows.fiveHour.usedPercent, 28)
})

test('new payload supports snake_case ratios and monthly total', () => {
  const { windows } = normalizeQuota(NEW_PAYLOAD)
  assert.equal(windows.fiveHour.status, 'available')
  assert.equal(windows.fiveHour.usedPercent, 28)
  assert.equal(windows.weekly.status, 'available')
  assert.equal(windows.weekly.usedPercent, 52)
  assert.equal(windows.monthly.status, 'available')
  assert.equal(windows.monthly.usedPercent, 19)
  assert.equal(windows.monthly.resetAt, '2026-12-01T08:00:00.000Z')
})

test('camelCase aliases and resetAt are supported', () => {
  const { windows } = normalizeQuota({
    usages: {
      limit5h: { usedRatio: 0.4, resetAt: '2026-11-20T10:00:00.000Z' },
      monthTotal: { usedRatio: 0.25 },
    },
  })
  assert.equal(windows.fiveHour.usedPercent, 40)
  assert.equal(windows.weekly.status, 'unlimited')
  assert.equal(windows.monthly.usedPercent, 25)
  assert.equal(windows.fiveHour.resetAt, '2026-11-20T10:00:00.000Z')
})

test('monthTotal wins over monthCode', () => {
  const { windows } = normalizeQuota({
    usages: {
      limit_month_code: { used_ratio: 0.4 },
      limit_month_total: { used_ratio: 0.19 },
    },
  })
  assert.equal(windows.monthly.usedPercent, 19)
})

test('monthCode is used when monthTotal is absent', () => {
  const { windows } = normalizeQuota({
    usages: {
      limit_month_code: { used_ratio: 0.4 },
    },
  })
  assert.equal(windows.monthly.status, 'available')
  assert.equal(windows.monthly.usedPercent, 40)
})

test('new payload without a weekly window means unlimited', () => {
  const payload = structuredClone(NEW_PAYLOAD)
  delete payload.usages.limit_7d
  assert.equal(normalizeQuota(payload).windows.weekly.status, 'unlimited')
})

test('invalid values degrade independently and ratios clamp to 0..100', () => {
  const { windows } = normalizeQuota({
    usages: {
      limit_5h: { used_ratio: -0.2 },
      limit_7d: { used_ratio: 1.2 },
      limit_month_total: { used_ratio: 'not-a-number' },
    },
  })
  assert.equal(windows.fiveHour.usedPercent, 0)
  assert.equal(windows.weekly.usedPercent, 100)
  assert.equal(windows.monthly.status, 'unavailable')
})

test('invalid legacy five-hour details degrade without affecting weekly quota', () => {
  const cases = [
    ['zero limit', (payload) => {
      payload.limits[0].detail.limit = '0'
    }],
    ['non-numeric used and remaining', (payload) => {
      payload.limits[0].detail.used = 'not-a-number'
      payload.limits[0].detail.remaining = 'not-a-number'
    }],
    ['missing detail', (payload) => {
      delete payload.limits[0].detail
    }],
  ]

  for (const [name, mutate] of cases) {
    const payload = structuredClone(OLD_PAYLOAD)
    mutate(payload)
    const { windows } = normalizeQuota(payload)
    assert.equal(windows.fiveHour.status, 'unavailable', name)
    assert.equal(windows.fiveHour.usedPercent, null, name)
    assert.equal(windows.weekly.status, 'available', name)
    assert.equal(windows.weekly.usedPercent, 52, name)
  }
})

test('non-300-minute legacy limits are not mislabeled as five-hour quota', () => {
  const payload = structuredClone(OLD_PAYLOAD)
  payload.limits[0].window.duration = 60
  delete payload.usage
  assert.throws(() => normalizeQuota(payload), /unsupported Kimi usage response/)
})

test('invalid reset times are omitted', () => {
  const payload = structuredClone(NEW_PAYLOAD)
  payload.usages.limit_5h.reset_time = 'not-a-date'
  assert.equal(normalizeQuota(payload).windows.fiveHour.resetAt, null)
})

test('present invalid legacy used is unavailable even when remaining is valid', () => {
  const payload = structuredClone(OLD_PAYLOAD)
  payload.limits[0].detail.used = 'not-a-number'
  const { windows } = normalizeQuota(payload)
  assert.equal(windows.fiveHour.status, 'unavailable')
  assert.equal(windows.fiveHour.usedPercent, null)
  assert.equal(windows.weekly.status, 'available')
  assert.equal(windows.weekly.usedPercent, 52)
})

test('present invalid modern weekly field is unavailable rather than unlimited', () => {
  const { windows } = normalizeQuota({ usages: { limit_7d: null } })
  assert.equal(windows.weekly.status, 'unavailable')
})

test('present invalid monthTotal does not fall back to monthCode', () => {
  const { windows } = normalizeQuota({
    usages: {
      limit_month_total: null,
      limit_month_code: { used_ratio: 0.4 },
    },
  })
  assert.equal(windows.monthly.status, 'unavailable')
  assert.equal(windows.monthly.usedPercent, null)
})

test('valid camelCase ratio and reset aliases are used when snake_case values are invalid', () => {
  const { windows } = normalizeQuota({
    usages: {
      limit_5h: {
        used_ratio: null,
        usedRatio: 0.4,
        reset_time: null,
        resetAt: '2026-11-20T08:00:00.000Z',
      },
    },
  })
  assert.equal(windows.fiveHour.status, 'available')
  assert.equal(windows.fiveHour.usedPercent, 40)
  assert.equal(windows.fiveHour.resetAt, '2026-11-20T08:00:00.000Z')
})

test('weekly selects a valid camelCase window when the snake_case alias is invalid', () => {
  const { windows } = normalizeQuota({
    usages: { limit_7d: null, limit7d: { usedRatio: 0.4 } },
  })
  assert.equal(windows.weekly.status, 'available')
  assert.equal(windows.weekly.usedPercent, 40)
})

test('monthTotal selects its valid camelCase alias without using monthCode', () => {
  const { windows } = normalizeQuota({
    usages: { limit_month_total: null, monthTotal: { usedRatio: 0.25 } },
  })
  assert.equal(windows.monthly.status, 'available')
  assert.equal(windows.monthly.usedPercent, 25)
})

test('monthCode selects a valid camelCase alias when the snake_case alias is invalid', () => {
  const { windows } = normalizeQuota({
    usages: { limit_month_code: null, monthCode: { usedRatio: 0.4 } },
  })
  assert.equal(windows.monthly.status, 'available')
  assert.equal(windows.monthly.usedPercent, 40)
})

test('legacy reset selects a valid later alias when resetTime is invalid', () => {
  const payload = structuredClone(OLD_PAYLOAD)
  payload.limits[0].detail.resetTime = null
  payload.limits[0].detail.reset_time = '2026-11-20T08:00:00.000Z'
  assert.equal(normalizeQuota(payload).windows.fiveHour.resetAt, '2026-11-20T08:00:00.000Z')
})

test('legacy five-hour window presence is independent of detail availability', () => {
  const cases = [
    ['missing detail', {}],
    ['explicit undefined detail', { detail: undefined }],
    ['null detail', { detail: null }],
  ]

  for (const [name, detail] of cases) {
    const { windows } = normalizeQuota({
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        ...detail,
      }],
    })
    assert.deepEqual(windows.fiveHour, {
      status: 'unavailable', usedPercent: null, resetAt: null,
    }, name)
    assert.equal(windows.weekly.status, 'unavailable', name)
    assert.equal(windows.monthly.status, 'unavailable', name)
  }
})

test('reset times require valid RFC3339 calendar dates', () => {
  const payload = structuredClone(NEW_PAYLOAD)
  const quota = payload.usages.limit_5h
  const cases = [
    ['2026-02-30T08:00:00.000Z', null],
    ['2026-11-20T16:00:00+08:00', '2026-11-20T08:00:00.000Z'],
    ['11/20/2026', null],
  ]

  for (const [value, expected] of cases) {
    quota.reset_time = value
    assert.equal(normalizeQuota(payload).windows.fiveHour.resetAt, expected, value)
  }
})

test('normalizeQuota does not mutate legacy or modern inputs', () => {
  for (const payload of [OLD_PAYLOAD, NEW_PAYLOAD]) {
    const input = structuredClone(payload)
    const before = structuredClone(input)
    normalizeQuota(input)
    assert.deepEqual(input, before)
  }
})

test('unsupported inputs are rejected', () => {
  for (const input of [null, undefined, [], 'usage', 42, true, {}]) {
    assert.throws(() => normalizeQuota(input), /unsupported Kimi usage response/)
  }
})
