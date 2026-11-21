import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMonthlyUsage } from '../monthly-page.js'

process.env.TZ = 'Asia/Shanghai'

const SAMPLE = 'Usage progress\n\nTotal usage\n73.84%\n\nView details\nKimi\nCode\nResets 2026-11-29 11:49\n\n5-hour usage\nCode\n8.24%'

test('parses total monthly usage and its Shanghai reset time', () => {
  assert.deepEqual(parseMonthlyUsage(SAMPLE), {
    usedPercent: 73.84,
    resetAt: '2026-11-29T03:49:00.000Z',
  })
})

test('parses total monthly usage without a reset time', () => {
  assert.deepEqual(parseMonthlyUsage('Total usage\n8%'), {
    usedPercent: 8,
    resetAt: null,
  })
})

test('rejects other windows and invalid total percentages', () => {
  for (const text of [
    '5-hour usage\n8.24%',
    'Total usage\n101%',
    'Total usage\nNaN%',
    'Total usage\n-1%',
  ]) {
    assert.throws(() => parseMonthlyUsage(text), /parse-failed/, text)
  }
})
