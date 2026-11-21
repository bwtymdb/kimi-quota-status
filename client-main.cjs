'use strict'
const React = require('react')
const { TYPERT_REMOTE, ENDPOINT } = require('./remote-contract.cjs')
const h = React.createElement
const NS = 'kimiQuota'
const en = {
  fiveHour: '5H', weekly: 'Week', monthly: 'Month', unlimited: 'No limit',
  refresh: 'Refresh Kimi membership quota', updating: 'Updating Kimi membership quota',
  refreshSucceeded: 'Kimi membership quota refreshed.', refreshFailed: 'Kimi membership quota refresh failed.',
  updated: 'Last successful update', reset: 'Reset', unavailable: 'Unavailable',
  login: 'Log in', loginHelp: 'Use the retained Kimi tab to log in manually, then click again to retry monthly quota.',
  errors: {
    'credential-missing': 'KIMI_API_KEY is not configured in DSH model settings.',
    unauthorized: 'Kimi rejected the credential. Check KIMI_API_KEY in DSH model settings.',
    forbidden: 'The Kimi credential cannot read this membership quota.',
    'rate-limited': 'Kimi rate-limited the quota request. Existing values are retained.',
    'http-error': 'Kimi returned an HTTP error. Existing values are retained.',
    timeout: 'The quota request timed out. Existing values are retained.',
    network: 'The quota service is unreachable. Existing values are retained.',
    'invalid-response': 'Kimi returned invalid JSON. Existing values are retained.',
    'unsupported-response': 'This Kimi response shape is not supported.',
    'login-required': 'Kimi browser login is required for monthly quota.',
    'browser-unavailable': 'The browser bridge is unavailable. Existing monthly values are retained.',
    'browser-timeout': 'The Kimi subscription page timed out. Existing monthly values are retained.',
    'parse-failed': 'The Kimi subscription page did not contain a valid monthly usage value.',
    'remote-error': 'The DSH Host quota service is unavailable.', generic: 'Quota refresh failed. Existing values are retained.',
  },
}
const zh = {
  fiveHour: '5H', weekly: '周', monthly: '月', unlimited: '不限',
  refresh: '刷新 Kimi 会员余量', updating: '正在更新 Kimi 会员余量',
  refreshSucceeded: 'Kimi 会员余量已刷新。', refreshFailed: 'Kimi 会员余量刷新失败。',
  updated: '最后成功更新', reset: '重置', unavailable: '未提供',
  login: '登录', loginHelp: '请在保留的 Kimi 标签页中手动登录，然后再次点击重试月度余量。',
  errors: {
    'credential-missing': 'KIMI_API_KEY 未配置，请在 DSH 模型设置中检查。',
    unauthorized: 'Kimi 拒绝了凭据，请在 DSH 模型设置中检查 KIMI_API_KEY。',
    forbidden: '当前 Kimi 凭据无权读取会员余量。',
    'rate-limited': 'Kimi 限制了余量查询频率，已保留上一次数据。',
    'http-error': 'Kimi 返回 HTTP 错误，已保留上一次数据。', timeout: '余量查询超时，已保留上一次数据。',
    network: '无法连接余量服务，已保留上一次数据。', 'invalid-response': 'Kimi 返回了无效 JSON，已保留上一次数据。',
    'unsupported-response': '暂不支持此 Kimi 响应结构。',
    'login-required': '月度余量需要 Kimi 浏览器登录。',
    'browser-unavailable': '浏览器桥接不可用，已保留上一次月度数据。',
    'browser-timeout': '读取 Kimi 订阅页面超时，已保留上一次月度数据。',
    'parse-failed': 'Kimi 订阅页面未提供有效的月度用量。',
    'remote-error': 'DSH Host 余量服务不可用。', generic: '余量刷新失败，已保留上一次数据。',
  },
}
const CSS = `
.kimi-quota-status { appearance:none; border:0; background:transparent; padding:1px 0; margin-inline-start:0; order:100; max-width:100%; color:var(--dsw-alias-label-tertiary); font-size:var(--dsh-content-font-size-secondary, 13px); font-variant-numeric:tabular-nums; line-height:calc(20px + var(--dsh-content-font-delta-secondary, 0px)); display:inline-flex; flex-wrap:wrap; align-items:baseline; column-gap:4px; cursor:pointer; text-align:left; }
.kimi-quota-status:hover:not([aria-disabled='true']) { color:var(--dsw-alias-label-secondary); }
.kimi-quota-status:focus-visible { outline:1px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:2px; }
.kimi-quota-status[aria-disabled='true'] { cursor:default; }
.kimi-quota-status__error { color:var(--dsw-alias-state-error-primary); }
.kimi-quota-status__sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (prefers-reduced-motion:no-preference) { .kimi-quota-status { transition:color 120ms ease; } }
`
const unavailable = () => ({ status: 'unavailable', usedPercent: null, resetAt: null })
const initialSnapshot = () => ({ fetchedAt: null, error: null, windows: { fiveHour: unavailable(), weekly: unavailable(), monthly: unavailable() } })
function createStore() {
  let state = { snapshot: initialSnapshot(), refreshing: false, transportError: null, announcement: '', monthlyAttempted: false, monthlyPending: false }
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set(patch) { state = { ...state, ...patch }; for (const listener of [...listeners]) listener() },
  }
}
function dateText(value) {
  if (typeof value !== 'string') return null
  const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}
function errorText(t, code) {
  const known = ['credential-missing','unauthorized','forbidden','rate-limited','http-error','timeout','network','invalid-response','unsupported-response','login-required','browser-unavailable','browser-timeout','parse-failed','remote-error']
  return t(`errors.${known.includes(code) ? code : 'generic'}`)
}
function valueText(window, t) {
  if (window.status === 'unlimited') return t('unlimited')
  return window.status === 'available' && window.usedPercent !== null ? `${window.usedPercent}%` : '—'
}
function partValueText(state, key, t) {
  const window = state.snapshot.windows[key]
  if (key !== 'monthly' || window.status !== 'unavailable') return valueText(window, t)
  if (state.monthlyPending) return '…'
  const code = state.transportError ?? state.snapshot.error?.code
  return code === 'login-required' || !state.monthlyAttempted ? t('login') : '—'
}
function makeTitle(state, t) {
  const lines = []
  for (const [key,label] of [['fiveHour',t('fiveHour')],['weekly',t('weekly')],['monthly',t('monthly')]]) {
    const window = state.snapshot.windows[key], reset = dateText(window.resetAt)
    lines.push(`${label}: ${partValueText(state,key,t)}${reset ? ` · ${t('reset')} ${reset}` : ''}`)
  }
  const updated = dateText(state.snapshot.fetchedAt); if (updated) lines.push(`${t('updated')}: ${updated}`)
  if (state.refreshing) lines.push(t('updating'))
  const code = state.transportError ?? state.snapshot.error?.code; if (code) lines.push(errorText(t,code))
  if (code === 'login-required') lines.push(t('loginHelp'))
  if (!state.refreshing) lines.push(t('refresh'))
  return lines.join('\n')
}
async function apply(ctx) {
  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const lifetime = new AbortController(); let disposed = false, ui
  try {
    ui = ctx.inject(['remote.kimiQuota','slots','locale','timer'], child => {
      child.effect(() => child.locale.register(NS,{en,zh}), 'kimi-quota: locale')
      const store = createStore(), t = child.locale.bind(NS)
      let current, currentMonthly = false, sequence = 0
      function refresh(force, includeMonthly = false) {
        if (disposed || lifetime.signal.aborted) return Promise.resolve()
        if (includeMonthly) store.set({monthlyAttempted:true,monthlyPending:true})
        if (current !== undefined) {
          if (!includeMonthly || currentMonthly) return current
          return current.then(() => refresh(force,true))
        }
        const observed = ++sequence
        store.set({refreshing:true,transportError:null,...(force ? {announcement:t('updating')} : {})})
        currentMonthly = includeMonthly
        current = (async () => {
          try {
            const result = await TYPERT_REMOTE.methods[ENDPOINT].invoke(child.remote,{request:{force,monthly:includeMonthly}},lifetime.signal)
            if (disposed || observed !== sequence) return
            if (result.ok) {
              const code = result.value.error?.code
              store.set({
                snapshot:result.value,refreshing:false,
                ...(includeMonthly ? {monthlyPending:false} : {}),
                ...(force ? {announcement:code ? `${t('refreshFailed')} ${errorText(t,code)}` : t('refreshSucceeded')} : {}),
              })
            } else {
              store.set({
                refreshing:false,transportError:'remote-error',
                ...(includeMonthly ? {monthlyPending:false} : {}),
                ...(force ? {announcement:`${t('refreshFailed')} ${errorText(t,'remote-error')}`} : {}),
              })
            }
          } catch {
            if (!disposed && observed === sequence) store.set({
              refreshing:false,transportError:'remote-error',
              ...(includeMonthly ? {monthlyPending:false} : {}),
              ...(force ? {announcement:`${t('refreshFailed')} ${errorText(t,'remote-error')}`} : {}),
            })
          } finally {
            if (observed === sequence) {
              current = undefined
              currentMonthly = false
            }
          }
        })()
        return current
      }
      function QuotaStatus() {
        const state = React.useSyncExternalStore(store.subscribe,store.getSnapshot)
        const subscribeLocale = listener => child.locale.subscribe(listener)
        const getLocaleSnapshot = () => child.locale.getSnapshot()
        React.useSyncExternalStore(subscribeLocale,getLocaleSnapshot)
        const parts = [['fiveHour',t('fiveHour')],['weekly',t('weekly')],['monthly',t('monthly')]]
        const summary = parts.map(([key,label]) => `${label} ${partValueText(state,key,t)}`).join(' · ')
        const code = state.transportError ?? state.snapshot.error?.code
        const children = [h('span',{key:'brand'},'Kimi')]
        for (const [key,label] of parts) {
          children.push(h('span',{key:`separator-${key}`,'aria-hidden':true},'·'))
          children.push(h('span',{key},`${label} ${partValueText(state,key,t)}`))
        }
        if (state.refreshing) children.push(h('span',{key:'busy','aria-hidden':true},'↻'))
        else if (code) children.push(h('span',{key:'error',className:'kimi-quota-status__error','aria-hidden':true},'!'))
        return h(React.Fragment,null,h('style',null,CSS),h('span',{
          className:'kimi-quota-status__sr-only',role:'status','aria-live':'polite','aria-atomic':true,
        },state.announcement),h('button',{
          type:'button',className:'kimi-quota-status','aria-disabled':state.refreshing,title:makeTitle(state,t),
          'aria-label':`${state.refreshing?t('updating'):t('refresh')}: ${summary}${code?`. ${errorText(t,code)}`:''}${code==='login-required'?`. ${t('loginHelp')}`:''}`,
          'aria-busy':state.refreshing,onClick:()=>{
            const includeMonthly = state.snapshot.windows.monthly.status !== 'available'
            void refresh(true,includeMonthly)
          },
        },...children))
      }
      child.effect(() => child.slots.inject('conversation.composer.dock',() => child.slots.register({
        name:'conversation.composer.dock',id:'kimi-quota',order:2,
      },QuotaStatus)), 'kimi-quota: dock')
      child.effect(() => child.timer.interval(()=>{void refresh(false)},60_000), 'kimi-quota: refresh timer')
      void refresh(false)
    })
    await ui
  } catch (error) {
    lifetime.abort(); if (ui !== undefined) await ui.dispose(); await unmountRemote(); throw error
  }
  return async () => { disposed=true; lifetime.abort(); await ui.dispose(); await unmountRemote() }
}
module.exports = { inject:['remote','slots','locale','timer'], apply }
