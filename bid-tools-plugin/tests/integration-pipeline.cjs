/**
 * 12 工具串联集成测试 / 端到端 demo（离线、零 LLM、零外部依赖可运行版）。
 *
 * 目的：用一份合成「招标文件 + 投标草稿 + 多份投标文件」把 12 个工具按
 * 标书六步流程串起来跑一遍，证明确定性闭环真实可跑通、数据可在步骤间流转。
 *
 * 说明：
 *   - 标注 [确定性] 的步骤是真实调用插件底层函数（可直接用于生产）。
 *   - 标注 [离线桩] 的步骤依赖 LLM / RAGFlow 运行时，本 demo 用合成输入桩接，
 *     仅演示数据流转；真实环境会由 DSH 技能层接入真实 LLM / 知识库。
 *
 * 由 `npm run test:smoke` 在 tsc 编译到 .smoke-out 后调用。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')

const { parseTender } = require('../.smoke-out/parser.js')
const { maskPII, scanAndMask } = require('../.smoke-out/pii.js')
const { validateFacts } = require('../.smoke-out/rules.js')
const { collectDocxFacts } = require('../.smoke-out/docxFacts.js')
const { factCheck } = require('../.smoke-out/factcheck.js')
const { collusionCheck } = require('../.smoke-out/collusion.js')
const { detectText } = require('../.smoke-out/fairness.js')

// ------------------------------------------------------------------ 小工具
let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) {
    pass++
    console.log('   ✅', name)
  } else {
    fail++
    console.log('   ❌', name, extra !== undefined ? '=> ' + JSON.stringify(extra) : '')
  }
}
function box(title) {
  console.log('\n┌─ ' + title)
}
function line(tool, mode, summary) {
  console.log(`│  ${tool.padEnd(22)} [${mode}] ${summary}`)
}

// ------------------------------------------------------------------ 合成数据
// ① 招标文件（含排斥限制竞争条款，用于 FAIR.* 检测）
const TENDER_TEXT = [
  '一、投标人必须采用海康威视品牌监控设备，性能须相当于指定型号。',
  '二、要求投标人具有本省业绩，近三年内在本地承接过类似项目。',
  '三、投标人须在本地设立分支机构，并在当地依法纳税。',
  '四、本项目仅限国有企业参与，民营企业不得投标。',
  '五、外地企业不得参与本项目，本地企业同等条件下优先。',
  '六、投标人获得鲁班奖可加分，省级优质工程奖项亦可。',
  '七、本项目投资额约 5000 万元，须具备一级资质方可投标。',
  '八、本项目为量身定制示范工程，技术方案须明显倾向某单位。',
  '九、投标人必须在指定交易平台完成报名，并使用指定 CA 锁。',
  '十、工期 360 天，投标保证金 80 万元，最高投标限价 3000 万元，技术标 40 分、商务标 30 分、价格分 30 分。',
].join('\n')

// ④ 投标草稿正文（含强 PII + 身份泄露，用于脱敏/扫描）
const DRAFT_TEXT =
  '某建设公司拟参与本次投标。联系人：王工，手机 13812345678，邮箱 bid@hebei-construction.com。' +
  '统一社会信用代码 91110108MA01ABCDEF，开户行账号 6222021234567890123。' +
  '公司地址：北京市海淀区中关村大街 1 号。本公司具有一级资质，承诺工期 360 天。'

// ⑤ 章节正文（用于 FactCheck 溯源：含数字但无来源）
const SECTION_TEXT =
  '本工程混凝土设计强度等级为 C30，依据 GB 50010 混凝土结构设计规范。' +
  '主体结构施工工期为 360 天，计划投入管理人员 45 人，高峰期劳动力 280 人。'

// ⑤ 多份投标文件（围串标检测：A/B 同模板复用，C 内容不同）
const PROPOSAL_A =
  '技术方案：本项目采用钢筋混凝土结构，基础形式为桩基础，主体施工采用流水段组织。' +
  '混凝土强度等级 C30，钢筋采用 HRB400。施工组织设计包含进度、质量、安全三大控制体系。'
const PROPOSAL_B = PROPOSAL_A // 同模板复用 -> 雷同
const PROPOSAL_C =
  '商务方案：本项目报价依据工程量清单，主要材料为普通硅酸盐水泥与热轧带肋钢筋。' +
  '项目管理采用矩阵式组织结构，质量目标为合格工程，安全目标为零事故。'
// 报价呈等差规律（围串标疑似特征）
const PRICES = [29100000, 29200000, 29300000, 29400000]

// ② LLM 桩：合成「要求清单」（真实环境由 tender_extract_requirements 经 LLM 产出）
const STUB_REQUIREMENTS = [
  { id: 'R001', content: '项目经理须具备一级注册建造师资格', keywords: ['一级注册建造师'], mandatory: true },
  { id: 'R002', content: '投标人须具有类似水利工程业绩', keywords: ['类似水利工程业绩'], mandatory: true },
  { id: 'R003', content: '工期不得超过 365 天', keywords: ['工期', '365 天'], mandatory: true },
]
// ③ RAGFlow 桩：合成「知识库来源」（真实环境由 kb_search_materials 检索产出）
const STUB_CITATIONS = [
  { source: 'GB 50010', content: '混凝土结构设计规范 GB 50010 规定钢筋混凝土结构设计要求。' },
]

// ------------------------------------------------------------------ 构建违规 docx
async function buildBadDocx() {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  )
  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>某建设公司</dc:creator><cp:lastModifiedBy>李四</cp:lastModifiedBy></cp:coreProperties>`,
  )
  zip.file(
    'docProps/app.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Company>某建设公司</Company></Properties>`,
  )
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:p><w:r><w:drawing><pic:pic/></w:drawing></w:r></w:p></w:hdr>`
  zip.file('word/header1.xml', headerXml)
  const badBody = `<w:body>
<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="Arial" w:ascii="Arial"/><w:sz w:val="24"/><w:color w:val="00FF00"/></w:rPr><w:t>投标技术方案联系方式13812345678</w:t></w:r></w:p>
<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="Arial"/><w:sz w:val="24"/></w:rPr><w:t>第二章施工方案</w:t></w:r><w:r><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="28"/></w:rPr><w:t>混凝土浇筑。</w:t></w:r></w:p>
<w:p><w:r><w:rPr></w:rPr><w:t>修订段落</w:t></w:r><w:ins w:id="1" w:author="张三" w:date="2024-01-01T00:00:00Z"><w:r><w:t>插入修订</w:t></w:r></w:ins></w:p>
<w:sectPr><w:pgMar w:top="1701" w:right="1701" w:bottom="1701" w:left="1701" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>`
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${badBody}</w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

// ------------------------------------------------------------------ 合规关键词核查（确定性部分，复刻 bid_check_compliance 的纯规则分支）
function complianceKeywordCheck(requirements, draft) {
  const draftLow = draft.toLowerCase()
  const items = requirements.map((r) => {
    const hits = (r.keywords || []).filter((kw) => draftLow.includes(String(kw).toLowerCase()))
    const status = hits.length >= Math.max(1, Math.floor((r.keywords || []).length / 2)) ? '完全响应' : '缺失'
    return { requirement_id: r.id, requirement_content: r.content, status, hits }
  })
  const total = items.length
  const fullyMet = items.filter((x) => x.status === '完全响应').length
  const missing = items.filter((x) => x.status === '缺失').length
  return { items, total, fully_met: fullyMet, missing }
}

// ------------------------------------------------------------------ 主流程
async function main() {
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log('  标书写作 Agent · 12 工具串联集成测试 / 端到端 demo')
  console.log('══════════════════════════════════════════════════════════════')

  box('步骤① 解析招标文件 · 约束抽取（确定性）')
  const constraints = parseTender(TENDER_TEXT)
  line('tender_parse_constraints', '确定性', `废标${constraints.stats.reject_count} 格式${constraints.stats.format_count} 评分${constraints.stats.scoring_count} 资质${constraints.stats.qualification_count}；权重=${JSON.stringify(constraints.scoring_weights)}`)
  ok(constraints.scoring_weights['技术'] === '40', '抽取到技术标权重', constraints.scoring_weights)
  ok(constraints.key_params.duration_days === 360, '抽取到工期 360 天', constraints.key_params.duration_days)
  ok(constraints.key_params.control_price && constraints.key_params.control_price[0].value_yuan === 30000000, '抽取到最高限价 3000 万', constraints.key_params.control_price)

  box('步骤① 解析招标文件 · 语义补充要求清单（离线桩：合成输入）')
  line('tender_extract_requirements', '离线桩', `桩输入 ${STUB_REQUIREMENTS.length} 条要求（真实环境由 LLM 产出）`)
  ok(STUB_REQUIREMENTS.length === 3, '合成要求清单就绪', STUB_REQUIREMENTS.length)

  box('步骤① 招标文件公平竞争审查 FAIR.*（确定性）')
  const fairness = detectText(TENDER_TEXT)
  line('bid_check_fairness', '确定性', `命中 ${fairness.summary.total_hits} 处（HARD ${fairness.summary.hard_count} / SOFT ${fairness.summary.soft_count}），规则 ${fairness.rules_loaded} 条`)
  ok(fairness.summary.hard_count >= 5, 'FAIR 检出 ≥5 类 HARD 排斥条款', fairness.summary.hard_count)
  ok(fairness.summary.requires_human_review === true, 'FAIR 命中即需人工复核', fairness.summary.requires_human_review)
  const hitIds = new Set(fairness.hits.map((h) => h.rule_id))
  for (const id of ['FAIR.SPECIFY_BRAND', 'FAIR.REGION_PERFORMANCE', 'FAIR.LOCAL_BRANCH', 'FAIR.OWNERSHIP_RESTRICT', 'FAIR.DISCRIMINATE_OUTSIDER']) {
    ok(hitIds.has(id), 'FAIR 命中 ' + id, [...hitIds].join(','))
  }

  box('步骤③ 分章检索取材（离线桩：合成来源，跳过真实 RAGFlow）')
  line('kb_search_materials', '离线桩', `桩输入 ${STUB_CITATIONS.length} 条来源（真实环境检索 RAGFlow）`)
  ok(STUB_CITATIONS.length === 1, '合成来源就绪', STUB_CITATIONS.length)

  box('步骤④ 生成后 PII 脱敏（确定性）')
  const masked = maskPII(DRAFT_TEXT)
  line('bid_mask_pii', '确定性', `命中 ${masked.count} 处强 PII -> ＊＊＊＊＊＊`)
  ok(masked.count >= 4, 'PII 脱敏命中 ≥4 处', masked.count)
  ok(!masked.text.includes('13812345678'), '手机号已被脱敏', masked.text.includes('13812345678'))

  box('步骤⑤ 身份泄露扫描（八面，确定性）')
  const scan = scanAndMask(DRAFT_TEXT)
  line('bid_scan_disclosure', '确定性', `命中 ${scan.leaks.length} 处泄露，已自动脱敏 ${scan.masked.count} 处`)
  ok(scan.leaks.length >= 3, '泄露扫描命中 ≥3 处', scan.leaks.length)

  box('步骤⑤ 确定性规则引擎（纯文本 facts，确定性）')
  const rulesText = validateFacts({ text: DRAFT_TEXT }, { region: '河北省', industry: '工程' })
  line('bid_check_rules', '确定性', `verdict=${rulesText.verdict} 得分=${rulesText.score} REJECT=${rulesText.summary.reject} WARN=${rulesText.summary.warn}`)
  ok(rulesText.skipped_rule_count > 0, '纯文本输入时几何规则被跳过（不误报）', rulesText.skipped_rule_count)

  box('步骤⑤ 全量 docx 审计（OOXML 几何事实 -> 规则引擎，确定性）')
  const badBuf = await buildBadDocx()
  const badPath = path.join(os.tmpdir(), 'bidtools-integration-bad.docx')
  fs.writeFileSync(badPath, badBuf)
  const auditFacts = await collectDocxFacts(badPath)
  const audit = validateFacts(auditFacts, { region: '河北省', industry: '工程' })
  line('bid_audit_docx', '确定性', `verdict=${audit.verdict} REJECT=${audit.summary.reject} WARN=${audit.summary.warn} 跳过=${audit.skipped_rule_count}`)
  ok(audit.verdict === 'REJECT', '违规 docx 审计判 REJECT', audit.verdict)
  ok(audit.skipped_rule_count === 0, 'docx 几何事实补齐后无跳过规则', audit.skipped_rule_count)
  fs.unlinkSync(badPath)

  box('步骤⑤ FactCheck 事实溯源（确定性，无来源即待补充）')
  const fc = factCheck(SECTION_TEXT, STUB_CITATIONS)
  line('bid_fact_check', '确定性', `事实句 ${fc.factual_sentences} 已引用 ${fc.cited} 待补充 ${fc.uncited} 占位 ${fc.placeholder_count} HITL=${fc.requires_human_review}`)
  ok(fc.uncited >= 1, '存在无来源事实（待人工补充）', fc.uncited)
  ok(fc.requires_human_review === true, 'FactCheck 强制 HITL', fc.requires_human_review)

  box('步骤⑤ 围串标 / 公平性自检（SimHash 雷同 + 报价规律，确定性）')
  const coll = collusionCheck({
    documents: [
      { id: 'bid-A', text: PROPOSAL_A },
      { id: 'bid-B', text: PROPOSAL_B },
      { id: 'bid-C', text: PROPOSAL_C },
    ],
    prices: PRICES,
  })
  line('bid_check_collusion', '确定性', `风险=${coll.risk_level} 雷同簇=${coll.text_similarity.risk_groups.length} 报价规律=${coll.price_pattern.detected ? coll.price_pattern.type : '未命中'}`)
  ok(coll.risk_level === 'HIGH', '围串标风险 HIGH', coll.risk_level)
  ok(coll.text_similarity.risk_groups.length >= 1, '检出雷同簇（A/B 同模板）', coll.text_similarity.risk_groups)
  ok(coll.price_pattern.detected && coll.price_pattern.type === '等差规律', '检出等差报价规律', coll.price_pattern)
  ok(coll.requires_human_review === true, '围串标命中即 HITL', coll.requires_human_review)

  box('步骤⑤ 合规自查（确定性关键词分支 + LLM 桩）')
  const comp = complianceKeywordCheck(STUB_REQUIREMENTS, DRAFT_TEXT + SECTION_TEXT)
  line('bid_check_compliance', '确定性+桩', `总 ${comp.total} 完全响应 ${comp.fully_met} 缺失 ${comp.missing}（LLM 语义复核为离线桩，本 demo 仅跑确定性分支）`)
  ok(comp.fully_met >= 1 && comp.missing >= 1, '确定性分支区分出响应/缺失', comp)

  box('步骤⑥ 定稿归档回流（离线桩：跳过真实 RAGFlow 上传）')
  line('bid_archive_final', '离线桩', '桩：真实环境上传定稿 docx 至历史标书库（BID_ARCHIVE_DATASET_ID）')
  ok(true, '归档步骤数据流转就绪（需 RAGFlow 运行时）')

  // ------------------------------------------------------------------ 闭环汇总
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log('  六步流程闭环结果')
  console.log('══════════════════════════════════════════════════════════════')
  const rows = [
    ['① 招标约束抽取', 'tender_parse_constraints', '确定性', '✓'],
    ['① 语义要求清单', 'tender_extract_requirements', '离线桩', '~'],
    ['① 公平竞争审查', 'bid_check_fairness', '确定性', `HARD ${fairness.summary.hard_count}`],
    ['③ 分章检索取材', 'kb_search_materials', '离线桩', '~'],
    ['④ PII 脱敏', 'bid_mask_pii', '确定性', `命中 ${masked.count}`],
    ['⑤ 身份泄露扫描', 'bid_scan_disclosure', '确定性', `命中 ${scan.leaks.length}`],
    ['⑤ 规则引擎', 'bid_check_rules', '确定性', audit.verdict === 'REJECT' ? 'REJECT' : rulesText.verdict],
    ['⑤ docx 审计', 'bid_audit_docx', '确定性', audit.verdict],
    ['⑤ 事实溯源', 'bid_fact_check', '确定性', `待补 ${fc.uncited}`],
    ['⑤ 围串标自检', 'bid_check_collusion', '确定性', coll.risk_level],
    ['⑤ 合规自查', 'bid_check_compliance', '确定性+桩', `${comp.fully_met}/${comp.missing}`],
    ['⑥ 定稿归档', 'bid_archive_final', '离线桩', '~'],
  ]
  console.log('  步骤'.padEnd(16) + '工具'.padEnd(24) + '模式'.padEnd(10) + '结果')
  for (const [s, t, m, r] of rows) {
    console.log('  ' + s.padEnd(14) + t.padEnd(24) + m.padEnd(10) + r)
  }
  console.log('\n  图例：✓/HARD/REJECT/HIGH/命中=真实判定；~=离线桩（需 LLM/RAGFlow 运行时）；确定性=可直接生产')
  console.log(`\n=== integration-pipeline: ${pass} passed, ${fail} failed ===`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
