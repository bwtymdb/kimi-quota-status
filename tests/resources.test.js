import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

test('English and Chinese metadata document used quota and monthly browser safeguards', () => {
  for (const [locale, title] of [['en', 'Kimi membership quota'], ['zh', 'Kimi 会员余量']]) {
    const resource = JSON.parse(read(`locale/${locale}.json`))
    const description = resource.meta.description
    assert.equal(resource.meta.title, title)
    assert.equal(typeof description, 'string')
    assert.ok(description.length > 0)
    assert.equal(Object.hasOwn(resource.meta, 'detail'), false)
    assert.match(description, locale === 'en' ? /\bused\b/i : /已用量/)
    assert.doesNotMatch(description, locale === 'en' ? /\bremaining\b/i : /剩余量/)
    assert.match(description, locale === 'en'
      ? /Monthly API data always takes priority and needs no browser login/i
      : /API 提供的月度数据始终优先，且无需浏览器登录/)
    assert.match(description, locale === 'en'
      ? /Only when the API omits monthly usage does the browser supplement run/i
      : /仅当 API 未提供月度数据时才通过浏览器补数/)
    for (const pattern of [
      /KIMI_API_KEY/, /Chrome/, /web-access Proxy/, /Kimi subscription page|Kimi 订阅页/,
      /60[- ]seconds?|60 秒/, /10 minutes|10 分钟/, /manually|手动/, /click|点击/,
      /cookies?|Cookie/i, /page tokens|页面令牌/, /full page text|完整正文/,
      /automation|自动化/, /risk|风险/, /Disabling|禁用/,
    ]) assert.match(description, pattern, `${locale} description must match ${pattern}`)
  }
})

test('README documents setup, used quota, browser timing, privacy, risks, and scope limits', () => {
  const readme = read('README.md')
  assert.match(readme, /KIMI_API_KEY/)
  assert.match(readme, /60 seconds/)
  assert.match(readme, /No limit/)
  assert.match(readme, /不限/)
  assert.match(readme, /All percentages are \*\*used\*\*/)
  assert.match(readme, /\*\*40%\*\* means 40% of the applicable quota has been consumed/)
  assert.doesNotMatch(readme, /remaining/i)
  assert.match(readme, /API-provided monthly usage always takes priority and requires no browser login/i)
  assert.match(readme, /Only when the API does not provide monthly usage does the browser supplement require/i)
  for (const pattern of [
    /original API channel/, /web-access Proxy/, /selected Chrome/, /first monthly login/i,
    /background tab/, /login-required/, /log in manually in Chrome/i, /10 minutes/,
    /only operates its own tab/i, /does not save cookies, page tokens, or full page text/i,
    /never enters an account name or password/i, /automation detection/i, /account risk/i,
    /does not automatically open a browser/i, /approved 10-minute schedule/,
    /Disabling it removes only this dock item, stops its automatic reads, and disposes/,
  ]) assert.match(readme, pattern, `README must match ${pattern}`)
  for (const limitation of ['Open Platform', 'multiple accounts', 'Extra Usage', 'history', 'alerts']) {
    assert.match(readme, new RegExp(limitation, 'i'))
  }
})

test('icon is a small safe 36 by 36 SVG', () => {
  const svg = read('icon.svg')
  assert.match(svg, /<svg\b[^>]*\bwidth="36"[^>]*\bheight="36"[^>]*\bviewBox="0 0 36 36"/)
  assert.doesNotMatch(svg, /<(?:script|style|image|text|foreignObject)\b|\bonload\s*=/i)
  assert.ok(Buffer.byteLength(svg) < 256 * 1024)
})

test('manifest exports and files are complete and have no install hooks', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.doesNotMatch(manifest.description, /remaining/i)
  assert.match(manifest.description, /\bused\b/i)
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  const requiredFiles = [
    'index.js', 'quota.js', 'fetcher.js', 'monthly-page.js', 'browser-monthly.js',
    'remote-contract.cjs', 'client-main.cjs', 'build.mjs', 'client.js',
    'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md',
  ]
  for (const file of requiredFiles) assert.ok(manifest.files.includes(file), `files must include ${file}`)
  for (const file of requiredFiles.filter(file => !file.includes('*'))) {
    assert.ok(existsSync(new URL(file, root)), `${file} must exist`)
  }
  for (const locale of ['en.json', 'zh.json']) assert.ok(existsSync(new URL(`locale/${locale}`, root)))
  assert.equal(Object.hasOwn(manifest.scripts, 'install'), false)
  assert.equal(Object.hasOwn(manifest.scripts, 'postinstall'), false)
})

test('publication metadata includes package ownership, compatibility, repository and MIT license', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.name, '@bwtymdb/kimi-quota-status')
  assert.equal(manifest.private, false)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.5 <0.3.0-0')
  assert.equal(manifest.repository.type, 'git')
  assert.equal(manifest.repository.url, 'git+https://github.com/bwtymdb/kimi-quota-status.git')
  assert.equal(manifest.homepage, 'https://github.com/bwtymdb/kimi-quota-status#readme')
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'], '0.2.2-rc.5')
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-typert-protocol'].optional, true)
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-typert-protocol'], '0.2.2-rc.5')
  assert.ok(manifest.files.includes('LICENSE'))
  assert.match(read('LICENSE'), /MIT License/)
  assert.match(read('cordis.patch.yml'), /@bwtymdb\/kimi-quota-status/)
})
