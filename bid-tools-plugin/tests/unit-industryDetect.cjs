/* industryDetect 单元测试
 * 覆盖：11 行业加载/_meta 滤除/pack_key 映射与回落/空文本/单关键词命中/
 *       多行业命中排序/平分命中/无匹配/confidence 精确值/matched_keywords 截断/matches 收集
 */
const assert = require('assert')
const { allIndustryNames, detectIndustry, detectPackKey, packKeyMapping } = require('../.smoke-out/industryDetect.js')
const industryData = require('../.smoke-out/data/industry_detect.json')

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

function testAllIndustryNames() {
  const names = allIndustryNames()
  assert.strictEqual(names.length, 11, `应加载 11 个行业，实际 ${names.length}`)
  assert.ok(!names.some((n) => n.startsWith('_')), '不应包含 _meta 等内部键')
  for (const expect of ['建筑工程', '市政道路与给排水', '水利水电', '机电安装与装饰装修', '新能源', '城市更新', '材料设备采购', '公路交通', 'EPC工程总承包', '信息化与IT', '政府采购与货物服务']) {
    assert.ok(names.includes(expect), `缺少行业 ${expect}`)
  }
  ok('allIndustryNames 返回 11 个行业（滤除 _meta 等下划线键）')
}

function testPackKeyMapping() {
  const mapping = packKeyMapping()
  assert.strictEqual(Object.keys(mapping).length, 11, `映射应含 11 项，实际 ${Object.keys(mapping).length}`)
  const expect = {
    '建筑工程': 'construction',
    '市政道路与给排水': 'municipal',
    '水利水电': 'water',
    '机电安装与装饰装修': 'mep',
    '新能源': 'new_energy',
    '城市更新': 'urban_renewal',
    '材料设备采购': 'material_equipment',
    '公路交通': 'transport',
    'EPC工程总承包': 'epc',
    '信息化与IT': 'it_informatization',
    '政府采购与货物服务': 'gov_procurement',
  }
  for (const [k, v] of Object.entries(expect)) {
    assert.strictEqual(mapping[k], v, `${k} 应映射 ${v}，实际 ${mapping[k]}`)
  }
  ok('packKeyMapping 返回 11 个 pack_key 映射（单源 _meta.pack_key_mapping）')
}

function testDetectPackKey() {
  assert.strictEqual(detectPackKey('水利水电'), 'water')
  assert.strictEqual(detectPackKey('信息化与IT'), 'it_informatization')
  assert.strictEqual(detectPackKey('政府采购与货物服务'), 'gov_procurement')
  assert.strictEqual(detectPackKey('不存在的行业'), 'construction', '未收录行业应回落 construction')
  assert.strictEqual(detectPackKey(''), 'construction', '空字符串应回落 construction')
  ok('detectPackKey 已收录映射 + 未收录/空字符串回落 construction')
}

function testDetectIndustryEmpty() {
  const r1 = detectIndustry('')
  assert.strictEqual(r1.name, '未识别')
  assert.strictEqual(r1.confidence, 0)
  assert.deepStrictEqual(r1.matched_keywords, [])
  assert.deepStrictEqual(r1.matches, {})
  assert.strictEqual(r1.pack_key, 'construction')
  const r2 = detectIndustry('   \n\t  ')
  assert.strictEqual(r2.name, '未识别')
  ok('空文本/空白文本识别为未识别（confidence=0, matched_keywords=[], matches={}）')
}

function testDetectIndustryNoMatch() {
  const r = detectIndustry('今天天气不错，适合出去走走。')
  assert.strictEqual(r.name, '未识别')
  assert.strictEqual(r.confidence, 0)
  assert.deepStrictEqual(r.matched_keywords, [])
  assert.deepStrictEqual(r.matches, {})
  ok('无关文本识别为未识别')
}

function testDetectIndustrySingleKeyword() {
  const r = detectIndustry('光伏')
  assert.strictEqual(r.name, '新能源', `应识别为新能源，实际 ${r.name}`)
  assert.strictEqual(r.pack_key, 'new_energy')
  assert.ok(r.confidence > 0)
  assert.ok(r.matched_keywords.includes('光伏'))
  assert.deepStrictEqual(r.matches, { '新能源': 1 })
  ok(`单关键词命中：光伏 -> 新能源（pack_key=new_energy, confidence=${r.confidence}）`)
}

function testDetectIndustryConfidenceExact() {
  // 新能源 14 个关键词，命中 1 个 -> confidence = round(1/14 * 100)/100
  const total = industryData['新能源'].keywords.length
  const r = detectIndustry('光伏')
  const expect = Math.round((1 / total) * 100) / 100
  assert.strictEqual(r.confidence, expect, `confidence 应 ${expect}，实际 ${r.confidence}`)
  ok(`confidence 精确值：${1}/${total} = ${expect}`)
}

function testDetectIndustryMultiIndustryRank() {
  // 建筑工程命中 3（房建、住宅、办公楼），新能源命中 1（光伏）-> 高分胜出
  const r = detectIndustry('房建 住宅 办公楼 光伏')
  assert.strictEqual(r.name, '建筑工程', `高分行业应胜出，实际 ${r.name}`)
  assert.strictEqual(r.pack_key, 'construction')
  assert.ok(r.matches['建筑工程'] >= 3, '建筑工程应命中 >=3')
  assert.ok(r.matches['新能源'] >= 1, '新能源应命中 >=1')
  ok('多行业命中排序：高分行业胜出（score > bestScore 分支）')
}

function testDetectIndustryTieRank() {
  // 建筑工程命中 1（房建），市政命中 1（给排水），平分 -> 先遇到的建筑工程胜出
  const r = detectIndustry('房建 给排水')
  assert.strictEqual(r.name, '建筑工程', `平分时应选先遇到的行业，实际 ${r.name}`)
  assert.ok(r.matches['建筑工程'] >= 1)
  assert.ok(r.matches['市政道路与给排水'] >= 1)
  ok('平分命中：先遇到的行业胜出（score === bestScore && !best 分支）')
}

function testDetectIndustryMatchedKeywordsTrunc12() {
  // 拼接所有行业所有关键词，命中数 >> 12，matched_keywords 截断到 12
  const allKws = []
  for (const k of Object.keys(industryData)) {
    if (k.startsWith('_')) continue
    allKws.push(...(industryData[k].keywords || []))
  }
  const r = detectIndustry(allKws.join(' '))
  assert.ok(r.matched_keywords.length <= 12, `matched_keywords 应 <=12，实际 ${r.matched_keywords.length}`)
  assert.strictEqual(r.matched_keywords.length, 12, `命中充足时应截断到 12，实际 ${r.matched_keywords.length}`)
  assert.ok(Object.keys(r.matches).length >= 11, `matches 应含多行业，实际 ${Object.keys(r.matches).length}`)
  ok(`matched_keywords 截断到 12（push 上限 20 + slice(0,12)），matches 含 ${Object.keys(r.matches).length} 行业`)
}

function testDetectIndustryMatchedKeywordsCap20() {
  // 单行业命中 15 词（建筑工程），push 15 (<20)，slice(0,12) = 12
  const kws = industryData['建筑工程'].keywords
  const r = detectIndustry(kws.join(' '))
  assert.strictEqual(r.matched_keywords.length, 12, `单行业命中 15 应截断到 12，实际 ${r.matched_keywords.length}`)
  assert.ok(r.name !== '未识别', '应识别出行业')
  ok('单行业命中 15 词：matched_keywords 截断到 12')
}

function testDetectIndustryPackKeyMapping() {
  const r = detectIndustry('水库除险加固 堤防')
  assert.strictEqual(r.name, '水利水电')
  assert.strictEqual(r.pack_key, 'water')
  ok('识别水利水电 -> pack_key=water')
}

async function main() {
  testAllIndustryNames()
  testPackKeyMapping()
  testDetectPackKey()
  testDetectIndustryEmpty()
  testDetectIndustryNoMatch()
  testDetectIndustrySingleKeyword()
  testDetectIndustryConfidenceExact()
  testDetectIndustryMultiIndustryRank()
  testDetectIndustryTieRank()
  testDetectIndustryMatchedKeywordsTrunc12()
  testDetectIndustryMatchedKeywordsCap20()
  testDetectIndustryPackKeyMapping()
  console.log(`\n[UNIT-INDUSTRY] 单元测试通过：${passed} 项 ALL PASS`)
}

main().catch((e) => {
  console.error('\n[UNIT-INDUSTRY] 测试失败:', e && e.message ? e.message : e)
  process.exit(1)
})