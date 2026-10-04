/**
 * 围串标自检回归测试（对照 AIBidForge test_collusion.py 行为）。
 *
 * 运行：npm run test:smoke（collusion.ts 会被一并编译到 .smoke-out）
 */
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, '..', '.smoke-out')
fs.writeFileSync(path.join(OUT, 'package.json'), '{"type":"commonjs"}')

const { tokenize, simhash, hammingDistance, similarity, detectPricePattern, collusionCheck } = require(path.join(OUT, 'collusion.js'))

let fail = 0
function ok(cond, label, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) fail++
}

// ---------- 1. SimHash 分词与指纹 ----------
console.log('--- 1. simhash 基础 ---')
const toks = tokenize('施工组织设计')
ok(toks.includes('施工') && toks.includes('组织'), 'bigram 分词', JSON.stringify(toks.slice(0, 3)))
const a = '本工程位于某市，道路全长三公里，采用半幅施工半幅通行的导改方案。'
ok(hammingDistance(simhash(a), simhash(a)) === 0, '相同文本海明距离=0')

// ---------- 2. 相似度判定 ----------
console.log('--- 2. 相似度判定 ---')
const b = '本工程位于某市，道路全长三公里，采用半幅施工半幅通行的交通导改方案，确保沿线出行。'
const c = '本工程位于某市，道路全长三公里，采用半幅施工半幅通行的交通导改方案，保证沿线出行。'
const simBC = similarity(b, c)
ok(['高度相似', '较相似'].includes(simBC.verdict), '近似文本判为相似', simBC.verdict)

const d = '本项目为水库除险加固，主要包括大坝防渗、溢洪道改造、度汛方案等内容。'
const simAD = similarity(a, d)
ok(simAD.verdict === '差异明显', '道路 vs 水库判为差异明显', simAD.verdict)

// ---------- 3. 报价规律检测 ----------
console.log('--- 3. 报价规律检测 ---')
const arith = detectPricePattern([29100000, 29200000, 29300000, 29400000])
ok(arith && arith.type === '等差规律', '等差报价命中', arith && arith.type)

const geo = detectPricePattern([10000000, 11000000, 12100000, 13310000])
ok(geo && geo.type === '等比规律', '等比报价命中', geo && geo.type)

const rand = detectPricePattern([28500000, 26800000, 30100000, 24700000])
ok(rand === null || rand.detected === false, '随机报价不命中')

const few = detectPricePattern([28500000, 30000000])
ok(few === null || few.detected === false, '样本不足(<3)不命中')

// ---------- 4. 编排：雷同簇 + 风险等级 ----------
console.log('--- 4. collusionCheck 编排 ---')
const repA = collusionCheck({
  documents: [
    { id: 'bid-2024-A', text: a },
    { id: 'bid-2024-B', text: a }, // 与 A 完全相同 -> 高度相似簇
    { id: 'bid-2024-C', text: d }, // 与 A/B 差异明显
  ],
  prices: [29100000, 29200000, 29300000, 29400000],
})
ok(repA.text_similarity.risk_groups.length === 1, '高度相似文档形成 1 个簇', JSON.stringify(repA.text_similarity.risk_groups))
ok(repA.text_similarity.risk_groups[0].length === 2, '簇内含 2 份文档', JSON.stringify(repA.text_similarity.risk_groups[0]))
ok(repA.price_pattern.detected === true && repA.price_pattern.type === '等差规律', '报价等差规律命中')
ok(repA.risk_level === 'HIGH', '总体风险 HIGH', repA.risk_level)
ok(repA.requires_human_review === true, 'requires_human_review=true')
ok(typeof repA.disclaimer === 'string' && repA.disclaimer.length > 0, '含合规免责声明')

// 干净输入：无雷同 + 无规律 -> LOW
const repB = collusionCheck({
  documents: [{ id: 'x', text: a }, { id: 'y', text: d }],
  prices: [28500000, 26800000, 30100000, 24700000],
})
ok(repB.risk_level === 'LOW', '干净输入风险 LOW', repB.risk_level)
ok(repB.text_similarity.risk_groups.length === 0, '无雷同簇')

// 过短文本被跳过
const repC = collusionCheck({ documents: [{ id: 's1', text: '很短' }, { id: 's2', text: '也很短' }] })
ok(repC.input_summary.skipped_short === 2, '过短文本计入 skipped_short', String(repC.input_summary.skipped_short))

console.log(`\n围串标自检测试：${fail === 0 ? 'ALL PASS' : fail + ' 项失败'}`)
process.exit(fail === 0 ? 0 : 1)
