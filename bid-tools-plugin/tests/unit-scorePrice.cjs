/* scorePrice 单元测试
 * 覆盖：5 种价格分方法、5 种基准价算法（含降级）、超限价否决、空/无效报价、
 *       未知方法回落、full_score/unit/params 自定义、排名逻辑、双随机矩阵
 */
const assert = require('assert')
const { scorePrice } = require('../.smoke-out/scorePrice.js')

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

// ---- BASE_PRICE_LINEAR ----
function testLinearDefaultAvgDrop() {
  const r = scorePrice({ prices: [850, 860, 870, 880, 890], method: 'BASE_PRICE_LINEAR' })
  assert.strictEqual(r.method, 'BASE_PRICE_LINEAR')
  // AVG_DROP 去 1 高 890 与 1 低 850 -> (860+870+880)/3 = 870
  assert.strictEqual(r.base_price.value, 870)
  assert.strictEqual(r.base_price.algorithm, 'AVG_DROP')
  const p870 = r.scores.find((x) => x.price === 870)
  assert.strictEqual(p870.score, 100)
  assert.strictEqual(p870.rank, 1)
  ok('BASE_PRICE_LINEAR 默认 AVG_DROP：基准价 870，得满分排第一')
}

function testLinearAvgDropDowngrade() {
  const r = scorePrice({ prices: [850, 860], method: 'BASE_PRICE_LINEAR' })
  // 2 个不足以去 1 高 1 低（需 >= 2*1+1=3）-> 降级 AVG_ALL = 855
  assert.strictEqual(r.base_price.value, 855)
  assert.ok(r.base_price.notes.some((n) => n.includes('降级')))
  ok('BASE_PRICE_LINEAR AVG_DROP 不足降级 AVG_ALL 并注明')
}

function testLinearCustomBaseAvgAll() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'BASE_PRICE_LINEAR', params: { base: 'AVG_ALL' } })
  assert.strictEqual(r.base_price.algorithm, 'AVG_ALL')
  assert.strictEqual(r.base_price.value, 860)
  ok('BASE_PRICE_LINEAR 自定义 base=AVG_ALL')
}

function testLinearCustomBaseAvgDropLower() {
  // AVG_DROP_LOWER 去 n 个最低，n=1 -> 去 850 -> (860+870+880)/3 = 870
  const r = scorePrice({ prices: [850, 860, 870, 880], method: 'BASE_PRICE_LINEAR', params: { base: 'AVG_DROP_LOWER', drop_n: 1 } })
  assert.strictEqual(r.base_price.algorithm, 'AVG_DROP_LOWER')
  assert.strictEqual(r.base_price.value, 870)
  ok('BASE_PRICE_LINEAR 自定义 base=AVG_DROP_LOWER 正常去低')
}

function testLinearAvgDropLowerDowngrade() {
  // 1 个报价不足以去 1 低（需 >= drop_n+1=2）-> 降级
  const r = scorePrice({ prices: [850], method: 'BASE_PRICE_LINEAR', params: { base: 'AVG_DROP_LOWER', drop_n: 1 } })
  assert.strictEqual(r.base_price.value, 850)
  assert.ok(r.base_price.notes.some((n) => n.includes('降级')))
  ok('BASE_PRICE_LINEAR AVG_DROP_LOWER 不足降级')
}

function testLinearCustomBaseMinPrice() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'BASE_PRICE_LINEAR', params: { base: 'MIN_PRICE' } })
  assert.strictEqual(r.base_price.algorithm, 'MIN_PRICE')
  assert.strictEqual(r.base_price.value, 850)
  ok('BASE_PRICE_LINEAR 自定义 base=MIN_PRICE')
}

function testLinearCustomBaseControlWeight() {
  // CONTROL_WEIGHT = 0.5*control + 0.5*mean
  const r = scorePrice({ prices: [850, 860, 870], method: 'BASE_PRICE_LINEAR', params: { base: 'CONTROL_WEIGHT' }, control_price: 900 })
  const mean = 860
  const expect = Math.round((0.5 * 900 + 0.5 * mean) * 100) / 100
  assert.strictEqual(r.base_price.algorithm, 'CONTROL_WEIGHT')
  assert.strictEqual(r.base_price.value, expect)
  ok(`BASE_PRICE_LINEAR base=CONTROL_WEIGHT：0.5*900+0.5*${mean}=${expect}`)
}

function testLinearControlWeightDowngrade() {
  // 无 control_price -> 降级 AVG_ALL
  const r = scorePrice({ prices: [850, 860, 870], method: 'BASE_PRICE_LINEAR', params: { base: 'CONTROL_WEIGHT' } })
  assert.strictEqual(r.base_price.value, 860)
  assert.ok(r.base_price.notes.some((n) => n.includes('降级')))
  ok('BASE_PRICE_LINEAR CONTROL_WEIGHT 无限价降级 AVG_ALL')
}

function testLinearPenaltyCustom() {
  const r = scorePrice({ prices: [800, 1000], method: 'BASE_PRICE_LINEAR', params: { base: 'AVG_ALL', above_penalty: 2, below_penalty: 1 } })
  // base = 900, above_penalty=2 比 below_penalty=1 扣更多
  const p800 = r.scores.find((x) => x.price === 800)
  const p1000 = r.scores.find((x) => x.price === 1000)
  assert.ok(p1000.score < p800.score, 'above_penalty=2 应扣更多')
  ok('BASE_PRICE_LINEAR 自定义 above_penalty/below_penalty')
}

function testLinearEqualBaseFullScore() {
  const r = scorePrice({ prices: [870, 860, 880], method: 'BASE_PRICE_LINEAR', params: { base: 'AVG_ALL' } })
  // base = 870, 870 == base -> 满分
  const p870 = r.scores.find((x) => x.price === 870)
  assert.strictEqual(p870.score, 100)
  ok('BASE_PRICE_LINEAR 报价等于基准价得满分')
}

// ---- LOWEST_FULL ----
function testLowestFull() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'LOWEST_FULL' })
  assert.strictEqual(r.method, 'LOWEST_FULL')
  assert.strictEqual(r.base_price.algorithm, 'MIN_PRICE')
  assert.strictEqual(r.base_price.value, 850)
  const p850 = r.scores.find((x) => x.price === 850)
  assert.strictEqual(p850.score, 100)
  assert.strictEqual(p850.rank, 1)
  const p870 = r.scores.find((x) => x.price === 870)
  assert.ok(Math.abs(p870.score - (100 * 850 / 870)) < 0.01)
  ok('LOWEST_FULL：最低价满分，其余按 满分×最低价/报价')
}

// ---- BASE_PRICE_RATIO ----
function testRatioDefault() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'BASE_PRICE_RATIO' })
  assert.strictEqual(r.method, 'BASE_PRICE_RATIO')
  assert.strictEqual(r.base_price.algorithm, 'AVG_ALL')
  assert.strictEqual(r.base_price.value, 860)
  // 850: 100*860/850 = 101.17 > 100 -> 取满分 100
  const p850 = r.scores.find((x) => x.price === 850)
  assert.strictEqual(p850.score, 100)
  assert.ok(p850.notes.some((n) => n.includes('满分')))
  ok('BASE_PRICE_RATIO 默认 AVG_ALL，超满分取满分')
}

function testRatioCustomBase() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'BASE_PRICE_RATIO', params: { base: 'MIN_PRICE' } })
  assert.strictEqual(r.base_price.value, 850)
  const p850 = r.scores.find((x) => x.price === 850)
  assert.strictEqual(p850.score, 100)
  ok('BASE_PRICE_RATIO 自定义 base=MIN_PRICE')
}

// ---- REASONABLE_LOW ----
function testReasonableLowInRange() {
  const r = scorePrice({ prices: [860, 875, 920], method: 'REASONABLE_LOW' })
  assert.strictEqual(r.method, 'REASONABLE_LOW')
  // AVG_DROP 3 个 >= 3 -> 去 1 高 920 与 1 低 860 -> 875
  assert.strictEqual(r.base_price.value, 875)
  // 区间 [875*0.95, 875*1.03] = [831.25, 901.25]，860 与 875 在内
  const p860 = r.scores.find((x) => x.price === 860)
  assert.strictEqual(p860.score, 100)
  const p875 = r.scores.find((x) => x.price === 875)
  assert.strictEqual(p875.score, 100)
  ok('REASONABLE_LOW 区间内满分')
}

function testReasonableLowOutOfRange() {
  const r = scorePrice({ prices: [860, 875, 920], method: 'REASONABLE_LOW' })
  // 920 > 901.25 -> 扣分
  const p920 = r.scores.find((x) => x.price === 920)
  assert.ok(p920.score < 100, '920 超区间应扣分')
  ok('REASONABLE_LOW 超区间线性扣分')
}

function testReasonableLowCustomParams() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'REASONABLE_LOW', params: { base: 'AVG_ALL', lower_pct: 0.1, upper_pct: 0.1, out_penalty: 1 } })
  // base = 860, 区间 [860*0.9, 860*1.1] = [774, 946]，全部在内
  for (const it of r.scores) assert.strictEqual(it.score, 100, `${it.price} 应满分`)
  ok('REASONABLE_LOW 自定义 lower_pct/upper_pct/out_penalty')
}

function testReasonableLowAvgDropDowngrade() {
  const r = scorePrice({ prices: [850, 860], method: 'REASONABLE_LOW' })
  // 2 个不足以 AVG_DROP -> 降级 AVG_ALL = 855
  assert.strictEqual(r.base_price.value, 855)
  assert.ok(r.base_price.notes.some((n) => n.includes('降级')))
  ok('REASONABLE_LOW AVG_DROP 不足降级')
}

// ---- HEBEI_DUAL_RANDOM ----
function testDualRandom() {
  const r = scorePrice({ prices: [850, 860, 870, 880, 890], method: 'HEBEI_DUAL_RANDOM' })
  assert.strictEqual(r.method, 'HEBEI_DUAL_RANDOM')
  assert.ok(r.candidate_matrix.length >= 4, `候选矩阵应 >=4，实际 ${r.candidate_matrix.length}`)
  for (const c of r.candidate_matrix) {
    assert.ok(c.base_price > 0, `${c.algorithm} 基准价应 >0`)
    assert.strictEqual(c.scores.length, 5)
  }
  // 不代抽：rank 全 0
  for (const it of r.scores) assert.strictEqual(it.rank, 0, '双随机不应给出排名')
  // baseValue NaN
  assert.ok(Number.isNaN(r.base_price.value), 'base_price.value 应为 NaN')
  assert.strictEqual(r.base_price.algorithm, 'HEBEI_DUAL_RANDOM')
  ok(`HEBEI_DUAL_RANDOM：${r.candidate_matrix.length} 候选算法矩阵，rank 全 0，baseValue=NaN`)
}

function testDualRandomCustomCandidates() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'HEBEI_DUAL_RANDOM', params: { candidates: ['AVG_ALL', 'MIN_PRICE'] } })
  assert.strictEqual(r.candidate_matrix.length, 2)
  assert.strictEqual(r.candidate_matrix[0].algorithm, 'AVG_ALL')
  assert.strictEqual(r.candidate_matrix[1].algorithm, 'MIN_PRICE')
  ok('HEBEI_DUAL_RANDOM 自定义 candidates')
}

// ---- 超限价否决 ----
function testOverLimitReject() {
  const r = scorePrice({ prices: [850, 860, 3200], control_price: 900, method: 'BASE_PRICE_LINEAR' })
  const over = r.scores.find((x) => x.price === 3200)
  assert.strictEqual(over.score, 0)
  assert.ok(over.notes.some((n) => n.includes('否决')))
  assert.strictEqual(over.rank, 0)
  ok('超最高限价 -> 0 分 + 否决注记 + rank=0')
}

function testEqualLimitNotReject() {
  // 报价等于限价不否决（严格大于判定）
  const r = scorePrice({ prices: [850, 900], control_price: 900, method: 'BASE_PRICE_LINEAR' })
  const p900 = r.scores.find((x) => x.price === 900)
  assert.ok(p900.score > 0, '等于限价不应否决')
  ok('报价等于限价不否决（严格大于判定）')
}

// ---- 排名 ----
function testRanking() {
  const r = scorePrice({ prices: [850, 860, 870, 880, 890], method: 'BASE_PRICE_LINEAR' })
  const ranked = r.scores.filter((x) => x.rank > 0).sort((a, b) => a.rank - b.rank)
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i].score <= ranked[i - 1].score, '排名应按得分降序')
  }
  ok('排名按得分降序')
}

// ---- 异常/边界 ----
function testEmptyPricesThrow() {
  assert.throws(() => scorePrice({ prices: [] }), /为空或不含有效正数/)
  ok('空 prices 抛错')
}

function testInvalidPricesFiltered() {
  // 含 0、负数、NaN、Infinity -> 过滤后剩 [850, 860]
  const r = scorePrice({ prices: [850, 0, -10, NaN, Infinity, 860], method: 'BASE_PRICE_LINEAR' })
  assert.strictEqual(r.scores.length, 2)
  ok('无效报价（0/负数/NaN/Infinity）被过滤')
}

function testAllInvalidPricesThrow() {
  assert.throws(() => scorePrice({ prices: [0, -1, NaN], method: 'BASE_PRICE_LINEAR' }), /为空或不含有效正数/)
  ok('全部无效报价抛错')
}

function testUnknownMethodFallback() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'UNKNOWN_METHOD' })
  assert.strictEqual(r.method, 'BASE_PRICE_LINEAR')
  ok('未知 method 回落 BASE_PRICE_LINEAR')
}

function testDefaultMethod() {
  const r = scorePrice({ prices: [850, 860, 870] })
  assert.strictEqual(r.method, 'BASE_PRICE_LINEAR')
  ok('未指定 method 默认 BASE_PRICE_LINEAR')
}

function testCustomFullScore() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'LOWEST_FULL', full_score: 50 })
  assert.strictEqual(r.full_score, 50)
  const p850 = r.scores.find((x) => x.price === 850)
  assert.strictEqual(p850.score, 50)
  ok('自定义 full_score=50')
}

function testInvalidFullScoreFallback() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'LOWEST_FULL', full_score: -10 })
  assert.strictEqual(r.full_score, 100)
  ok('full_score <=0 回落 100')
}

function testUnit() {
  const r1 = scorePrice({ prices: [850, 860], method: 'BASE_PRICE_LINEAR', unit: '元' })
  assert.strictEqual(r1.unit, '元')
  const r2 = scorePrice({ prices: [850, 860], method: 'BASE_PRICE_LINEAR', unit: '万元' })
  assert.strictEqual(r2.unit, '万元')
  const r3 = scorePrice({ prices: [850, 860], method: 'BASE_PRICE_LINEAR' })
  assert.strictEqual(r3.unit, '万元')
  ok('unit 元/万元，默认万元')
}

function testParamsOverride() {
  const r = scorePrice({ prices: [850, 860, 870, 880, 890], method: 'BASE_PRICE_LINEAR', params: { drop_n: 2 } })
  // drop_n=2，5 个 >= 2*2+1=5 -> 去 2 高 2 低 -> [870] -> 870
  assert.strictEqual(r.base_price.value, 870)
  ok('params 覆盖默认 drop_n')
}

function testNoControlPriceNote() {
  const r = scorePrice({ prices: [850, 860, 870], method: 'BASE_PRICE_LINEAR' })
  assert.ok(r.base_price.notes.some((n) => n.includes('未提供最高限价')), '应注明未提供限价')
  ok('未提供 control_price 时注明未做超限价否决检查')
}

async function main() {
  testLinearDefaultAvgDrop()
  testLinearAvgDropDowngrade()
  testLinearCustomBaseAvgAll()
  testLinearCustomBaseAvgDropLower()
  testLinearAvgDropLowerDowngrade()
  testLinearCustomBaseMinPrice()
  testLinearCustomBaseControlWeight()
  testLinearControlWeightDowngrade()
  testLinearPenaltyCustom()
  testLinearEqualBaseFullScore()
  testLowestFull()
  testRatioDefault()
  testRatioCustomBase()
  testReasonableLowInRange()
  testReasonableLowOutOfRange()
  testReasonableLowCustomParams()
  testReasonableLowAvgDropDowngrade()
  testDualRandom()
  testDualRandomCustomCandidates()
  testOverLimitReject()
  testEqualLimitNotReject()
  testRanking()
  testEmptyPricesThrow()
  testInvalidPricesFiltered()
  testAllInvalidPricesThrow()
  testUnknownMethodFallback()
  testDefaultMethod()
  testCustomFullScore()
  testInvalidFullScoreFallback()
  testUnit()
  testParamsOverride()
  testNoControlPriceNote()
  console.log(`\n[UNIT-SCOREPRICE] 单元测试通过：${passed} 项 ALL PASS`)
}

main().catch((e) => {
  console.error('\n[UNIT-SCOREPRICE] 测试失败:', e && e.message ? e.message : e)
  process.exit(1)
})