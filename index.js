import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import contract from './remote-contract.cjs'
import { createQuotaReader } from './fetcher.js'
import { createMonthlyReader } from './browser-monthly.js'
const markerInitializers = []
export default class KimiQuotaService extends TypertRemoteService {
  static inject = ['credentials', 'typert']
  constructor(ctx) {
    super(ctx, 'kimiQuota', { namespace: 'kimiQuota' })
    for (const initialize of markerInitializers) initialize.call(this)
    this.monthlyReader = createMonthlyReader()
    this.reader = createQuotaReader({ credentials: ctx.credentials, monthlyReader: this.monthlyReader })
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
Remote(KimiQuotaService.prototype.read, {
  private: false, static: false, name: 'read',
  addInitializer(initializer) { markerInitializers.push(initializer) },
})
