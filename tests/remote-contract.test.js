import test from 'node:test'
import assert from 'node:assert/strict'
import contract from '../remote-contract.cjs'

const { PACKAGE, ENDPOINT, descriptor, hostContribution, TYPERT_REMOTE, parseRequest, parseSnapshot } = contract

const SNAPSHOT = {
  fetchedAt: '2026-11-20T08:00:00.000Z', error: null,
  windows: {
    fiveHour: { status: 'available', usedPercent: 73.84, resetAt: null },
    weekly: { status: 'unlimited', usedPercent: null, resetAt: null },
    monthly: { status: 'unavailable', usedPercent: null, resetAt: null },
  },
}

test('parseRequest accepts force and monthly and rejects invalid or unknown fields', () => {
  assert.deepEqual(parseRequest({ force: true }), { force: true })
  assert.deepEqual(parseRequest({ monthly: true }), { monthly: true })
  assert.deepEqual(parseRequest({ force: false, monthly: false }), { force: false, monthly: false })
  assert.deepEqual(parseRequest({}), {})
  assert.throws(() => parseRequest({ force: 'true' }), /request\.force must be a boolean/)
  assert.throws(() => parseRequest({ monthly: 1 }), /request\.monthly must be a boolean/)
  assert.throws(() => parseRequest({ extra: true }), /request has unknown field extra/)
})

test('parseSnapshot returns an exact safe snapshot and rejects unsafe fields', () => {
  assert.deepEqual(parseSnapshot(SNAPSHOT), SNAPSHOT)
  assert.throws(() => parseSnapshot({ ...SNAPSHOT, raw: { secret: true } }), /snapshot has unknown field raw/)
  for (const usedPercent of [-1, 101, NaN, Infinity, -Infinity, '73.84']) {
    assert.throws(() => parseSnapshot({
      ...SNAPSHOT,
      windows: { ...SNAPSHOT.windows, fiveHour: { ...SNAPSHOT.windows.fiveHour, usedPercent } },
    }), /usedPercent must be a finite number from 0 to 100 or null/, String(usedPercent))
  }
})

test('descriptor has a stable strict Host and Client contract', () => {
  assert.equal(descriptor.id, '@bwtymdb/kimi-quota-status#kimiQuota/read')
  assert.equal(descriptor.id, `${PACKAGE}#${ENDPOINT}`)
  assert.equal(descriptor.service, 'kimiQuota')
  assert.equal(descriptor.parameters[0].codec.mode, 'strict')
  assert.equal(descriptor.parameters[0].strictCodec.mode, 'strict')
  assert.equal(descriptor.result.mode, 'strict')
  assert.deepEqual(descriptor.parameters[0].codec.jsonSchema.properties.monthly, { type: 'boolean' })
  assert.deepEqual(hostContribution.invocations, [descriptor])
  assert.equal(TYPERT_REMOTE.methods[ENDPOINT], descriptor)
  assert.equal(TYPERT_REMOTE.descriptors[0].description, hostContribution.invocations[0].description)
})

test('descriptor input and invoke preserve request and AbortSignal', async () => {
  const controller = new AbortController()
  const input = { request: { force: true } }
  assert.deepEqual(descriptor.input().create().parse(input), input)
  let received
  const remote = {
    kimiQuota: {
      async read(request, signal) {
        received = { request, signal }
        return SNAPSHOT
      },
    },
  }
  assert.equal(await descriptor.invoke(remote, input, controller.signal), SNAPSHOT)
  assert.deepEqual(received, { request: { force: true }, signal: controller.signal })
})
