import contract from './remote-contract.cjs'
import { createQuotaReader } from './fetcher.js'
import { createMonthlyReader } from './browser-monthly.js'

export default class KimiQuotaService {
  static inject = ['credentials', 'typert']

  constructor(ctx) {
    this.ctx = ctx
    this.name = 'kimiQuota'
    this.typertRemote = Object.freeze({ service: this, serviceKey: this.name, namespace: this.name })
    this.monthlyReader = createMonthlyReader()
    this.reader = createQuotaReader({ credentials: ctx.credentials, monthlyReader: this.monthlyReader })
    ctx.provide('kimiQuota', this)
    ctx.effect(() => ctx.typert.register(contract.hostContribution), 'kimi-quota: Remote descriptor')
    ctx.effect(() => () => {
      this.reader.dispose()
      return this.monthlyReader.dispose()
    }, 'kimi-quota: network lifetime')
  }

  async read(request, signal) {
    signal?.throwIfAborted()
    return this.reader.read(request?.force === true, signal, request?.monthly === true)
  }
}

// Cordis and Typert consume this stable, versioned descriptor directly. Keeping
// it here avoids an install-time dependency and preserves the same Remote wire
// contract as a decorated TypertRemoteService.
Object.defineProperty(KimiQuotaService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([{ method: 'read', invocation: Object.freeze({ kind: 'direct' }) }]),
  }),
})
