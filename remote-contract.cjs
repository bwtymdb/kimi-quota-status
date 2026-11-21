'use strict'
const PACKAGE = '@bwtymdb/kimi-quota-status'
const ENDPOINT = 'kimiQuota/read'
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
function object(value, subject) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${subject} must be an object`)
  return value
}
function keys(value, allowed, subject) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${subject} has unknown field ${key}`)
}
function nullableString(value, subject) {
  if (value !== null && typeof value !== 'string') throw new TypeError(`${subject} must be a string or null`)
  return value
}
function parseRequest(input) {
  const value = object(input, 'request'); keys(value, ['force', 'monthly'], 'request')
  if (has(value, 'force') && typeof value.force !== 'boolean') throw new TypeError('request.force must be a boolean')
  if (has(value, 'monthly') && typeof value.monthly !== 'boolean') throw new TypeError('request.monthly must be a boolean')
  return {
    ...(has(value, 'force') ? { force: value.force } : {}),
    ...(has(value, 'monthly') ? { monthly: value.monthly } : {}),
  }
}
function parseWindow(input, subject) {
  const value = object(input, subject); keys(value, ['status', 'usedPercent', 'resetAt'], subject)
  if (!['available', 'unlimited', 'unavailable'].includes(value.status)) throw new TypeError(`${subject}.status is invalid`)
  const percent = value.usedPercent
  if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) throw new TypeError(`${subject}.usedPercent must be a finite number from 0 to 100 or null`)
  return { status: value.status, usedPercent: percent, resetAt: nullableString(value.resetAt, `${subject}.resetAt`) }
}
function parseSnapshot(input) {
  const value = object(input, 'snapshot'); keys(value, ['fetchedAt', 'error', 'windows'], 'snapshot')
  const windows = object(value.windows, 'snapshot.windows'); keys(windows, ['fiveHour', 'weekly', 'monthly'], 'snapshot.windows')
  let error = null
  if (value.error !== null) {
    const rawError = object(value.error, 'snapshot.error'); keys(rawError, ['code'], 'snapshot.error')
    if (typeof rawError.code !== 'string' || rawError.code.length === 0) throw new TypeError('snapshot.error.code must be nonempty')
    error = { code: rawError.code }
  }
  return {
    fetchedAt: nullableString(value.fetchedAt, 'snapshot.fetchedAt'), error,
    windows: {
      fiveHour: parseWindow(windows.fiveHour, 'snapshot.windows.fiveHour'),
      weekly: parseWindow(windows.weekly, 'snapshot.windows.weekly'),
      monthly: parseWindow(windows.monthly, 'snapshot.windows.monthly'),
    },
  }
}
function codec(typeSymbol, parse, jsonSchema) { return { mode: 'strict', typeSymbol, create: () => ({ parse }), jsonSchema } }
const requestCodec = codec('@bwtymdb/kimi-quota-status#ReadRequest', parseRequest, {
  type: 'object', properties: { force: { type: 'boolean' }, monthly: { type: 'boolean' } }, additionalProperties: false,
})
const snapshotCodec = codec('@bwtymdb/kimi-quota-status#QuotaSnapshot', parseSnapshot, {
  type: 'object', properties: { fetchedAt: { type: ['string', 'null'] }, error: {}, windows: { type: 'object' } },
  required: ['fetchedAt', 'error', 'windows'], additionalProperties: false,
})
const namedInput = {
  create: () => ({ parse(input) {
    const value = object(input, 'arguments'); keys(value, ['request'], 'arguments')
    if (!has(value, 'request')) throw new TypeError('arguments.request is required')
    return { request: parseRequest(value.request) }
  } }),
  jsonSchema: { type: 'object', properties: { request: requestCodec.jsonSchema }, required: ['request'], additionalProperties: false },
}
const descriptor = {
  id: `${PACKAGE}#${ENDPOINT}`, service: 'kimiQuota', namespace: 'kimiQuota', method: 'read',
  description: 'Read a secret-free Kimi membership quota snapshot.', invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: requestCodec, strictCodec: requestCodec }],
  cancellation: { parameter: 'signal' }, result: snapshotCodec, input: () => namedInput,
  invoke(remote, input, signal) {
    const named = namedInput.create().parse(input)
    return remote.kimiQuota.read(named.request, signal)
  },
}
const TYPERT_REMOTE = { package: PACKAGE, descriptors: [descriptor], methods: { [ENDPOINT]: descriptor } }
const hostContribution = {
  package: PACKAGE, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [descriptor],
}
module.exports = { PACKAGE, ENDPOINT, descriptor, hostContribution, TYPERT_REMOTE, parseRequest, parseSnapshot }
