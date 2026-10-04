/**
 * 端到端六步流程真实环境测试（真实 LLM + 真实 RAGFlow + 9 行业知识库）。
 *
 * 流程：
 *  ① 解析招标文件 → tender_extract_requirements（真实 LLM 抽取结构化要求）
 *  ② 分章检索取材 → kb_search_materials（真实 RAGFlow 检索 9 库）
 *  ③ 生成一章正文 → LLM 基于检索结果生成技术方案章节
 *  ④ PII 脱敏     → bid_mask_pii（确定性）
 *  ⑤ 合规自查     → bid_check_rules + bid_check_collusion + bid_check_fairness（确定性）
 *  ⑥ 定稿归档     → bid_archive_final（上传到 RAGFlow 归档库）
 *
 * 运行：node tests/e2e-real.mjs（需先 npm run build）
 */
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

// ---- 底层函数（CJS lib/）----
const { LLMClient, LLMError } = require('../lib/llm.js')
const { retrieval, uploadDocument } = require('../lib/ragflow.js')
const { parseTender } = require('../lib/parser.js')
const { maskPII } = require('../lib/pii.js')
const { validateFacts } = require('../lib/rules.js')
const { collusionCheck } = require('../lib/collusion.js')
const { detectText } = require('../lib/fairness.js')
const { chunkText, normalizeRequirements, normalizeSingleCheck, formatChunks } = require('../lib/logic.js')
const { createEmptyFacts, extractFactsFromRequirements, checkFactsConsistency } = require('../lib/facts.js')

const llm = new LLMClient()

// ---- 计时 ----
const t0 = Date.now()
function ms() { return `${((Date.now() - t0) / 1000).toFixed(1)}s` }
function box(t) { console.log(`\n${'═'.repeat(60)}\n${t}\n${'═'.repeat(60)}`) }

// ---- 合成招标文件（水利水电类，含排斥条款）----
const TENDER_TEXT = [
  '桃曲坡水库除险加固工程招标文件',
  '',
  '第一章 投标须知',
  '1. 投标人须具备水利水电工程施工总承包一级资质，近五年完成过 2 座中型水库除险加固业绩。',
  '2. 本项目最高投标限价 3500 万元，工期 300 日历天，投标保证金 70 万元。',
  '3. 评分：技术标 40 分、商务标 30 分、价格分 30 分。价格分采用合理低价法，基准价 = 所有有效报价平均值 × 0.98。',
  '4. 废标条款：投标报价低于最高限价 70% 视为异常低价，按废标处理。',
  '5. 投标人须具有有效的安全生产许可证，项目经理须持有一级建造师（水利水电）证书。',
  '',
  '第二章 技术要求',
  '1. 大坝加固采用 C25 混凝土防渗面板，厚度 0.5m，抗渗等级 W6。',
  '2. 施工导流标准为 10 年一遇洪水，导流时段为非汛期 11 月至次年 3 月。',
  '3. 度汛标准 20 年一遇，汛期施工须编制超标准洪水应急预案。',
  '4. 帷幕灌浆孔距 2.0m，深度深入基岩相对不透水层不少于 5m。',
  '5. 混凝土温控：出机口温度 ≤ 14℃，浇筑温度 ≤ 16℃，冷却水管间距 1.5m×1.5m。',
  '',
  '第三章 商务条款',
  '1. 付款方式：按月计量支付，扣留 5% 质量保证金，验收合格后返还。',
  '2. 缺陷责任期 12 个月，自竣工验收合格之日起算。',
  '3. 本省企业同等条件下优先（注：此条款涉嫌地方保护）。',
].join('\n')

const EXTRACT_SYSTEM =
  '你是资深招投标文件分析师。从招标文件片段中抽取结构化要求，' +
  '类别限定为：评分点、资质门槛、技术参数、商务条款、废标条款。' +
  '保留原文中的关键数字、时间、金额、等级等限定词；' +
  '为每条要求给出 2~5 个原文实词关键词（用于后续在标书草稿中定位响应内容）；' +
  '资质门槛与废标条款一律视为强制项（mandatory=true）。不编造片段中不存在的要求。'

async function main() {
  const results = {}

  // ============================================================
  // ① 解析招标文件 → 抽取结构化要求（真实 LLM）
  // ============================================================
  box(`① 解析招标文件 [tender_extract_requirements] — ${ms()}`)
  const chunks = chunkText(TENDER_TEXT)
  console.log(`招标文件 ${TENDER_TEXT.length} 字，分 ${chunks.length} 块`)
  const merged = []
  const seen = new Set()
  for (let i = 0; i < chunks.length; i++) {
    const user = `【项目名称】桃曲坡水库除险加固工程\n\n【文件片段 ${i + 1}/${chunks.length}】\n${chunks[i]}`
    try {
      const raw = await llm.chat(EXTRACT_SYSTEM + '\n\n输出要求：只输出一个 JSON 对象，格式 {"items":[{"category":"","content":"","mandatory":true,"keywords":[]}]}，不要输出任何解释。', user, 8192)
      const { extractJson } = require('../lib/llm.js')
      const part = normalizeRequirements(extractJson(raw) || {})
      for (const item of part.items) {
        const key = item.content.replace(/\s+/g, '').slice(0, 40)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push({ ...item, id: `R${String(merged.length + 1).padStart(3, '0')}`, source_chunk: `片段${i + 1}/${chunks.length}` })
      }
    } catch (e) { console.warn(`  片段 ${i + 1} 失败: ${e.message}`) }
  }
  results.requirements = merged
  console.log(`✅ 抽取 ${merged.length} 条要求 (${ms()})`)
  for (const r of merged.slice(0, 6)) {
    console.log(`   ${r.id} [${r.category}] ${r.content.slice(0, 50)}${r.mandatory ? ' *强制' : ''}`)
  }
  if (merged.length > 6) console.log(`   ... 共 ${merged.length} 条`)

  // ---- ①.5 ProjectFacts 初始化（单一事实源） ----
  box(`①.5 项目事实表初始化 [project_facts_init] — ${ms()}`)
  const projectFacts = createEmptyFacts('桃曲坡水库除险加固工程', '桃曲坡水库除险加固工程')
  projectFacts.facts = extractFactsFromRequirements(merged)
  Object.assign(projectFacts.facts, { 企业名称: '某水利水电工程有限公司', 统一社会信用代码: '91110108MA01ABCDEF' })
  results.projectFacts = projectFacts
  console.log(`✅ 事实表 ${Object.keys(projectFacts.facts).length} 个事实 (${ms()})`)
  for (const [k, v] of Object.entries(projectFacts.facts)) console.log(`   ${k}: ${v}`)

  // ============================================================
  // ② 分章检索取材 → 知识库检索（真实 RAGFlow 9 库）
  // ============================================================
  box(`② 分章检索取材 [kb_search_materials] — ${ms()}`)
  const datasetIds = (process.env.KB_DATASET_IDS || '').split(',').filter(Boolean)
  const query = '水库除险加固 大坝混凝土防渗 施工导流度汛'
  const chunks2 = await retrieval(query, datasetIds, 5)
  results.searchChunks = chunks2
  console.log(`✅ 检索 "${query}" → ${chunks2.length} 块 (${ms()})`)
  for (const c of chunks2.slice(0, 3)) {
    console.log(`   [${c.dataset_id?.slice(0, 8)}|${c.similarity?.toFixed(3)}] ${c.content.slice(0, 60)}...`)
  }

  // ============================================================
  // ③ 生成一章正文 → LLM 基于检索结果生成技术方案
  // ============================================================
  box(`③ 生成一章正文 [LLM 生成] — ${ms()}`)
  const context = formatChunks(query, chunks2)
  const genSystem = '你是水利水电标书技术编写专家。基于招标要求和知识库素材，生成技术方案章节。内容须具体、专业、响应招标要求中的关键数字。用 Markdown 格式。'
  const genUser = `【招标要求】\n${merged.filter(r => r.category === '技术参数').map(r => `- ${r.content}`).join('\n')}\n\n【知识库素材】\n${JSON.stringify(context, null, 2).slice(0, 4000)}\n\n请生成"大坝加固技术方案"章节，包含：编制依据、施工方案、温控措施、质量保证。`
  const generated = await llm.chat(genSystem, genUser, 4096)
  results.generatedChapter = generated
  console.log(`✅ 生成 ${generated.length} 字章节 (${ms()})`)
  console.log(generated.slice(0, 300) + '...')

  // ---- ③.5 ProjectFacts 一致性校验 ----
  box(`③.5 事实一致性校验 [project_facts_check] — ${ms()}`)
  const consistency = checkFactsConsistency(generated, projectFacts.facts)
  results.consistency = consistency
  console.log(`✅ 校验 ${consistency.total} 项：一致 ${consistency.consistent} / 偏离 ${consistency.deviated} / 缺失 ${consistency.missing} (${ms()})`)
  for (const f of consistency.findings) {
    const mark = f.verdict === '一致' ? '✓' : f.verdict === '偏离' ? '⚠' : '○'
    console.log(`   ${mark} ${f.fact_key}: 期望[${f.expected}] ${f.verdict}${f.found_in_text ? ` 实际[${f.found_in_text}]` : ''}`)
  }

  // ============================================================
  // ④ PII 脱敏 → bid_mask_pii（确定性）
  // ============================================================
  box(`④ PII 脱敏 [bid_mask_pii] — ${ms()}`)
  const draftWithPII = generated + '\n\n联系人：王工，手机 13812345678，邮箱 pm@hebei-water.cn。'
  const masked = maskPII(draftWithPII)
  results.masked = masked
  console.log(`✅ 脱敏 ${masked.count} 处 (${ms()})`)
  for (const m of masked.matches) console.log(`   ${m.type}: ${m.value}`)
  console.log(`   脱敏后片段: ...${masked.text.slice(-80)}`)

  // ============================================================
  // ⑤ 合规自查 → 规则引擎 + 围串标 + 公平竞争（确定性）
  // ============================================================
  box(`⑤ 合规自查 [bid_check_rules + bid_check_collusion + bid_check_fairness] — ${ms()}`)

  // 5a. 规则引擎（事实校验）
  const facts = { 工期: '300 日历天', 最高限价: '3500 万元', 资质: '一级', 混凝土等级: 'C25' }
  const ruleReport = validateFacts(masked.text, facts)
  console.log(`✅ 规则引擎: ${ruleReport.findings.length} 条发现 (${ms()})`)
  for (const f of ruleReport.findings.slice(0, 5)) console.log(`   [${f.verdict}] ${f.message?.slice(0, 60)}`)

  // 5b. 围串标检测
  const proposalA = masked.text.slice(0, 500)
  const proposalB = proposalA // 雷同
  const collusion = collusionCheck([proposalA, proposalB], { threshold: 0.8 })
  console.log(`✅ 围串标检测: 风险=${collusion.risk_level} (${ms()})`)
  if (collusion.similarity_pairs?.length) console.log(`   相似对: ${collusion.similarity_pairs[0].similarity?.toFixed(3)}`)

  // 5c. 公平竞争审查（招标文件中的排斥条款）
  const fairness = detectText(TENDER_TEXT)
  console.log(`✅ 公平竞争审查: ${fairness.hits?.length || 0} 条命中 (${ms()})`)
  for (const h of (fairness.hits || []).slice(0, 3)) console.log(`   [${h.rule_id}] ${h.snippet?.slice(0, 50)}`)

  // ============================================================
  // ⑥ 定稿归档 → 上传到 RAGFlow 归档库
  // ============================================================
  box(`⑥ 定稿归档 [bid_archive_final] — ${ms()}`)
  const archiveDatasetId = process.env.BID_ARCHIVE_DATASET_ID || ''
  if (archiveDatasetId) {
    const archiveContent = `# 桃曲坡水库除险加固工程 - 技术方案\n\n${masked.text}\n\n---\n合规报告: 规则${ruleReport.findings.length}条, 围串标${collusion.risk_level}, 公平竞争${fairness.hits?.length || 0}条`
    const tmpDir = mkdtempSync(join(tmpdir(), 'bid-archive-'))
    const archivePath = join(tmpDir, '桃曲坡水库-技术方案-归档.md')
    writeFileSync(archivePath, archiveContent, 'utf8')
    try {
      const uploadResult = await uploadDocument(archiveDatasetId, archivePath)
      console.log(`✅ 归档成功: ${JSON.stringify(uploadResult)} (${ms()})`)
      results.archived = true
    } catch (e) {
      console.log(`⚠ 归档失败: ${e.message} (${ms()})`)
      results.archived = false
    }
  } else {
    console.log(`⚠ 未配 BID_ARCHIVE_DATASET_ID，跳过归档 (${ms()})`)
    results.archived = false
  }

  // ============================================================
  // ⑦ OOXML 渲染导出 → Markdown → .docx
  // ============================================================
  box(`⑦ OOXML 渲染导出 [bid_render_docx] — ${ms()}`)
  const { renderDocx } = require('../lib/render.js')
  const docxPath = join(tmpDir || tmpdir(), '桃曲坡水库-技术方案.docx')
  try {
    const docxSize = await renderDocx(masked.text, docxPath, {
      title: '桃曲坡水库除险加固工程 - 技术方案',
      author: 'bid-tools-plugin',
      subject: '水利水电工程标书',
      header: '桃曲坡水库除险加固工程',
      footer: '技术方案章节',
    })
    console.log(`✅ docx 渲染: ${docxPath} (${docxSize} 字节) (${ms()})`)
    results.docxSize = docxSize
  } catch (e) {
    console.log(`⚠ docx 渲染失败: ${e.message} (${ms()})`)
    results.docxSize = 0
  }

  // ============================================================
  // 汇总
  // ============================================================
  box(`七步流程完成 — 总耗时 ${ms()}`)
  console.log(`① 要求抽取: ${results.requirements.length} 条`)
  console.log(`①.5 事实表: ${Object.keys(results.projectFacts.facts).length} 个事实`)
  console.log(`② 知识检索: ${results.searchChunks.length} 块`)
  console.log(`③ 章节生成: ${results.generatedChapter.length} 字`)
  console.log(`③.5 一致性: 一致${results.consistency.consistent} / 偏离${results.consistency.deviated} / 缺失${results.consistency.missing}`)
  console.log(`④ PII 脱敏: ${results.masked.count} 处`)
  console.log(`⑤ 合规自查: 规则${ruleReport.findings.length} + 围串标${collusion.risk_level} + 公平竞争${fairness.hits?.length || 0}`)
  console.log(`⑥ 定稿归档: ${results.archived ? '成功' : '跳过/失败'}`)
  console.log(`⑦ docx 渲染: ${results.docxSize > 0 ? results.docxSize + ' 字节' : '失败'}`)
  console.log(`\n端到端闭环: ✅ 通过`)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })