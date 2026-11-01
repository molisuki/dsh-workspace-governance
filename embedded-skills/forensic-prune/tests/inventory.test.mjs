import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, test } from 'node:test'

const scanner = resolve(import.meta.dirname, '../scripts/inventory.mjs')
const temporaryRoots = []
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'forensic-prune-test-'))
  temporaryRoots.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const physical = join(root, relative)
    mkdirSync(resolve(physical, '..'), { recursive: true })
    writeFileSync(physical, content, 'utf8')
  }
  return root
}
function scan(root, extra = []) {
  const run = spawnSync(process.execPath, [scanner, '--root', root, '--format', 'json', ...extra], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 3_000_000
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, data: run.status === 0 ? JSON.parse(run.stdout) : null }
}
afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true })
})
test('01 structured read-only scan never changes file lists', () => {
  const root = fixture({ 'src/main.mjs': 'export const v = 1\n' })
  const before = readdirSync(join(root, 'src'))
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.equal(data.mode, 'read-only')
  assert.equal(data.schemaVersion, 1)
  assert.deepEqual(data.findings, [])
  assert.deepEqual(readdirSync(join(root, 'src')), before)
  assert.equal(data.decision.automatedDeletes, 0)
  assert.equal(data.decision.authorizedToDelete, false)
})
test('02 governance and credentials are protected, not deletion candidates', () => {
  const root = fixture({
    'AGENTS.md': '# policy',
    'README.md': '# readme',
    'PLAN.md': '# plan',
    '.env': 'SECRET=test-secret',
    'data/a.sqlite': 'database'
  })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  const protectedPaths = data.protections.map(v => v.path)
  for (const path of ['AGENTS.md', 'README.md', 'PLAN.md', '.env', 'data/a.sqlite'])
    assert.ok(protectedPaths.includes(path), 'missing: ' + path)
  assert.ok(!JSON.stringify(data).includes('test-secret'))
  assert.ok(data.findings.every(v => v.action !== 'delete'))
})
test('03 temporary names and generated directories are investigation leads', () => {
  const root = fixture({
    '.tmp-diagnostic': 'ephemeral',
    'logs/session.log': 'trace',
    'dist/build.exe': 'binary'
  })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.ok(data.findings.some(v => v.path === '.tmp-diagnostic' && v.kind === 'ephemeral-artifact'))
  assert.ok(data.findings.some(v => v.path === 'logs/session.log' && v.kind === 'ephemeral-artifact'))
  assert.ok(data.findings.some(v => v.path === 'dist' && v.kind === 'generated-tree'))
  assert.ok(data.findings.every(v => v.action === 'investigate'))
  assert.equal(data.coverage.complete, false)
})
test('04 comment candidate distinction excludes source string and data boundary', () => {
  const root = fixture({
    'src/a.mjs': [
      'const msg = "旧实现";',
      '// 旧实现已经替代',
      'const url = "https://example.invalid/旧实现"',
      '/* 上一版写法 */',
      '// v16 之前的落库行必须兼容旧 Schema',
      ''
    ].join('\n')
  })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  const candidates = data.findings.filter(v => v.kind === 'suspect-comment')
  assert.deepEqual(candidates.map(v => v.line), [2, 4])
  assert.ok(candidates.every(v => v.confidence === 'heuristic'))
})
test('05 scan limits are never reported as complete', () => {
  const root = fixture({ 'a.txt': 'x', 'b.txt': 'x', 'c.txt': 'x' })
  const { status, data } = scan(root, ['--max-files', '1'])
  assert.equal(status, 0)
  assert.equal(data.coverage.complete, false)
  assert.equal(data.coverage.limitReached, true)
  assert.ok(data.coverage.skipped.some(v => v.reason === 'max-files-exceeded'))
})
test('06 Git internals excluded without disclosure of contents', () => {
  const root = fixture({ '.git/objects/private-object': 'very-sensitive-test', 'src/a.js': 'export default 1' })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.ok(data.coverage.skipped.some(v => v.path === '.git' && v.reason === 'git-internals'))
  assert.ok(!JSON.stringify(data).includes('very-sensitive-test'))
})
test('07 symbolic link is not followed', t => {
  const external = fixture({ 'outside-secret.txt': 'sensitive-marker' })
  const root = fixture({ 'src/a.mjs': 'export default 1' })
  try { symlinkSync(external, join(root, 'linked'), 'dir') } catch (err) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) return t.skip('symlink permission unavailable')
    throw err
  }
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.ok(data.coverage.skipped.some(v => v.path === 'linked' && v.reason === 'symlink'))
  assert.ok(data.protections.some(v => v.path === 'linked'))
  assert.ok(!JSON.stringify(data).includes('outside-secret.txt'))
})
test('08 unsupported potentially destructive CLI options fail closed', () => {
  const root = fixture({ 'src/a.mjs': 'export default 1' })
  for (const opt of ['--delete', '--apply', '--force', '--delete-all']) {
    const { status } = scan(root, [opt])
    assert.notEqual(status, 0, opt)
  }
})
test('09 repeated scans have stable deterministic candidate ordering', () => {
  const root = fixture({
    'z.tmp': 'a',
    'a.tmp': 'a',
    'src/c.mjs': '// 旧实现',
    'src/b.mjs': '// 上一版'
  })
  const a = scan(root), b = scan(root)
  assert.equal(a.status, 0)
  assert.equal(b.status, 0)
  assert.deepEqual(a.data.findings, b.data.findings)
})
test('10 Python and SQL comments are classified as suggestions only', () => {
  const root = fixture({ 'src/a.py': '# 旧实现', 'db/a.sql': '-- 上一版' })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.deepEqual(
    data.findings.filter(v => v.kind === 'suspect-comment').map(v => v.path),
    ['db/a.sql', 'src/a.py']
  )
  assert.equal(data.decision.authorizedToDelete, false)
})
test('11 non-Git workspaces do not become clean Git workspaces', () => {
  const root = fixture({ 'notes/readme.txt': 'hi' })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.equal(data.git.observed, false)
  assert.equal(data.git.clean, undefined)
})
test('12 help does not mutate project or require code', () => {
  const root = fixture({ 'src/a.mjs': '// 旧实现' })
  const run = spawnSync(process.execPath, [scanner, '--help'], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0)
  assert.ok(run.stdout.includes('Read-only'))
  assert.deepEqual(readdirSync(join(root, 'src')), ['a.mjs'])
})

test('13 nested Git and dependency directories are excluded', () => {
  const root = fixture({
    'packages/a/.git/objects/private-object': 'SENSITIVE_GIT_PAYLOAD',
    'packages/a/node_modules/pkg/entry.js': '// 旧实现',
    'packages/a/src/active.js': 'export const active = true'
  })
  const { status, data, stdout } = scan(root)
  assert.equal(status, 0)
  assert.ok(data.coverage.skipped.some(x => x.path === 'packages/a/.git' && x.reason === 'git-internals'))
  assert.ok(data.coverage.skipped.some(x => x.path === 'packages/a/node_modules' && x.reason === 'third-party-dependencies'))
  assert.ok(!stdout.includes('SENSITIVE_GIT_PAYLOAD'))
  assert.ok(!data.findings.some(x => x.path.includes('node_modules/')))
})
test('24 mixed-case runtime and audit directories remain protected', () => {
  const root = fixture({
    'pkg/RuNtImE/session.js': '// 上一版 contains-private-marker',
    'pkg/.DSH-OPS/receipt.js': '// 旧实现 contains-another-private-marker',
    'pkg/src/app.js': 'export default 1'
  })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  for (const path of ['pkg/RuNtImE', 'pkg/.DSH-OPS']) {
    assert.ok(data.protections.some(x => x.path === path), path)
    assert.ok(data.coverage.skipped.some(x => x.path === path), path)
  }
  assert.ok(!data.findings.some(x => x.path.includes('session.js') || x.path.includes('receipt.js')))
})

test('25 mixed-case governance documents remain protected', () => {
  const root = fixture({
    'pkg/agents.MD': '# policy',
    'pkg/vision.md': '# protected intent',
    'pkg/Readme.Md': '# current docs'
  })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  for (const path of ['pkg/agents.MD', 'pkg/vision.md', 'pkg/Readme.Md'])
    assert.ok(data.protections.some(x => x.path === path), path)
})

test('14 nested policy documents are protected', () => {
  const root = fixture({
    'packages/a/AGENTS.md': '# Current policy',
    'packages/a/PLAN.md': '# Current plan',
    'packages/a/README.md': '# Current docs',
    'packages/a/src/main.js': 'export {}'
  })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  for (const path of ['packages/a/AGENTS.md', 'packages/a/PLAN.md', 'packages/a/README.md'])
    assert.ok(data.protections.some(x => x.path === path), path)
})
test('15 nested generated trees are candidates, not delete authorizations', () => {
  const root = fixture({ 'packages/a/dist/build.js': '// 旧实现', 'packages/a/src/main.js': 'export {}' })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.ok(data.findings.some(x => x.path === 'packages/a/dist' && x.kind === 'generated-tree'))
  assert.ok(!data.findings.some(x => x.path === 'packages/a/dist/build.js'))
  assert.equal(data.coverage.complete, false)
  assert.equal(data.decision.authorizedToDelete, false)
})
test('16 hard-linked files are protected instead of treated as disposable', t => {
  const root = fixture({ 'data/original.tmp': 'protected-shared-inode' })
  const target = join(root, 'data', 'mirror.tmp')
  try { linkSync(join(root, 'data', 'original.tmp'), target) } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('hardlinks unavailable')
    throw error
  }
  const { status, data } = scan(root)
  assert.equal(status, 0)
  for (const path of ['data/original.tmp', 'data/mirror.tmp'])
    assert.ok(data.protections.some(x => x.path === path && x.reason === 'shared-hardlink-unverified'))
  assert.ok(!data.findings.some(x => x.path.endsWith('.tmp')))
})
test('17 SQLite3 and transaction sidecars are protected', () => {
  const root = fixture({
    'data/a.sqlite3': 'database',
    'data/a.sqlite3-wal': 'transaction-data',
    'data/a.sqlite3-shm': 'transaction-shared-memory'
  })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.equal(data.protections.length, 3)
  assert.equal(data.findings.length, 0)
})
test('18 large source files disclose coverage gaps', () => {
  const root = fixture({ 'src/huge.js': '// 旧实现\\n' + 'a'.repeat(1_100_000) })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.equal(data.coverage.complete, false)
  assert.ok(data.coverage.skipped.some(x => x.path === 'src/huge.js' && x.reason === 'large-source-uninspected'))
})
test('19 malformed options and nonexistent roots fail closed', () => {
  const root = fixture({ 'src/main.js': 'export {}' })
  for (const args of [
    ['--max-files', '0'], ['--max-files', '-1'], ['--format', 'xml'],
    ['--root'], ['--unknown']
  ]) {
    assert.notEqual(scan(root, args).status, 0)
  }
  assert.notEqual(scan(join(root, 'not-a-root')).status, 0)
})
test('21 nested runtime and audit folders are protected and uninspected', () => {
  const root = fixture({
    'packages/a/runtime/session.log': 'runtime-secret-content',
    'packages/a/.dsh-ops/receipt.json': 'audit-secret-content',
    'packages/a/src/main.js': 'export {}'
  })
  const { status, data, stdout } = scan(root)
  assert.equal(status, 0)
  for (const path of ['packages/a/runtime', 'packages/a/.dsh-ops']) {
    assert.ok(data.protections.some(x => x.path === path), path)
    assert.ok(data.coverage.skipped.some(x => x.path === path), path)
  }
  assert.ok(!stdout.includes('runtime-secret-content'))
  assert.ok(!stdout.includes('audit-secret-content'))
  assert.equal(data.coverage.complete, false)
})

test('22 SQLite journal and rollback files are data, never disposable candidates', () => {
  const root = fixture({
    'data/state.db-journal': 'transaction',
    'data/state.sqlite3-journal': 'transaction',
    'data/state.db-wal': 'transaction'
  })
  const { status, data } = scan(root)
  assert.equal(status, 0)
  for (const name of ['data/state.db-journal', 'data/state.sqlite3-journal', 'data/state.db-wal'])
    assert.ok(data.protections.some(x => x.path === name), name)
  assert.deepEqual(data.findings, [])
})

test('23 invalid UTF-8 source must disclose incomplete coverage', () => {
  const root = fixture({ 'src/broken.js': '' })
  writeFileSync(join(root, 'src/broken.js'), Buffer.from([0xff, 0xfe, 0x80]))
  const { status, data } = scan(root)
  assert.equal(status, 0)
  assert.equal(data.coverage.complete, false)
  assert.ok(data.coverage.errors.some(x => x.path === 'src/broken.js' && x.code === 'invalid-utf8'))
  assert.deepEqual(data.findings, [])
})
