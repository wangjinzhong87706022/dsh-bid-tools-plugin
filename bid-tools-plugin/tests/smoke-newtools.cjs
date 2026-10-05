/* AIBidForge5.0 移植新工具冒烟测试
 * 覆盖：industryDetect（11 行业加载/_meta 滤除/识别/pack_key 映射/回落）、
 *       precheck（12 项否决情形：签字盖章/多报价/超限价/超期/MANUAL 指引）、
 *       scorePrice（5 方法：AVG_DROP 基准价/线性扣分/最低价满分/合理低价区间/双随机矩阵/超限价否决）
 */
const assert = require('assert')
const { allIndustryNames, detectIndustry, detectPackKey, packKeyMapping } = require('../.smoke-out/industryDetect.js')
const { precheckBid } = require('../.smoke-out/precheck.js')
const { scorePrice } = require('../.smoke-out/scorePrice.js')

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

// ---- industryDetect ----
function testIndustryLoaded() {
  const names = allIndustryNames()
  assert.strictEqual(names.length, 11, `应加载 11 个行业，实际 ${names.length}`)
  assert.ok(!names.some((n) => n.startsWith('_')), '不应包含 _meta 等内部键')
  for (const expect of ['建筑工程', '市政道路与给排水', '水利水电', '信息化与IT', '政府采购与货物服务']) {
    assert.ok(names.includes(expect), `缺少行业 ${expect}`)
  }
  ok('加载 11 个行业（滤除 _meta）')
}

function testIndustryDetect() {
  const text = '本项目为水库除险加固工程，含堤防施工导流与度汛方案，要求水利水电工程施工总承包二级资质。'
  const r = detectIndustry(text)
  assert.strictEqual(r.name, '水利水电', `应识别为水利水电，实际 ${r.name}`)
  assert.strictEqual(r.pack_key, 'water', 'pack_key 应为 water')
  assert.ok(r.confidence > 0, 'confidence 应 >0')
  assert.ok(r.matched_keywords.length > 0, '应有命中关键词')
  ok(`识别"水利水电"（pack_key=${r.pack_key}, confidence=${r.confidence}）`)
}

function testPackKeyMapping() {
  const mapping = packKeyMapping()
  assert.strictEqual(mapping['政府采购与货物服务'], 'gov_procurement', '政采应映射 gov_procurement')
  assert.strictEqual(mapping['信息化与IT'], 'it_informatization', 'IT 应映射 it_informatization')
  assert.strictEqual(mapping['水利水电'], 'water', '水利应映射 water')
  assert.strictEqual(detectPackKey('不存在的行业'), 'construction', '未收录行业应回落 construction')
  ok('pack_key 映射正确（单源 _meta.pack_key_mapping + 回落）')
}

function testUnknownIndustry() {
  const r = detectIndustry('今天天气不错，适合出去走走。')
  assert.strictEqual(r.name, '未识别', '无关文本应识别为未识别')
  assert.strictEqual(r.confidence, 0, '未识别 confidence 应为 0')
  ok('无关文本识别为未识别（confidence=0）')
}

// ---- precheck ----
const GOOD_DRAFT = `
1. 投标文件已由法定代表人签字并加盖公章。
2. 本项目工期承诺 170 日历天。
3. 投标报价为人民币 2800 万元。
4. 已按招标文件要求缴纳投标保证金。
`

function testPrecheck12Items() {
  const r = precheckBid({ draft_text: GOOD_DRAFT, control_price: 3000_0000, required_duration_days: 180 })
  assert.strictEqual(r.items.length, 12, `应输出 12 项，实际 ${r.items.length}`)
  for (const it of r.items) {
    assert.ok(it.basis && it.basis.length > 0, `${it.code} 缺少法律依据`)
    assert.ok(['PASS', 'WARN', 'REJECT_RISK', 'MANUAL'].includes(it.status), `${it.code} 状态非法 ${it.status}`)
  }
  ok('输出 12 项否决情形（P01-P12，均带法律依据）')
}

function testPrecheckMultiPrice() {
  const draft = '投标报价一：人民币 2800 万元。投标报价二：人民币 2700 万元。'
  const r = precheckBid({ draft_text: draft })
  const p04 = r.items.find((x) => x.code === 'P04')
  assert.strictEqual(p04.status, 'REJECT_RISK', `两个报价应 REJECT_RISK，实际 ${p04.status}`)
  ok('P04 两个不同报价 -> REJECT_RISK')
}

function testPrecheckOverLimit() {
  const draft = '投标报价为人民币 3200 万元。'
  const r = precheckBid({ draft_text: draft, control_price: 3000_0000 })
  const p05 = r.items.find((x) => x.code === 'P05')
  assert.strictEqual(p05.status, 'REJECT_RISK', `超限价应 REJECT_RISK，实际 ${p05.status}`)
  ok('P05 报价超最高限价 -> REJECT_RISK')
}

function testPrecheckOverDuration() {
  const draft = '本项目工期承诺 200 日历天。'
  const r = precheckBid({ draft_text: draft, required_duration_days: 180 })
  const p12 = r.items.find((x) => x.code === 'P12')
  assert.strictEqual(p12.status, 'REJECT_RISK', `超期应 REJECT_RISK，实际 ${p12.status}`)
  ok('P12 工期承诺超招标要求 -> REJECT_RISK')
}

function testPrecheckManualGuidance() {
  const r = precheckBid({ draft_text: GOOD_DRAFT })
  const manual = r.items.filter((x) => x.status === 'MANUAL')
  assert.ok(manual.length >= 5, `MANUAL 项应 >=5（资格/实质性/串标/暗标泄露/暗标格式），实际 ${manual.length}`)
  for (const it of manual) {
    assert.ok(it.next_action.length > 0, `${it.code} MANUAL 项缺少 next_action`)
  }
  const codes = new Set(manual.map((x) => x.code))
  for (const expect of ['P03', 'P06', 'P07', 'P09', 'P10']) {
    assert.ok(codes.has(expect), `MANUAL 应包含 ${expect}`)
  }
  ok(`MANUAL 项 ${manual.length} 个均带工具/人工指引`)
}

function testPrecheckSignSeal() {
  const r = precheckBid({ draft_text: GOOD_DRAFT })
  const p01 = r.items.find((x) => x.code === 'P01')
  assert.strictEqual(p01.status, 'PASS', `含签字盖章应 PASS，实际 ${p01.status}`)
  const bad = precheckBid({ draft_text: '本章为技术方案说明。' })
  assert.strictEqual(bad.items.find((x) => x.code === 'P01').status, 'WARN', '无签字盖章应 WARN')
  ok('P01 签字盖章判定正确（PASS/WARN）')
}

// ---- scorePrice ----
function testScorePriceLinear() {
  const r = scorePrice({ prices: [850, 860, 870, 880, 890], method: 'BASE_PRICE_LINEAR' })
  assert.strictEqual(r.method, 'BASE_PRICE_LINEAR')
  // AVG_DROP：去掉 1 高 890 与 1 低 850 -> 平均 (860+870+880)/3 = 870
  assert.strictEqual(r.base_price.value, 870, `基准价应为 870，实际 ${r.base_price.value}`)
  assert.strictEqual(r.base_price.algorithm, 'AVG_DROP')
  // 850：低 20/870 = 2.299%，每 1% 扣 0.5 -> 100 - 1.149 = 98.85
  const p850 = r.scores.find((x) => x.price === 850)
  assert.ok(Math.abs(p850.score - 98.85) < 0.01, `850 得分应 98.85，实际 ${p850.score}`)
  // 890：高 20/870 = 2.299%，每 1% 扣 1.0 -> 100 - 2.299 = 97.7
  const p890 = r.scores.find((x) => x.price === 890)
  assert.ok(Math.abs(p890.score - 97.7) < 0.01, `890 得分应 97.7，实际 ${p890.score}`)
  // 排名：基准价 870 得满分排第一
  const p870 = r.scores.find((x) => x.price === 870)
  assert.strictEqual(p870.score, 100)
  assert.strictEqual(p870.rank, 1)
  ok(`线性扣分：基准价 ${r.base_price.value}（AVG_DROP），870 满分第一`)
}

function testScorePriceLowestFull() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'LOWEST_FULL' })
  assert.strictEqual(r.base_price.algorithm, 'MIN_PRICE')
  assert.strictEqual(r.base_price.value, 850)
  const p850 = r.scores.find((x) => x.price === 850)
  assert.strictEqual(p850.score, 100, '最低价应满分')
  const p870 = r.scores.find((x) => x.price === 870)
  assert.ok(Math.abs(p870.score - 850 / 870 * 100) < 0.01, `870 得分应 ${((850 / 870) * 100).toFixed(2)}`)
  ok('最低价满分法：850 满分，其余按比例')
}

function testScorePriceReasonableLow() {
  const r = scorePrice({ prices: [860, 875, 920], method: 'REASONABLE_LOW' })
  assert.strictEqual(r.method, 'REASONABLE_LOW')
  // AVG_DROP：3 个报价不足 2*1+1=3？3 >= 3 成立，去 1 高 920 与 1 低 860 -> 875
  assert.strictEqual(r.base_price.value, 875)
  // 区间 [875*0.95, 875*1.03] = [831.25, 901.25]
  const p860 = r.scores.find((x) => x.price === 860)
  assert.strictEqual(p860.score, 100, '860 在区间内应满分')
  const p920 = r.scores.find((x) => x.price === 920)
  assert.ok(p920.score < 100, '920 超区间应扣分')
  ok('合理低价法：区间内满分，超区间线性扣分')
}

function testScorePriceDualRandom() {
  const r = scorePrice({ prices: [850, 860, 870, 880, 890], method: 'HEBEI_DUAL_RANDOM' })
  assert.strictEqual(r.method, 'HEBEI_DUAL_RANDOM')
  assert.ok(r.candidate_matrix.length >= 4, `候选算法矩阵应 >=4，实际 ${r.candidate_matrix.length}`)
  for (const c of r.candidate_matrix) {
    assert.ok(c.base_price > 0, `${c.algorithm} 基准价应 >0`)
    assert.strictEqual(c.scores.length, 5, `${c.algorithm} 得分数应为 5`)
  }
  // 不代抽：rank 全 0
  for (const it of r.scores) assert.strictEqual(it.rank, 0, '双随机不应给出排名')
  ok(`河北双随机：${r.candidate_matrix.length} 候选算法得分矩阵，不代抽（rank=0）`)
}

function testScorePriceOverLimit() {
  const r = scorePrice({ prices: [850, 860, 3200], control_price: 900, method: 'BASE_PRICE_LINEAR' })
  const over = r.scores.find((x) => x.price === 3200)
  assert.strictEqual(over.score, 0, '超限价应 0 分')
  assert.ok(over.notes.some((n) => n.includes('否决')), '超限价应注明否决')
  assert.strictEqual(over.rank, 0, '超限价不参与排名')
  ok('超最高限价 -> 0 分 + 否决注记 + 不参与排名')
}

function testScorePriceDropDowngrade() {
  const r = scorePrice({ prices: [850, 860], method: 'BASE_PRICE_LINEAR' })
  // 2 个报价不足以去 1 高 1 低，降级 AVG_ALL
  assert.strictEqual(r.base_price.algorithm, 'AVG_DROP')
  assert.strictEqual(r.base_price.value, 855)
  assert.ok(r.base_price.notes.some((n) => n.includes('降级')), '应注明降级')
  ok('AVG_DROP 不足时降级全体平均并注明')
}

async function main() {
  testIndustryLoaded()
  testIndustryDetect()
  testPackKeyMapping()
  testUnknownIndustry()
  testPrecheck12Items()
  testPrecheckMultiPrice()
  testPrecheckOverLimit()
  testPrecheckOverDuration()
  testPrecheckManualGuidance()
  testPrecheckSignSeal()
  testScorePriceLinear()
  testScorePriceLowestFull()
  testScorePriceReasonableLow()
  testScorePriceDualRandom()
  testScorePriceOverLimit()
  testScorePriceDropDowngrade()
  console.log(`\n[NEWTOOLS] 冒烟测试通过：${passed} 项 ALL PASS`)
}

main().catch((e) => {
  console.error('\n[NEWTOOLS] 测试失败:', e && e.message ? e.message : e)
  process.exit(1)
})