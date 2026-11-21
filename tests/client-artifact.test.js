import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const sourcePath = new URL('../client-main.cjs', import.meta.url)
const artifactPath = new URL('../client.js', import.meta.url)

test('Client source registers only the kimi-quota composer dock item at order 2', () => {
  const source = readFileSync(sourcePath, 'utf8')
  assert.match(source, /['"]conversation\.composer\.dock['"]/)
  assert.match(source, /\bid\s*:\s*['"]kimi-quota['"]/)
  assert.match(source, /\border\s*:\s*2\b/)
  assert.doesNotMatch(source, /\bid\s*:\s*['"](?:activity|usage)['"]/)
})

test('Client source uses accessible focus and reduced motion without hard-coded colors', () => {
  const source = readFileSync(sourcePath, 'utf8')
  assert.match(source, /:focus-visible/)
  assert.match(source, /prefers-reduced-motion/)
  assert.doesNotMatch(source, /#[\da-fA-F]{3,8}\b/)
})

test('used values, host tertiary styling and context-after order are explicit', () => {
  const source = readFileSync(sourcePath, 'utf8')
  assert.match(source, /usedPercent/)
  assert.match(source, /order:\s*100/)
  assert.match(source, /margin-inline-start:\s*0/)
  assert.match(source, /--dsw-alias-label-tertiary/)
  assert.match(source, /--dsw-alias-label-secondary/)
  assert.match(source, /font-variant-numeric:\s*tabular-nums/)
  assert.doesNotMatch(source, /--dsw-alias-label-primary/)
})

test('refresh preserves focus and exposes a polite atomic status region', () => {
  const source = readFileSync(sourcePath, 'utf8')
  assert.match(source, /\brole\s*:\s*['"]status['"]/)
  assert.match(source, /['"]aria-live['"]\s*:\s*['"]polite['"]/)
  assert.match(source, /['"]aria-atomic['"]\s*:\s*true/)
  assert.match(source, /['"]aria-disabled['"]\s*:\s*state\.refreshing/)
  assert.doesNotMatch(source, /\bdisabled\s*:\s*state\.refreshing/)
})

test('generated Client artifact has the package id and no Host secrets or endpoint', () => {
  const artifact = readFileSync(artifactPath, 'utf8')
  assert.match(artifact, /\bid\s*:\s*['"]@bwtymdb\/kimi-quota-status['"]/)
  for (const forbidden of ['api.kimi.com', 'Authorization', 'Bearer', 'credential.value']) {
    assert.equal(artifact.includes(forbidden), false, `Client artifact must not contain ${forbidden}`)
  }
  const keyLines = artifact.split(/\r?\n/).filter(line => line.includes('KIMI_API_KEY'))
  assert.ok(keyLines.length > 0)
  for (const line of keyLines) assert.match(line, /credential-missing|unauthorized/)
})

test('generated Client artifact matches a clean temporary build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kimi-quota-status-build-'))
  try {
    await Promise.all(['build.mjs', 'client-main.cjs', 'remote-contract.cjs'].map(name =>
      copyFile(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(directory, name))))
    await execFileAsync(process.execPath, ['build.mjs'], { cwd: directory })
    const [generated, current] = await Promise.all([
      readFile(join(directory, 'client.js'), 'utf8'),
      readFile(fileURLToPath(artifactPath), 'utf8'),
    ])
    assert.equal(current, generated)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
