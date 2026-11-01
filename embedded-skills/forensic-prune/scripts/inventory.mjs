#!/usr/bin/env node
/**
 * Universal forensic-prune read-only inventory.
 * All findings are investigation leads. No file deletion, mutation, or repair.
 * Repository rules and actual authorization must be evaluated independently.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

const VERSION = 1
const MAX_SOURCE_BYTES = 1_048_576
const GENERATED_ROOTS = new Set(['dist', 'out', 'release', 'coverage', 'test-results', 'playwright-report', '.cache'])
const NEVER_TRAVERSE = new Map([
  ['.git', 'git-internals'],
  ['node_modules', 'third-party-dependencies'],
  ['.dsh-ops', 'audit-and-operations-evidence'],
  ['runtime', 'runtime-state-and-locks']
])
const AUTHORITY_PATHS = new Set([
  'AGENTS.md', 'AGENT.md', 'README.md', 'VISION.md', 'goals/PLAN.md',
  '.gitignore', '.gitattributes', 'package-lock.json',
  'CLAUDE.md', 'GEMINI.md', 'CONTRIBUTING.md', 'PLAN.md'
].map(name => name.toLowerCase()))
const SENSITIVE_EXT = /\.(?:sqlite(?:3)?(?:-wal|-shm|-journal)?|db(?:-wal|-shm|-journal)?|pem|p12|pfx|key)$/i
const SENSITIVE_NAMES = /^(?:\.env(?:\..+)?|id_rsa|id_ed25519|credentials(?:\..+)?|secrets(?:\..+)?)$/i
const TEMP_NAMES = /^(?:\.tmp(?:[-_.].*)?|.*\.(?:tmp|temp|log|bak|orig|swp|swo|pyc)|.*~)$/i
const LOCK_NAMES = /(?:^|[._-])(?:lock|pid)(?:$|[._-])/i
const SOURCE_EXT = /\.(?:mjs|cjs|js|jsx|ts|tsx|py|rs|go|java|kt|cs|c|cc|cpp|h|hpp|sh|ps1|sql|rb|swift|lua)$/i
const COMMENT_MARKERS = ['上一版', '前一版', '改造前', '修改前', '变更前', '重写前', '重构前', '原来写的是', '后来改', '旧实现', '老实现']
const DATA_BOUNDARY = /v\d+\s*(?:之前|以前)|schema\s*\d+\s*(?:之前|以前)|旧库|老库|迁移前|升级(?:前|之前)/i
const PRESENT_CONSTRAINT = /必须|否则|才|即|应|不得|只|仅|禁止|要求|后果|会把|会让|就会|务必/
const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0)

function usage() {
  return 'Usage: node inventory.mjs [--root PATH] [--format json|text] [--max-files POSITIVE_INTEGER]\nRead-only; no delete, fix, apply, force or write mode.'
}
function parseArgs(argv) {
  const opts = { root: '.', format: 'json', maxFiles: 100000 }
  for (let i = 0; i < argv.length; ++i) {
    const flag = argv[i]
    if (flag === '--help') return { help: true }
    if (!['--root', '--format', '--max-files'].includes(flag)) throw Error('Unsupported option: ' + flag)
    if (++i >= argv.length) throw Error('Missing value for ' + flag)
    const value = argv[i]
    if (flag === '--root') opts.root = value
    if (flag === '--format') {
      if (!['json', 'text'].includes(value)) throw Error('Expected json or text')
      opts.format = value
    }
    if (flag === '--max-files') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw Error('Expected positive safe integer')
      opts.maxFiles = Number(value)
    }
  }
  return opts
}
function gitObservation(root) {
  try {
    const git = args => execFileSync('git', args, {
      cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    const gitRoot = realpathSync(git(['rev-parse', '--show-toplevel']))
    if ((process.platform === 'win32' ? gitRoot.toLowerCase() : gitRoot) !==
        (process.platform === 'win32' ? realpathSync(root).toLowerCase() : realpathSync(root)))
      return { observed: false, reason: 'root-is-not-git-top-level' }
    const commit = git(['rev-parse', 'HEAD'])
    let branch = '(detached)'
    try { branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']) || '(detached)' } catch {}
    const porcelain = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
      cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'ignore']
    })
    const records = porcelain.split('\0').filter(Boolean)
    return { observed: true, commit, branch, clean: records.length === 0, statusRecordCount: records.length }
  } catch (error) {
    return { observed: false, reason: error.code === 'ENOENT' ? 'git-unavailable' : 'git-observation-failed' }
  }
}
function inventory(root, maxFiles) {
  const absolute = resolve(root)
  const rootStat = lstatSync(absolute)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('Root must be a real directory')
  const report = {
    schemaVersion: VERSION, mode: 'read-only', scope: { root: absolute, maxFiles },
    git: gitObservation(absolute),
    coverage: { complete: true, filesObserved: 0, directoriesObserved: 0, limitReached: false, skipped: [], errors: [] },
    protections: [], findings: [],
    decision: { automatedDeletes: 0, authorizedToDelete: false, status: 'evidence-required' }
  }
  const addFinding = (path, kind, rule, extras = {}) =>
    report.findings.push({ path, kind, rule, action: 'investigate', ...extras })
  const skip = (path, reason, affectsCoverage = true) => {
    report.coverage.skipped.push({ path, reason })
    if (affectsCoverage) report.coverage.complete = false
  }
  const protect = (path, reason) => report.protections.push({ path, reason, action: 'preserve' })
  function scanComments(path, physical, size) {
    if (size > MAX_SOURCE_BYTES) { skip(path, 'large-source-uninspected'); return }
    let source
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(physical)) }
    catch (error) {
      report.coverage.errors.push({
        path, operation: 'read',
        code: error instanceof TypeError ? 'invalid-utf8' : (error.code || 'unknown')
      })
      report.coverage.complete = false
      return
    }
    source.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trimStart()
      if (!/^(?:\/\/|\/\*|\*|\*\/|#|--)/.test(trimmed)) return
      if (DATA_BOUNDARY.test(trimmed) || PRESENT_CONSTRAINT.test(trimmed)) return
      const marker = COMMENT_MARKERS.find(value => trimmed.includes(value))
      if (marker) addFinding(path, 'suspect-comment', 'heuristic:historical-comment', {
        line: index + 1, marker, confidence: 'heuristic'
      })
    })
  }
  function visit(dir, relativeDir) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }
    catch (error) {
      report.coverage.errors.push({ path: relativeDir || '.', operation: 'readdir', code: error.code || 'unknown' })
      report.coverage.complete = false
      return
    }
    for (const entry of entries) {
      const logical = relativeDir ? relativeDir + '/' + entry.name : entry.name
      const normalizedName = entry.name.toLowerCase()
      const physical = join(dir, entry.name)
      if (report.coverage.limitReached) { skip(logical, 'max-files-exceeded'); continue }
      let stat
      try { stat = lstatSync(physical) }
      catch (error) {
        report.coverage.errors.push({ path: logical, operation: 'lstat', code: error.code || 'unknown' })
        report.coverage.complete = false
        continue
      }
      if (stat.isSymbolicLink()) { skip(logical, 'symlink'); protect(logical, 'link-target-unverified'); continue }
      if (stat.isDirectory()) {
        report.coverage.directoriesObserved++
        if (NEVER_TRAVERSE.has(normalizedName)) {
          const reason = NEVER_TRAVERSE.get(normalizedName)
          skip(logical, reason, reason !== 'git-internals' && reason !== 'third-party-dependencies')
          if (reason === 'runtime-state-and-locks' || reason === 'audit-and-operations-evidence') protect(logical, reason)
          continue
        }
        if (GENERATED_ROOTS.has(normalizedName) || /^release-\S+$/i.test(entry.name)) {
          addFinding(logical, 'generated-tree', 'heuristic:generated-content', { confidence: 'class-only' })
          skip(logical, 'generated-tree-content-uninspected')
          continue
        }
        visit(physical, logical)
        continue
      }
      if (!stat.isFile()) { skip(logical, 'non-regular-file'); continue }
      if (report.coverage.filesObserved >= maxFiles) {
        report.coverage.limitReached = true
        report.coverage.complete = false
        skip(logical, 'max-files-exceeded')
        return
      }
      report.coverage.filesObserved++
      if (stat.nlink > 1) { protect(logical, 'shared-hardlink-unverified'); continue }
      if (AUTHORITY_PATHS.has(logical.toLowerCase()) || AUTHORITY_PATHS.has(normalizedName)) {
        protect(logical, 'governance-or-contract'); continue
      }
      if (SENSITIVE_NAMES.test(entry.name) || SENSITIVE_EXT.test(entry.name)) {
        protect(logical, 'sensitive-data-or-credential')
        continue
      }
      if (LOCK_NAMES.test(entry.name) && entry.name !== 'package-lock.json') {
        protect(logical, 'lock-or-process-state')
        continue
      }
      if (TEMP_NAMES.test(entry.name)) {
        addFinding(logical, 'ephemeral-artifact', 'heuristic:temporary-name', {
          sizeBytes: stat.size, confidence: 'name-only'
        })
      }
      if (SOURCE_EXT.test(entry.name)) scanComments(logical, physical, stat.size)
    }
  }
  visit(absolute, '')
  for (const key of ['protections', 'findings']) report[key].sort(compare)
  report.coverage.skipped.sort(compare)
  report.coverage.errors.sort(compare)
  return report
}
function textReport(data) {
  const lines = [
    'Universal forensic-prune inventory (read-only)',
    'root: ' + data.scope.root,
    'scanned-files: ' + data.coverage.filesObserved,
    'complete: ' + data.coverage.complete,
    'skipped: ' + data.coverage.skipped.length,
    'errors: ' + data.coverage.errors.length,
    'findings: ' + data.findings.length,
    'protected: ' + data.protections.length,
    'git: ' + (data.git.observed ? data.git.commit : data.git.reason),
    'automated-deletes: 0'
  ]
  for (const f of data.findings) lines.push('REVIEW ' + f.kind + ' ' + f.path + (f.line ? ':' + f.line : ''))
  for (const s of data.coverage.skipped) lines.push('SKIPPED ' + s.path + ' ' + s.reason)
  for (const e of data.coverage.errors) lines.push('ERROR ' + e.path + ' ' + e.operation + ' ' + e.code)
  return lines.join('\n')
}
try {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) process.stdout.write(usage() + '\n')
  else {
    const result = inventory(opts.root, opts.maxFiles)
    process.stdout.write(opts.format === 'json' ? JSON.stringify(result, null, 2) + '\n' : textReport(result) + '\n')
  }
} catch (error) {
  process.stderr.write('inventory failed closed: ' + error.message + '\n')
  process.exitCode = 2
}
