/* precheck 单元测试
 * 覆盖：P01-P12 每项触发/不触发、组合场景、异常路径、
 *       报价抽取单位换算与 guard 上限、工期抽取格式、summary 计数、industry 适用性过滤
 */
const assert = require('assert')
const { precheckBid } = require('../.smoke-out/precheck.js')

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

function findItem(r, code) {
  const it = r.items.find((x) => x.code === code)
  assert.ok(it, `缺少 ${code}`)
  return it
}

// ---- 异常路径 ----
function testThrowEmpty() {
  assert.throws(() => precheckBid({ draft_text: '' }), /为空/)
  assert.throws(() => precheckBid({ draft_text: '   \n\t ' }), /为空/)
  assert.throws(() => precheckBid({ draft_text: null }), /为空/)
  assert.throws(() => precheckBid({ draft_text: undefined }), /为空/)
  assert.throws(() => precheckBid({}), /为空/)
  ok('空/空白/null/undefined/缺省 draft_text 抛错')
}

// ---- P01 签字盖章 ----
function testP01() {
  const pass = precheckBid({ draft_text: '法定代表人签字并加盖公章。' })
  assert.strictEqual(findItem(pass, 'P01').status, 'PASS')
  const onlySign = precheckBid({ draft_text: '已由法定代表人签字。' })
  assert.strictEqual(findItem(onlySign, 'P01').status, 'WARN')
  const onlySeal = precheckBid({ draft_text: '加盖公章。' })
  assert.strictEqual(findItem(onlySeal, 'P01').status, 'WARN')
  const none = precheckBid({ draft_text: '技术方案说明。' })
  assert.strictEqual(findItem(none, 'P01').status, 'WARN')
  ok('P01 签字盖章：签字+盖章=PASS，仅签字/仅盖章/都无=WARN')
}

// ---- P02 联合体 ----
function testP02() {
  const noConsortium = precheckBid({ draft_text: '独立投标。' })
  assert.strictEqual(findItem(noConsortium, 'P02').status, 'PASS')
  const withAgreement = precheckBid({ draft_text: '联合体投标，附联合体协议书。' })
  assert.strictEqual(findItem(withAgreement, 'P02').status, 'PASS')
  const noAgreement = precheckBid({ draft_text: '联合体投标。' })
  assert.strictEqual(findItem(noAgreement, 'P02').status, 'WARN')
  ok('P02 联合体：无联合体=PASS，联合体+协议=PASS，联合体无协议=WARN')
}

// ---- P03 资格条件 ----
function testP03() {
  const r = precheckBid({ draft_text: '内容。' })
  const p03 = findItem(r, 'P03')
  assert.strictEqual(p03.status, 'MANUAL')
  assert.ok(p03.next_action.length > 0)
  ok('P03 资格条件恒为 MANUAL 且带指引')
}

// ---- P04 唯一报价 ----
function testP04() {
  const noPrice = precheckBid({ draft_text: '无报价表述。' })
  assert.strictEqual(findItem(noPrice, 'P04').status, 'PASS')
  const single = precheckBid({ draft_text: '投标报价为人民币 2800 万元。' })
  assert.strictEqual(findItem(single, 'P04').status, 'PASS')
  const sameMulti = precheckBid({ draft_text: '投标报价一 2800 万元。投标报价二 2800 万元。' })
  assert.strictEqual(findItem(sameMulti, 'P04').status, 'PASS')
  const diffMulti = precheckBid({ draft_text: '投标报价一 2800 万元。投标报价二 2700 万元。' })
  assert.strictEqual(findItem(diffMulti, 'P04').status, 'REJECT_RISK')
  ok('P04 唯一报价：无报价/单报价/相同多报价=PASS，不同多报价=REJECT_RISK')
}

// ---- P05 报价范围 ----
function testP05() {
  const noLimit = precheckBid({ draft_text: '投标报价 2800 万元。' })
  assert.strictEqual(findItem(noLimit, 'P05').status, 'MANUAL')
  const limitNoPrice = precheckBid({ draft_text: '无报价。', control_price: 30000000 })
  assert.strictEqual(findItem(limitNoPrice, 'P05').status, 'MANUAL')
  const inRange = precheckBid({ draft_text: '投标报价 2800 万元。', control_price: 30000000 })
  assert.strictEqual(findItem(inRange, 'P05').status, 'PASS')
  const over = precheckBid({ draft_text: '投标报价 3200 万元。', control_price: 30000000 })
  assert.strictEqual(findItem(over, 'P05').status, 'REJECT_RISK')
  const low = precheckBid({ draft_text: '投标报价 2000 万元。', control_price: 30000000 })
  assert.strictEqual(findItem(low, 'P05').status, 'WARN')
  ok('P05 报价范围：无限价/限价无报价=MANUAL，范围内=PASS，超限价=REJECT_RISK，低于70%=WARN')
}

// ---- P06/P07/P09/P10 MANUAL ----
function testManualItems() {
  const r = precheckBid({ draft_text: '内容。' })
  for (const code of ['P06', 'P07', 'P09', 'P10']) {
    const it = findItem(r, code)
    assert.strictEqual(it.status, 'MANUAL', `${code} 应 MANUAL`)
    assert.ok(it.next_action.length > 0, `${code} 缺指引`)
  }
  ok('P06/P07/P09/P10 恒为 MANUAL 且带工具指引')
}

// ---- P08 投标保证金 ----
function testP08() {
  const withDeposit = precheckBid({ draft_text: '已缴纳投标保证金。' })
  assert.strictEqual(findItem(withDeposit, 'P08').status, 'PASS')
  const noDeposit = precheckBid({ draft_text: '本章为技术方案说明。' })
  assert.strictEqual(findItem(noDeposit, 'P08').status, 'WARN')
  ok('P08 投标保证金：含=PASS，不含=WARN')
}

// ---- P11 ★号参数 ----
function testP11() {
  // industry 不适用
  const notApply = precheckBid({ draft_text: '内容。', industry: 'construction' })
  assert.strictEqual(findItem(notApply, 'P11').status, 'PASS')
  // industry 适用 + 无 ★
  const applyNoStar = precheckBid({ draft_text: '内容。', industry: 'new_energy' })
  assert.strictEqual(findItem(applyNoStar, 'P11').status, 'PASS')
  // industry 适用 + 有 ★
  const applyStar = precheckBid({ draft_text: '★号参数响应。', industry: 'new_energy' })
  assert.strictEqual(findItem(applyStar, 'P11').status, 'WARN')
  // material_equipment 适用 + 有 ★
  const matApply = precheckBid({ draft_text: '★技术参数。', industry: 'material_equipment' })
  assert.strictEqual(findItem(matApply, 'P11').status, 'WARN')
  // industry 空
  const emptyIndustry = precheckBid({ draft_text: '★号。' })
  assert.strictEqual(findItem(emptyIndustry, 'P11').status, 'PASS')
  ok('P11 ★号参数：不适用=PASS，适用无★=PASS，适用有★=WARN（new_energy/material_equipment）')
}

// ---- P12 工期与质量承诺 ----
function testP12() {
  // 无 required + 无工期 -> WARN
  const noReqNoDur = precheckBid({ draft_text: '内容。' })
  assert.strictEqual(findItem(noReqNoDur, 'P12').status, 'WARN')
  // 无 required + 有工期 -> PASS
  const noReqHasDur = precheckBid({ draft_text: '工期承诺 170 日历天。' })
  assert.strictEqual(findItem(noReqHasDur, 'P12').status, 'PASS')
  // 有 required + 无工期 -> MANUAL
  const reqNoDur = precheckBid({ draft_text: '内容。', required_duration_days: 180 })
  assert.strictEqual(findItem(reqNoDur, 'P12').status, 'MANUAL')
  // 有 required + 工期 < required -> PASS
  const reqOk = precheckBid({ draft_text: '工期承诺 170 日历天。', required_duration_days: 180 })
  assert.strictEqual(findItem(reqOk, 'P12').status, 'PASS')
  // 有 required + 工期 == required -> PASS（边界，非严格大于）
  const reqEqual = precheckBid({ draft_text: '工期承诺 180 日历天。', required_duration_days: 180 })
  assert.strictEqual(findItem(reqEqual, 'P12').status, 'PASS')
  // 有 required + 工期 > required -> REJECT_RISK
  const reqOver = precheckBid({ draft_text: '工期承诺 200 日历天。', required_duration_days: 180 })
  assert.strictEqual(findItem(reqOver, 'P12').status, 'REJECT_RISK')
  ok('P12 工期：无要求无工期=WARN，无要求有工期=PASS，有要求无工期=MANUAL，工期<=要求=PASS，超期=REJECT_RISK')
}

// ---- 报价抽取单位换算 ----
function testExtractBidPricesUnits() {
  // 亿元：1.8 亿 = 180000000 元，限价 2 亿 -> 在 [70%,100%] 限价区间内 PASS
  const r1 = precheckBid({ draft_text: '投标报价 1.8 亿元。', control_price: 200000000 })
  assert.strictEqual(findItem(r1, 'P05').status, 'PASS')
  // 万元 + 万元 不同金额 -> REJECT_RISK
  const r2 = precheckBid({ draft_text: '投标报价一 2800 万元。投标报价二 3000 万元。' })
  assert.strictEqual(findItem(r2, 'P04').status, 'REJECT_RISK')
  // 元单位：28000000 元 = 2800 万，限价 3000 万 -> 范围内 PASS
  const r3 = precheckBid({ draft_text: '投标报价 28000000 元。', control_price: 30000000 })
  assert.strictEqual(findItem(r3, 'P05').status, 'PASS')
  ok('报价抽取：亿元/万元/元 单位换算正确')
}

// ---- 工期抽取格式 ----
function testExtractDurationFormats() {
  assert.strictEqual(findItem(precheckBid({ draft_text: '工期 170 日历天。', required_duration_days: 180 }), 'P12').status, 'PASS')
  assert.strictEqual(findItem(precheckBid({ draft_text: '工期承诺 170 天。', required_duration_days: 180 }), 'P12').status, 'PASS')
  assert.strictEqual(findItem(precheckBid({ draft_text: '总工期 170 日。', required_duration_days: 180 }), 'P12').status, 'PASS')
  assert.strictEqual(findItem(precheckBid({ draft_text: '计划工期 170 个日历天。', required_duration_days: 180 }), 'P12').status, 'PASS')
  ok('工期抽取：日历天/天/日/个日历天 均可识别')
}

// ---- 组合场景 + summary ----
function testCombinationAndSummary() {
  const GOOD = `
1. 投标文件已由法定代表人签字并加盖公章。
2. 本项目工期承诺 170 日历天。
3. 投标报价为人民币 2800 万元。
4. 已按招标文件要求缴纳投标保证金。
`
  const r = precheckBid({ draft_text: GOOD, control_price: 30000000, required_duration_days: 180, industry: 'construction' })
  assert.strictEqual(r.items.length, 12)
  const sum = r.summary
  assert.strictEqual(sum.pass + sum.warn + sum.reject_risk + sum.manual, 12, 'summary 总数应为 12')
  assert.strictEqual(r.industry, 'construction')
  assert.strictEqual(sum.reject_risk, 0, '好草稿不应有 REJECT_RISK')
  ok(`组合场景：12 项齐全，summary={pass:${sum.pass},warn:${sum.warn},reject_risk:${sum.reject_risk},manual:${sum.manual}}`)
}

// ---- 报价抽取上限 8（guard < 8）----
function testBidPriceGuard8() {
  let draft = ''
  for (let i = 1; i <= 10; i++) draft += `投标报价：${2800 + i} 万元。`
  const r = precheckBid({ draft_text: draft })
  // 10 个不同报价但 guard 只取前 8 个 -> distinct 8 > 1 -> REJECT_RISK
  assert.strictEqual(findItem(r, 'P04').status, 'REJECT_RISK')
  ok('报价抽取 guard<8：10 个报价只取前 8 个，仍判定多报价 REJECT_RISK')
}

// ---- disclaimer 与 basis ----
function testDisclaimerAndBasis() {
  const r = precheckBid({ draft_text: '内容。' })
  assert.ok(r.disclaimer.length > 0, '应含 disclaimer')
  for (const it of r.items) {
    assert.ok(it.basis.length > 0, `${it.code} 缺法律依据`)
    assert.ok(['PASS', 'WARN', 'REJECT_RISK', 'MANUAL'].includes(it.status), `${it.code} 状态非法`)
  }
  ok('disclaimer 非空 + 12 项均带法律依据与合法状态')
}

async function main() {
  testThrowEmpty()
  testP01()
  testP02()
  testP03()
  testP04()
  testP05()
  testManualItems()
  testP08()
  testP11()
  testP12()
  testExtractBidPricesUnits()
  testExtractDurationFormats()
  testCombinationAndSummary()
  testBidPriceGuard8()
  testDisclaimerAndBasis()
  console.log(`\n[UNIT-PRECHECK] 单元测试通过：${passed} 项 ALL PASS`)
}

main().catch((e) => {
  console.error('\n[UNIT-PRECHECK] 测试失败:', e && e.message ? e.message : e)
  process.exit(1)
})