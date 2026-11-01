import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

// Normative hierarchy and metadata contract tests; scanner behavior is isolated in inventory.test.mjs.

test('20 governance metadata, canonical vocabulary and normalized normative levels', () => {
  const directory = resolve(import.meta.dirname, '..')
  const skill = readFileSync(join(directory, 'SKILL.md'), 'utf8')
  const metadata = readFileSync(join(directory, 'agents', 'openai.yaml'), 'utf8')
  const references = ['governance-map.md', 'decision-spec.md', 'ecosystems.md']
    .map(name => readFileSync(join(directory, 'references', name), 'utf8'))
  assert.match(metadata, /display_name: "工程资产退役与规范治理"/)
  assert.match(skill, /^---\nname: forensic-prune\n/m)
  assert.match(skill, /version: "2\.1\.0"/)
  for (const category of ['CANDIDATE', 'PROTECTED', 'UNRESOLVED'])
    assert.match(skill, new RegExp('^\\| 发现 \\| `' + category + '` \\|', 'm'))
  for (const disposition of ['DELETE', 'MERGE', 'REWRITE', 'PRESERVE', 'HOLD'])
    assert.match(skill, new RegExp('^\\| 裁决 \\| `' + disposition + '` \\|', 'm'))
  for (const outcome of ['PASS', 'FAIL', 'NA', 'UNKNOWN'])
    assert.match(skill, new RegExp('^\\| 验收 \\| `' + outcome + '` \\|', 'm'))
  for (const code of ['V01_SCOPE', 'V02_SNAPSHOT', 'V03_PROTECTED', 'V04_REFERENCE',
    'V05_SEMANTICS', 'V06_RUNTIME', 'V07_DATA', 'V08_RECOVERY', 'V09_COVERAGE',
    'V10_CONFLICT', 'V11_VALIDATION', 'V12_AUDIT'])
    assert.ok(skill.includes('`' + code + '`'), code)
  for (const document of [skill, ...references]) {
    assert.ok(!/HOLD_(?:EVIDENCE|RUNTIME|RECOVERY|CONFLICT|OWNER)/.test(document))
    assert.ok(!/NOT_OBSERVED|NOT_APPLICABLE|HOLD_PROTECTED/.test(document))
    assert.ok(!/Game Library[\\/]/i.test(document))
  }
})

test('26 L0 constitution preserves high-risk inclusion, real disposition and evidence integrity', () => {
  const skill = readFileSync(resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')
  assert.match(skill, /^## 0\. 最高治理章程$/m)
  for (let n = 1; n <= 8; n++)
    assert.match(skill, new RegExp('^\\| `P' + String(n).padStart(2, '0') + '` ', 'm'))
  for (const required of [
    '`P02` 实体处置', '`P03` 残留闭合', '`P05` 风险适配',
    '`R4`', '`MERGE`', '`PHYSICAL_PROOF`', '`RESIDUAL_SCAN`',
    '权限', '恢复', '并行', '审计'
  ]) assert.ok(skill.includes(required), required)
  assert.match(skill, /风险级别.*不扩张处置权限/)
  assert.match(skill, /实体退役.*授权工作树.*可核查/)
  assert.match(skill, /移动到其他目录、遗留/)
  assert.match(skill, /缺失写入工具.*不能/)
})

test('27 hierarchy and state machine preserve a unique normative owner', () => {
  const root = resolve(import.meta.dirname, '..')
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
  const headings = [...skill.matchAll(/^## (\d+)\. (.+)$/gm)].map(m => Number(m[1]))
  assert.deepEqual(headings, Array.from({ length: 9 }, (_, i) => i))
  for (let i = 0; i <= 6; i++)
    assert.equal((skill.match(new RegExp('^\\| `L' + i + '` ', 'gm')) ?? []).length, 1, 'hierarchy L' + i)
  for (let i = 0; i <= 7; i++)
    assert.equal((skill.match(new RegExp('^\\| `G' + i + '` ', 'gm')) ?? []).length, 1, 'gate G' + i)
  for (let i = 0; i <= 10; i++)
    assert.equal((skill.match(new RegExp('^\\| `S' + String(i).padStart(2, '0') + '` ', 'gm')) ?? []).length, 1, 'state S' + i)
  for (let i = 0; i <= 4; i++)
    assert.equal((skill.match(new RegExp('^\\| `R' + i + '` ', 'gm')) ?? []).length, 1, 'risk R' + i)
  for (const file of ['governance-map.md', 'decision-spec.md', 'ecosystems.md'])
    assert.ok(skill.includes('references/' + file), file + ' must be explicitly routed')
  for (const formula of ['PERMIT_CHANGE', 'PERMIT_DELETE', 'PERMIT_MERGE', 'PERMIT_REWRITE', 'PERMIT_COMPLETE'])
    assert.ok(skill.includes(formula), formula)
})


test('29 industrial ontology and authority ownership remain auditable', () => {
  const root = resolve(import.meta.dirname, '..')
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
  const taxonomy = readFileSync(join(root, 'references', 'governance-map.md'), 'utf8')
  const evidence = readFileSync(join(root, 'references', 'decision-spec.md'), 'utf8')
  const ecosystem = readFileSync(join(root, 'references', 'ecosystems.md'), 'utf8')
  for (const name of ['执行实体', '声明实体', '数据实体', '运行实体', '治理实体', '外部实体'])
    assert.ok(skill.includes(name), name)
  for (const term of ['同源聚合', '风险闭包', '权威收敛', '反向证明'])
    assert.ok(taxonomy.includes(term), term)
  for (const term of ['证据图', '信任分区', '事务、幂等', '恢复源的独立性'])
    assert.ok(evidence.includes(term), term)
  for (const term of ['文件系统与跨平台同一性', '数据存储、事务', '发现器能力与盲区'])
    assert.ok(ecosystem.includes(term), term)
})

test('30 admissibility is distinct from side effects and tested behavior', () => {
  const root = resolve(import.meta.dirname, '..')
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
  const evidence = readFileSync(join(root, 'references', 'decision-spec.md'), 'utf8')
  for (const term of ['PERMIT_CHANGE', 'PERMIT_DELETE', 'PERMIT_MERGE', 'PERMIT_REWRITE',
    'PERMIT_COMPLETE', 'DISCOVERY', 'DECISION', 'OPERATION', 'VERIFICATION', 'INTEGRATION'])
    assert.ok(skill.includes(term), term)
  for (const term of ['部分成功', '幂等', '动态消费', '快照', '物理删除回执', '未运行'])
    assert.ok(evidence.includes(term), term)
  assert.match(skill, /只读启发式发现器/)
  assert.match(skill, /不能因文档完整而宣称对应自动执行能力已经存在/)
})

test('31 failure-driven forensic acceptance definitions are unique', () => {
  const root = resolve(import.meta.dirname, '..')
  const content = readFileSync(join(root, 'references', 'decision-spec.md'), 'utf8')
  const cases = [...content.matchAll(/^\| (T\d{2}) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
  assert.equal(cases.length, 16)
  for (let i = 1; i <= 16; i++) assert.equal(cases[i-1][1], 'T' + String(i).padStart(2, '0'))
  for (const row of cases) {
    assert.ok(row[2].trim().length > 8)
    assert.ok(row[3].trim().length > 8)
    assert.ok(row[4].trim().length > 8)
  }
  assert.match(content, /没有模拟工具调用、实际输出与回执时只能记为未运行/)
})

test('32 documentation density and bounded proof avoid conversational directives', () => {
  const root = resolve(import.meta.dirname, '..')
  const documents = ['SKILL.md', 'references/governance-map.md',
    'references/decision-spec.md', 'references/ecosystems.md']
  let chars = 0
  for (const path of documents) {
    const content = readFileSync(join(root, path), 'utf8')
    chars += content.length
    assert.ok(content.endsWith('\n'), path)
    for (const phrase of ['快点', '帮我', '一刀切', '废话', '垃圾', '随便', '未清理干净'])
      assert.ok(!content.includes(phrase), path + ': ' + phrase)
    for (const phrase of ['UNKNOWN', 'HOLD', 'PASS'])
      assert.ok(content.includes(phrase), path + ': ' + phrase)
  }
  assert.ok(chars >= 30000, 'industrial documentation minimum content budget')
})

test('28 reference taxonomy, evidence and delivery remain compatible', () => {
  const root = resolve(import.meta.dirname, '..')
  const classification = readFileSync(join(root, 'references', 'governance-map.md'), 'utf8')
  const decisions = readFileSync(join(root, 'references', 'decision-spec.md'), 'utf8')
  const ecosystems = readFileSync(join(root, 'references', 'ecosystems.md'), 'utf8')
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
  for (let i = 1; i <= 38; i++)
    assert.equal((classification.match(new RegExp('^\\| C' + String(i).padStart(2, '0') + ' \\|', 'gm')) ?? []).length, 1, 'C' + i)
  for (let i = 1; i <= 44; i++)
    assert.equal((decisions.match(new RegExp('^\\| E' + String(i).padStart(2, '0') + ' \\|', 'gm')) ?? []).length, 1, 'E' + i)
  for (let i = 1; i <= 12; i++)
    assert.equal((decisions.match(new RegExp('^\\| A' + String(i).padStart(2, '0') + ' \\|', 'gm')) ?? []).length, 1, 'A' + i)
  assert.match(decisions, /## 5\. 对象变更与恢复记录/)
  assert.match(decisions, /## 6\. 语义与文档治理协议/)
  assert.match(ecosystems, /## 5\. 技术适配器输入与输出/)
  assert.ok(skill.includes('状态、操作符') && skill.includes('唯一职责'))
  for (const term of ['PHYSICAL_PROOF', 'RESIDUAL_SCAN', 'PRESERVATION', 'VERDICT'])
    assert.ok(skill.includes('`' + term + '`'))
})
