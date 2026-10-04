/* 招标文件公平竞争审查（FAIR.*）冒烟测试
 * 对照 AIBidForge3.1 tests/test_tender_detect.py 的断言口径。
 * 覆盖：9 条规则加载、5 类 HARD 命中、CLEAN 零误报、命中可溯源、
 *       文档路径（docx 抽取正文）同样命中、requires_human_review 闸门。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')
const { detectText, detectDocx, loadRules } = require('../.smoke-out/fairness.js')

// 含排斥限制竞争情形的招标文件片段
const BIASED = `
第一章 招标公告
1. 本项目消防设备必须采用"某品牌"产品，不接受其他品牌。
2. 投标人须提供近三年在本省承接的类似项目业绩不少于 3 项。
3. 中标人须在本地设立分公司，并在当地缴纳税费。
4. 本项目仅限国有企业参与投标，民营企业不得参加。
5. 投标人须具备建筑工程施工总承包特级资质。
6. 外地企业不得参与本项目投标。
`

// 正常、客观的招标文件片段（不应命中排斥情形）
const CLEAN = `
第一章 招标公告
1. 本项目工期要求 180 日历天。
2. 本项目最高投标限价为人民币 3000 万元。
3. 投标人须具备市政公用工程施工总承包二级及以上资质。
4. 投标人须提供近三年类似道路工程业绩不少于 2 项。
5. 投标文件未按招标文件要求签字盖章的，其投标应当被否决。
`

function ruleIds(hits) {
  return new Set(hits.map((h) => h.rule_id))
}

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

// ---- 1. 规则加载 ----
function testRulesLoaded() {
  const rules = loadRules()
  assert.strictEqual(rules.length, 9, `应加载 9 条 FAIR 规则，实际 ${rules.length}`)
  const ids = rules.map((r) => r.id)
  for (const expect of ['FAIR.SPECIFY_BRAND', 'FAIR.REGION_PERFORMANCE', 'FAIR.LOCAL_BRANCH', 'FAIR.OWNERSHIP_RESTRICT', 'FAIR.SPECIFIC_AWARD', 'FAIR.QUALIFICATION_MISMATCH', 'FAIR.DISCRIMINATE_OUTSIDER', 'FAIR.SENSITIVE_WORD', 'FAIR.RESTRICT_TRADE_TOOL']) {
    assert.ok(ids.includes(expect), `缺少规则 ${expect}`)
  }
  ok('加载 9 条 FAIR.* 规则')
}

// ---- 2. 5 类 HARD 命中 ----
function testHardHits() {
  const r = detectText(BIASED)
  const ids = ruleIds(r.hits)
  assert.ok(ids.has('FAIR.SPECIFY_BRAND'), '应命中 FAIR.SPECIFY_BRAND')
  assert.ok(ids.has('FAIR.REGION_PERFORMANCE'), '应命中 FAIR.REGION_PERFORMANCE')
  assert.ok(ids.has('FAIR.LOCAL_BRANCH'), '应命中 FAIR.LOCAL_BRANCH')
  assert.ok(ids.has('FAIR.OWNERSHIP_RESTRICT'), '应命中 FAIR.OWNERSHIP_RESTRICT')
  assert.ok(ids.has('FAIR.DISCRIMINATE_OUTSIDER'), '应命中 FAIR.DISCRIMINATE_OUTSIDER')
  ok('BIASED 文本命中 5 类 HARD 规则')
}

// ---- 3. hard_count >= 5 ----
function testHardCount() {
  const r = detectText(BIASED)
  assert.ok(r.summary.hard_count >= 5, `HARD 命中应 >=5，实际 ${r.summary.hard_count}`)
  ok(`BIASED hard_count=${r.summary.hard_count} >= 5`)
}

// ---- 4. CLEAN 零误报 ----
function testCleanNoFalsePositive() {
  const r = detectText(CLEAN)
  assert.strictEqual(r.summary.total_hits, 0, `CLEAN 不应命中，实际 ${r.summary.total_hits}`)
  ok('CLEAN 文本零误报（total_hits=0）')
}

// ---- 5. 命中可溯源 ----
function testTraceability() {
  const r = detectText(BIASED)
  assert.ok(r.hits.length > 0)
  for (const h of r.hits) {
    assert.ok(h.basis && h.basis.length > 0, `${h.rule_id} 缺少法律依据`)
    assert.ok(h.suggestion && h.suggestion.length > 0, `${h.rule_id} 缺少修改建议`)
    assert.ok(h.source_url && h.source_url.length > 0, `${h.rule_id} 缺少来源链接`)
  }
  ok(`BIASED 全部 ${r.hits.length} 处命中均带依据/建议/来源`)
}

// ---- 6. requires_human_review 闸门 ----
function testReviewGate() {
  const biased = detectText(BIASED)
  const clean = detectText(CLEAN)
  assert.strictEqual(biased.summary.requires_human_review, true, 'BIASED 应置 requires_human_review=true')
  assert.strictEqual(clean.summary.requires_human_review, false, 'CLEAN 应置 requires_human_review=false')
  ok('requires_human_review 闸门正确（BIASED=true / CLEAN=false）')
}

// ---- 7. by_category 统计 ----
function testByCategory() {
  const r = detectText(BIASED)
  assert.ok((r.summary.by_category['地域限制'] ?? 0) >= 3, `地域限制应 >=3，实际 ${r.summary.by_category['地域限制']}`)
  ok(`BIASED 地域限制类命中 ${r.summary.by_category['地域限制']} 处`)
}

// ---- 8. docx 路径抽取正文 + 命中（构造最小 docx） ----
async function testDocxPath() {
  const lines = BIASED.trim().split('\n')
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const paras = lines
    .map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`)
    .join('')
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    paras +
    '</w:document>'
  const zip = new JSZip()
  zip.file('word/document.xml', xml)
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  const tmp = path.join(os.tmpdir(), `fairness-test-${Date.now()}.docx`)
  fs.writeFileSync(tmp, buf)
  try {
    const r = await detectDocx(tmp)
    const ids = ruleIds(r.hits)
    assert.ok(ids.has('FAIR.SPECIFY_BRAND'), 'docx：应命中 FAIR.SPECIFY_BRAND')
    assert.ok(ids.has('FAIR.REGION_PERFORMANCE'), 'docx：应命中 FAIR.REGION_PERFORMANCE')
    assert.ok(ids.has('FAIR.LOCAL_BRANCH'), 'docx：应命中 FAIR.LOCAL_BRANCH')
    assert.ok(ids.has('FAIR.OWNERSHIP_RESTRICT'), 'docx：应命中 FAIR.OWNERSHIP_RESTRICT')
    assert.ok(ids.has('FAIR.DISCRIMINATE_OUTSIDER'), 'docx：应命中 FAIR.DISCRIMINATE_OUTSIDER')
    assert.ok(r.summary.hard_count >= 5, `docx：HARD 命中应 >=5，实际 ${r.summary.hard_count}`)
    ok(`docx 路径抽取正文并命中（hard_count=${r.summary.hard_count}）`)
  } finally {
    fs.unlinkSync(tmp)
  }
}

async function main() {
  testRulesLoaded()
  testHardHits()
  testHardCount()
  testCleanNoFalsePositive()
  testTraceability()
  testReviewGate()
  testByCategory()
  await testDocxPath()
  console.log(`\n[FAIR] 冒烟测试通过：${passed} 项 ALL PASS`)
}

main().catch((e) => {
  console.error('\n[FAIR] 测试失败:', e && e.message ? e.message : e)
  process.exit(1)
})
