/**
 * 确定性模块回归测试（AIBidForge 移植资产的行为门禁）。
 *
 * 运行：npm run test:smoke
 * 说明：先把 src 下的确定性模块编译到 .smoke-out（CommonJS），再对本文件断言。
 *      因为插件 package.json 是 "type": "module"，编译产物需显式标记为 commonjs，
 *      故在首个 require 之前写入 .smoke-out/package.json。
 */
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, '..', '.smoke-out')
fs.writeFileSync(path.join(OUT, 'package.json'), '{"type":"commonjs"}')

const { parseTender } = require(path.join(OUT, 'parser.js'))
const { maskPII, scanDisclosure, scanAndMask, PLACEHOLDER } = require(path.join(OUT, 'pii.js'))
const { validateFacts, listTemplates } = require(path.join(OUT, 'rules.js'))
const { factCheck } = require(path.join(OUT, 'factcheck.js'))

let fail = 0
function ok(cond, label, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) fail++
}

// ---------- 1. 招标约束抽取（纯正则，零 LLM） ----------
console.log('--- 1. tender_parse_constraints ---')
const tender = `
本次招标采用综合评估法。技术标 30 分，商务标 20 分，价格分 50 分。
工期要求 180 日历天。投标保证金 20 万元。最高投标限价 1500 万元。
投标人须具备水利水电工程施工总承包一级资质，具有类似业绩。
有下列情形之一的，其投标将被否决投标资格：逾期送达的投标文件；未按要求密封的。
投标文件技术暗标正文须使用宋体四号字，行距固定值 30 磅，不得出现投标人单位名称。
`
const r1 = parseTender(tender)
ok(r1.stats.reject_count >= 1, '废标条款抽取', `reject=${r1.stats.reject_count}`)
ok(r1.stats.format_count >= 1, '格式条款抽取', `format=${r1.stats.format_count}`)
ok(r1.stats.scoring_count >= 1, '评分条款抽取', `scoring=${r1.stats.scoring_count}`)
ok(r1.stats.qualification_count >= 1, '资质条款抽取', `qual=${r1.stats.qualification_count}`)
ok(r1.scoring_weights['技术'] === '30', '技术评分权重=30', JSON.stringify(r1.scoring_weights))
ok(r1.key_params.duration_days === 180, '工期=180天')
ok(r1.key_params.bid_bond && r1.key_params.bid_bond[0].value_yuan === 200000, '保证金=200000元')
ok(r1.key_params.control_price && r1.key_params.control_price[0].value_yuan === 15000000, '限价=15000000元')

// ---------- 2. PII 脱敏 ----------
console.log('--- 2. bid_mask_pii ---')
const r2 = maskPII('联系人手机 13812345678，邮箱 test@corp.com，代码 91110108MA01ABCD2X，账户 6222021234567890123')
ok(r2.count === 4, '命中 4 类 PII', JSON.stringify(r2.matches.map((m) => m.type)))
ok(!r2.text.includes('13812345678') && r2.text.includes(PLACEHOLDER), '手机号已替换为占位符', r2.text)
ok(r2.matches.some((m) => m.type === '银行账号'), '19 位纯数字银行账号被正确识别（未被信用代码正则吃掉）')
ok(r2.matches.some((m) => m.type === '统一社会信用代码'), '统一社会信用代码被正确识别')
ok(!/\d{4,}/.test(r2.text), '脱敏后无残留长数字', r2.text)

// ---------- 3. 身份泄露扫描（八面） ----------
console.log('--- 3. bid_scan_disclosure ---')
const leakText = '本项目由北京华源水利建设集团有限公司承建，项目经理：张三，联系电话 13900001111。'
const r3 = scanDisclosure(leakText)
const ids = [...new Set(r3.leaks.map((l) => l.rule_id))]
ok(ids.includes('LEAK.COMPANY_NAME'), '命中单位名称泄露', ids.join(','))
ok(ids.includes('LEAK.MOBILE'), '命中手机号泄露')
ok(r3.leaks.every((l) => l.suggestion && l.suggestion.length > 0), '每条命中都带修复建议')
const r3m = scanAndMask(leakText)
ok(!r3m.masked.text.includes('13900001111'), 'auto_mask 已脱敏手机号', r3m.masked.text)

// ---------- 4. 确定性规则引擎 ----------
console.log('--- 4. bid_check_rules ---')
const facts = {
  text: '投标人联系方式 13812345678，邮箱 a@b.com。',
  metadata: { creator: 'python-docx', lastModifiedBy: '张三', company: '某某公司' },
  marks: { revisions: 3, comments: 0, hidden_text: 1, rsid_count: 0 },
  images: [{ has_exif: true, color_space: 'rgb' }],
}
const v = validateFacts(facts, { region: '河北省', industry: '工程', tender_type: '工程' })
ok(v.verdict === 'REJECT', '判定为 REJECT', `score=${v.score}`)
const vf = [...new Set(v.findings.map((f) => f.rule_id))]
ok(vf.includes('LEAK.MOBILE'), '正文手机号命中')
ok(vf.includes('META.CREATOR'), 'creator=python-docx 命中')
ok(vf.includes('META.COMPANY'), 'company 非空命中')
ok(vf.includes('META.REVISIONS'), '修订痕迹命中')
ok(vf.includes('META.HIDDEN_TEXT'), '隐藏文字命中')
ok(vf.includes('IMG.EXIF') || vf.includes('IMG.COLOR'), '图片元数据/彩色命中')
ok(v.skipped_rule_count > 0, '几何类规则静默跳过（不误判）', `skipped=${v.skipped_rule_count}`)
const clean = validateFacts({ text: '本项目按规范施工。', metadata: { creator: 'bidforge', company: '' } })
ok(clean.verdict !== 'REJECT', '干净文档不误报 REJECT', `verdict=${clean.verdict} score=${clean.score}`)

// ---------- 5. FactCheck 事实溯源 ----------
console.log('--- 5. bid_fact_check ---')
const section =
  '本工程按 SL 303-2017 施工导流标准执行，洪水标准为 20 年一遇。混凝土内外温差控制在 25 ℃以内，降温速率不大于 2 ℃/d。本章依据招标文件编制。'
const citations = [{ source: 'SL 303-2017 施工组织设计', content: '导流标准 20 年一遇洪水' }]
const r5 = factCheck(section, citations)
ok(r5.factual_sentences >= 2, '识别事实句', `factual=${r5.factual_sentences}`)
ok(r5.cited >= 1, '有来源的事实句识别为已引用', `cited=${r5.cited}`)
ok(r5.uncited >= 1, '无来源的事实句标为待人工补充', `uncited=${r5.uncited}`)
ok(r5.requires_human_review === true, '强制 HITL 标志')
const r5b = factCheck('本单位名称以 ＊＊＊＊＊＊ 代替，按规范施工。')
ok(r5b.placeholder_count === 1, '占位符统计正确', `count=${r5b.placeholder_count}`)

// ---------- 6. 规则包加载 ----------
console.log('--- 6. 规则包与行业包 ---')
const tpls = listTemplates()
ok(tpls.some((t) => t.template_id === 'common-disclosure-v1' && t.status === 'ACTIVE'), 'common_disclosure 始终生效')
ok(tpls.filter((t) => t.template_id !== 'common-disclosure-v1').length === 4, '4 个河北地域暗标模板已加载')
const water = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'industries', 'water.json'), 'utf8'))
ok(water.outline.length === 12, '水利包 12 章节大纲', `outline=${water.outline.length}`)
ok(water.regulations.some((r) => r.doc_no.includes('SL 303')), '水利包含 SL 303 规范')
ok(water.score_points.length >= 5, '水利包含评分点', `score_points=${water.score_points.length}`)

console.log(`\n=== ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
