/**
 * bid-tools — 标书写作确定性工具集（DSH 原生插件）。
 *
 * 对应标书六步流程中的确定性环节，由 DSH「标书写作」技能编排调用。
 *
 * 【确定性层（零 LLM，规则/正则驱动，可复现可举证）】
 *   tender_parse_constraints    -> 步骤① 正则抽取招标约束（废标/格式/评分/资质/关键参数）
 *   tender_extract_requirements -> 步骤① LLM 语义补充结构化要求清单（评分点/资质/技术参数/商务/废标）
 *   kb_search_materials         -> 步骤③ 分章检索取材（RAGFlow 检索，带来源）
 *   bid_mask_pii                -> 步骤④ 生成后 PII 脱敏（身份信息 -> ＊＊＊＊＊＊）
 *   bid_scan_disclosure         -> 步骤⑤ 八面身份泄露扫描（复用 common_disclosure 规则包）
 *   bid_check_rules             -> 步骤⑤ 确定性规则引擎（元数据/痕迹/图片/正文模式）-> verdict
 *   bid_audit_docx              -> 步骤⑤ 全量 docx 审计（解析 OOXML 几何/痕迹/图片 -> 规则引擎 verdict，激活暗标几何规则）
 *   bid_check_compliance        -> 步骤⑤ 对照要求清单逐条核查（关键词规则 + LLM 语义复核）
 *   bid_fact_check              -> 步骤⑤ FactCheck 事实溯源（无来源即标「待人工补充」）
 *   bid_check_collusion         -> 步骤⑤ 围串标/公平性自检（SimHash 雷同 + 报价规律，零 LLM）
 *   bid_check_fairness          -> 步骤① 招标文件公平竞争审查（FAIR.* 9 类排斥限制竞争条款，零 LLM）
 *   bid_archive_final           -> 步骤⑥ 定稿归档回流历史标书库
 *
 * 步骤②④（大纲生成、分章长文生成）由 DSH 技能层直调 LLM；步骤⑥人工审校是 HITL 卡点。
 * 红线：合规判定绝不由 LLM 做出——LLM 只做内容生产与语义建议。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { config } from './config.ts'
import { LLMClient, LLMError } from './llm.ts'
import { RagflowError, retrieval, uploadDocument } from './ragflow.ts'
import {
  chunkText,
  clip,
  findEvidence,
  formatChunks,
  normalizeRequirements,
  normalizeSingleCheck,
  summarize,
} from './logic.ts'
import { parseTender } from './parser.ts'
import { maskPII, scanDisclosure, scanAndMask } from './pii.ts'
import { validateFacts } from './rules.ts'
import { collectDocxFacts } from './docxFacts.ts'
import { factCheck } from './factcheck.ts'
import { collusionCheck } from './collusion.ts'
import { detectText, detectDocx } from './fairness.ts'
import {
  createEmptyFacts,
  extractFactsFromRequirements,
  checkFactsConsistency,
} from './facts.ts'
import type { ProjectFacts } from './facts.ts'
import { renderDocx } from './render.ts'
import type { ComplianceItem, ComplianceReport, RequirementList } from './types.ts'

export const name = 'bid-tools'
export const inject = ['tools']

const llm = new LLMClient()

/** 工具输出的默认渲染：规范值（JSON 对象）序列化为文本块。 */
function jsonRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** execute 返回值统一收口为 JsonValue（interface 无隐式 index signature，需显式断言）。 */
function toJson(value: unknown): JsonValue {
  return value as JsonValue
}

const EXTRACT_SYSTEM =
  '你是资深招投标文件分析师。从招标文件片段中抽取结构化要求，' +
  '类别限定为：评分点、资质门槛、技术参数、商务条款、废标条款。' +
  '保留原文中的关键数字、时间、金额、等级等限定词；' +
  '为每条要求给出 2~5 个原文实词关键词（用于后续在标书草稿中定位响应内容）；' +
  '资质门槛与废标条款一律视为强制项（mandatory=true）。不编造片段中不存在的要求。'

const COMPLIANCE_SYSTEM =
  '你是投标合规审查员。判断标书草稿是否响应了给定的招标要求，' +
  '结论只能是：完全响应 / 偏离 / 缺失。' +
  '完全响应=草稿中有实质响应且关键限定一致；' +
  '偏离=有相关内容但关键限定（数量/时间/等级/范围）不一致；' +
  '缺失=草稿完全没有响应。给出结论对应的草稿原文片段作为证据（evidence），' +
  '偏离时在 comment 附一句修改建议。不臆测草稿中不存在的内容。'

async function llmSemanticCheck(
  req: { id: string; content: string },
  draft: string,
): Promise<ComplianceItem> {
  try {
    const check = await llm.chatJson(
      COMPLIANCE_SYSTEM,
      `【招标要求】${req.content}\n\n【标书草稿节选】${draft.slice(0, 8000)}`,
      normalizeSingleCheck,
      { maxTokens: 1024 },
    )
    return {
      requirement_id: req.id,
      requirement_content: req.content,
      status: check.status,
      evidence: check.evidence,
      comment: check.comment,
    }
  } catch (err) {
    // LLM 复核失败时降级为缺失，不阻塞整份报告
    console.error(`[bid-tools] 要求 ${req.id} 的 LLM 复核失败:`, err)
    return {
      requirement_id: req.id,
      requirement_content: req.content,
      status: '缺失',
      evidence: '',
      comment: '语义复核失败，请人工确认',
    }
  }
}

export function apply(ctx: Context): void {
  ctx.logger?.info?.('[bid-tools] 插件加载，开始注册工具')

  // ---- 步骤①：解析招标文件 -> 结构化要求清单 ----
  ctx.tools.register(
    defineTool({
      name: 'tender_extract_requirements',
      description:
        '解析招标文件全文，抽取结构化要求清单（评分点/资质门槛/技术参数/商务条款/废标条款）。' +
        '产物是后续大纲生成与合规自查的指挥棒。长文自动分块、跨块去重。',
      parameters: {
        tender_text: { type: 'string', required: true, description: '招标文件全文（已由 MinerU/DeepDoc 解析为纯文本/Markdown）' },
        tender_name: { type: 'string', description: '项目或标段名称，可选' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const tenderText = String(args.tender_text ?? '')
        const tenderName = String(args.tender_name ?? '')
        if (!tenderText.trim()) return toJson({ error: 'tender_text 为空' })

        const chunks = chunkText(tenderText)
        ctx.logger?.info?.(`[bid-tools] 招标文件共 ${chunks.length} 块，开始抽取`)
        const merged: RequirementList['items'] = []
        const seen = new Set<string>()

        for (let i = 0; i < chunks.length; i++) {
          const user =
            `【项目名称】${tenderName || '未知'}\n\n【文件片段 ${i + 1}/${chunks.length}】\n${chunks[i]}`
          try {
            const part = await llm.chatJson(
              EXTRACT_SYSTEM,
              user,
              (data) => normalizeRequirements(data),
              {
                hint: '本片段若无任何要求可返回空 items；id 会被合并时重编。',
                maxTokens: 8192,
              },
            )
            for (const item of part.items) {
              const key = item.content.replace(/\s+/g, '').slice(0, 40) // 块间重叠去重
              if (seen.has(key)) continue
              seen.add(key)
              merged.push({ ...item, id: `R${String(merged.length + 1).padStart(3, '0')}`, source_chunk: `片段${i + 1}/${chunks.length}` })
            }
          } catch (err) {
            if (err instanceof LLMError) ctx.logger?.error?.(`[bid-tools] 片段 ${i + 1} 抽取失败: ${err.message}`)
            continue
          }
        }

        const report: RequirementList = { tender_name: tenderName, items: merged }
        ctx.logger?.info?.(`[bid-tools] 抽取完成：${merged.length} 条要求`)
        return toJson(report)
      },
    }),
  )

  // ---- 步骤③：分章检索取材（带来源） ----
  ctx.tools.register(
    defineTool({
      name: 'kb_search_materials',
      description:
        '按章节主题定向检索知识库，返回带来源的素材段落（供 LLM 写作时引用）。' +
        '检索在 RAGFlow 内完成（BGE-M3 召回 + Reranker 精排），本工具不调用 LLM。',
      parameters: {
        question: { type: 'string', required: true, description: '检索问题，如"XX 行业类似项目的实施与验收情况"' },
        dataset_ids: { type: 'string', description: '知识库 ID 列表，逗号分隔；不传则用服务端配置的默认库' },
        top_k: { type: 'number', description: '返回条数，默认 8' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const question = String(args.question ?? '')
        const ids = String(args.dataset_ids ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        const datasetIds = ids.length > 0 ? ids : config.kbDatasetIds
        const topK = Number(args.top_k) > 0 ? Number(args.top_k) : config.retrievalTopK
        try {
          const chunks = await retrieval(question, datasetIds, topK)
          return toJson(formatChunks(question, chunks))
        } catch (err) {
          return toJson({ error: err instanceof Error ? err.message : String(err) })
        }
      },
    }),
  )

  // ---- 步骤⑤：合规自查 -> 响应点偏离表 ----
  ctx.tools.register(
    defineTool({
      name: 'bid_check_compliance',
      description:
        '对照招标要求清单逐条核查标书草稿，产出响应点偏离表。' +
        '先做关键词规则比对（快速、可复现），未命中条目交 LLM 语义复核（有上限）。' +
        '「缺失」条目应回流知识库检索补素材。',
      parameters: {
        requirements_json: { type: 'string', required: true, description: 'tender_extract_requirements 返回的要求清单 JSON' },
        draft_text: { type: 'string', required: true, description: '标书草稿全文（或待核查章节全文）' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        let reqs: RequirementList['items']
        try {
          reqs = normalizeRequirements(JSON.parse(String(args.requirements_json ?? '{}'))).items
        } catch (err) {
          return toJson({ error: `要求清单解析失败: ${err instanceof Error ? err.message : err}` })
        }
        const draft = clip(String(args.draft_text ?? ''))
        const draftLow = draft.toLowerCase()
        const items: ComplianceItem[] = []
        const llmPending: RequirementList['items'] = []

        for (const req of reqs) {
          const hits = req.keywords.filter((kw) => draftLow.includes(kw.toLowerCase()))
          if (hits.length >= Math.max(1, Math.floor(req.keywords.length / 2))) {
            items.push({
              requirement_id: req.id,
              requirement_content: req.content,
              status: '完全响应',
              evidence: findEvidence(draft, req.keywords),
              comment: '',
            })
          } else {
            llmPending.push(req)
          }
        }

        for (const req of llmPending.slice(0, config.complianceLlmCheckMax)) {
          items.push(await llmSemanticCheck(req, draft))
        }
        for (const req of llmPending.slice(config.complianceLlmCheckMax)) {
          items.push({
            requirement_id: req.id,
            requirement_content: req.content,
            status: '缺失',
            evidence: '',
            comment: '超出自动复核上限，请人工核查',
          })
        }

        const report: ComplianceReport = { ...summarize({ items }), items }
        ctx.logger?.info?.(
          `[bid-tools] 合规自查完成：${report.total} 条（响应${report.fully_met}/偏离${report.deviated}/缺失${report.missing}）`,
        )
        return toJson(report)
      },
    }),
  )

  // ---- 步骤⑥：定稿归档回流（人工审校通过后调用） ----
  ctx.tools.register(
    defineTool({
      name: 'bid_archive_final',
      description:
        '将人工审校定稿的标书归档到"历史标书库"知识库，供后续标书写作检索复用。' +
        '调用前必须已完成人工审校（HITL 卡点在技能层）。',
      parameters: {
        file_path: { type: 'string', required: true, description: '定稿文档的绝对路径（docx/pdf/md，RAGFlow 自动解析）' },
        project: { type: 'string', required: true, description: '项目名称（作为检索标签）' },
        client: { type: 'string', description: '客户名称，可选' },
        industry: { type: 'string', description: '行业领域，可选' },
        year: { type: 'number', description: '投标年份，可选' },
        result: { type: 'string', description: '结果：中标/落标/进行中，可选' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        if (!config.bidArchiveDatasetId) {
          return toJson({ error: '未配置 BID_ARCHIVE_DATASET_ID（历史标书库）' })
        }
        const filePath = String(args.file_path ?? '')
        const project = String(args.project ?? '')
        const meta: Record<string, unknown> = {}
        for (const k of ['client', 'industry', 'year', 'result']) {
          if (args[k] !== undefined && args[k] !== '') meta[k] = args[k]
        }
        try {
          const info = await uploadDocument(config.bidArchiveDatasetId, filePath)
          ctx.logger?.info?.(`[bid-tools] 定稿归档成功：${filePath}，元数据 ${JSON.stringify(meta)}`)
          return toJson({ ok: true, document_id: info.id ?? '', message: `已归档：${project}，元数据 ${JSON.stringify(meta)}` })
        } catch (err) {
          const msg = err instanceof RagflowError ? err.message : err instanceof Error ? err.message : String(err)
          return toJson({ ok: false, error: msg })
        }
      },
    }),
  )

  // ---- 步骤①（确定性前置）：招标约束抽取（纯正则，零 LLM） ----
  ctx.tools.register(
    defineTool({
      name: 'tender_parse_constraints',
      description:
        '用确定性规则（关键词+正则）解析招标文件，抽取废标/否决条款、暗标格式要求、评分办法与权重、' +
        '资质业绩要求、关键参数（工期/保证金/最高限价）。不使用 LLM，结果可复现可举证。' +
        '应作为 tender_extract_requirements 的前置步骤：先定规则抽取，再做 LLM 语义补充。',
      parameters: {
        tender_text: { type: 'string', required: true, description: '招标文件全文（已解析为纯文本/Markdown）' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const tenderText = String(args.tender_text ?? '')
        if (!tenderText.trim()) return toJson({ error: 'tender_text 为空' })
        const report = parseTender(clip(tenderText))
        ctx.logger?.info?.(
          `[bid-tools] 约束抽取完成：废标${report.stats.reject_count}条/格式${report.stats.format_count}条/` +
            `评分${report.stats.scoring_count}条/资质${report.stats.qualification_count}条`,
        )
        return toJson(report)
      },
    }),
  )

  // ---- 步骤④（生成后）：PII 脱敏（暗标身份信息 -> ＊＊＊＊＊＊） ----
  ctx.tools.register(
    defineTool({
      name: 'bid_mask_pii',
      description:
        '把标书正文中的强个人信息/身份标识（手机、邮箱、统一社会信用代码、银行账号、身份证号）' +
        '统一替换为占位符「＊＊＊＊＊＊」（河北暗标口径）。纯正则、零 LLM。' +
        '应在章节生成后、合规自查前调用。',
      parameters: {
        text: { type: 'string', required: true, description: '待脱敏的标书正文' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const text = String(args.text ?? '')
        if (!text.trim()) return toJson({ error: 'text 为空' })
        const res = maskPII(text)
        ctx.logger?.info?.(`[bid-tools] PII 脱敏完成：命中 ${res.count} 处`)
        return toJson(res)
      },
    }),
  )

  // ---- 步骤⑤：身份泄露扫描（八面扫描） ----
  ctx.tools.register(
    defineTool({
      name: 'bid_scan_disclosure',
      description:
        '扫描标书正文是否泄露投标人身份：单位名称、地址、人员姓名、手机、邮箱、' +
        '统一社会信用代码、银行账号、企业文化宣传语等八类可识别信息。' +
        '规则复用 common_disclosure.json，纯正则、零 LLM，命中项标注严重级别与修复建议。' +
        'auto_mask=true 时同时返回已脱敏文本。',
      parameters: {
        text: { type: 'string', required: true, description: '待扫描的标书正文' },
        auto_mask: { type: 'boolean', description: '是否同时输出脱敏后的文本，默认 true' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const text = String(args.text ?? '')
        if (!text.trim()) return toJson({ error: 'text 为空' })
        const autoMask = args.auto_mask === undefined ? true : Boolean(args.auto_mask)
        if (autoMask) {
          const res = scanAndMask(text)
          const summary: Record<string, number> = {}
          for (const l of res.leaks) summary[l.rule_id] = (summary[l.rule_id] ?? 0) + 1
          ctx.logger?.info?.(
            `[bid-tools] 泄露扫描完成：命中 ${res.leaks.length} 处，已自动脱敏 ${res.masked.count} 处`,
          )
          return toJson({
            leaks: res.leaks,
            summary,
            leak_count: res.leaks.length,
            masked_text: res.masked.text,
            masked: res.masked,
          })
        }
        const { leaks, summary } = scanDisclosure(text)
        ctx.logger?.info?.(`[bid-tools] 泄露扫描完成：命中 ${leaks.length} 处`)
        return toJson({ leaks, summary, leak_count: leaks.length })
      },
    }),
  )

  // ---- 步骤⑤：确定性规则引擎（元数据/痕迹/图片/正文模式） ----
  ctx.tools.register(
    defineTool({
      name: 'bid_check_rules',
      description:
        '运行确定性合规规则引擎：按地域/行业口径匹配暗标模板（common_disclosure 始终叠加），' +
        '对文档事实（正文、文档属性 creator/lastModifiedBy/company、修订批注隐藏文字、图片 EXIF/彩色）' +
        '逐条判定，输出 verdict（REJECT/WARN/PASS）、扣分与 findings。不使用 LLM，判定可复现、可举证。' +
        '可只传 text 做正文扫描；也可传 facts_json 做全量判定。',
      parameters: {
        text: { type: 'string', description: '标书正文（用于 text.pattern 类规则）' },
        facts_json: { type: 'string', description: '完整事实 JSON：{text,metadata{creator,lastModifiedBy,company},marks{revisions,comments,hidden_text,rsid_count},images[{has_exif,color_space}]}' },
        region: { type: 'string', description: '评标地域口径，默认取 RULE_REGION（河北省）' },
        city: { type: 'string', description: '地市口径，默认取 RULE_CITY' },
        industry: { type: 'string', description: '评标口径行业（工程/房建/市政…），默认取 RULE_INDUSTRY（工程）' },
        tender_type: { type: 'string', description: '标的类型，默认取 RULE_TENDER_TYPE（工程）' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        let facts: Record<string, unknown>
        if (args.facts_json) {
          try {
            facts = JSON.parse(String(args.facts_json)) as Record<string, unknown>
          } catch (err) {
            return toJson({ error: `facts_json 解析失败: ${err instanceof Error ? err.message : err}` })
          }
        } else {
          facts = { text: String(args.text ?? '') }
        }
        const verdict = validateFacts(facts, {
          region: String(args.region ?? config.ruleRegion),
          city: String(args.city ?? config.ruleCity),
          industry: String(args.industry ?? config.ruleIndustry),
          tender_type: String(args.tender_type ?? config.ruleTenderType),
        })
        ctx.logger?.info?.(
          `[bid-tools] 规则引擎判定：${verdict.verdict}（${verdict.summary.reject} REJECT / ${verdict.summary.warn} WARN，得分 ${verdict.score}）`,
        )
        return toJson(verdict)
      },
    }),
  )

  // ---- 步骤⑤：全量 docx 审计（OOXML 几何事实 -> 规则引擎，激活暗标几何规则） ----
  ctx.tools.register(
    defineTool({
      name: 'bid_audit_docx',
      description:
        '对一份 docx 标书做全量确定性合规审计（暗标格式）：解析 OOXML 提取几何/元数据/痕迹/图片事实，' +
        '再跑规则引擎，输出 verdict（REJECT/WARN/PASS）与 findings。零 LLM，可复现可举证。' +
        '这是让河北暗标那 11 条字体/字号/行距/页边距/页眉页脚/水印等几何规则真正生效的卡点：' +
        '此前这些规则因 Facts 缺几何特征被静默跳过，本工具补齐后即参与判定。',
      parameters: {
        docx_path: { type: 'string', required: true, description: 'docx 文件绝对路径' },
        region: { type: 'string', description: '评标地域口径，默认取 RULE_REGION（河北省）' },
        city: { type: 'string', description: '地市口径，默认取 RULE_CITY' },
        industry: { type: 'string', description: '评标口径行业（工程/房建/市政…），默认取 RULE_INDUSTRY（工程）' },
        tender_type: { type: 'string', description: '标的类型，默认取 RULE_TENDER_TYPE（工程）' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const path = String(args.docx_path ?? '')
        if (!path.trim()) return toJson({ error: 'docx_path 为空' })
        try {
          const facts = await collectDocxFacts(path)
          const verdict = validateFacts(facts, {
            region: String(args.region ?? config.ruleRegion),
            city: String(args.city ?? config.ruleCity),
            industry: String(args.industry ?? config.ruleIndustry),
            tender_type: String(args.tender_type ?? config.ruleTenderType),
          })
          ctx.logger?.info?.(
            `[bid-tools] docx 审计：${verdict.verdict}（${verdict.summary.reject} REJECT / ${verdict.summary.warn} WARN，得分 ${verdict.score}）`,
          )
          return toJson(verdict)
        } catch (err) {
          return toJson({ error: `docx 解析失败: ${err instanceof Error ? err.message : err}` })
        }
      },
    }),
  )

  // ---- 步骤⑤：FactCheck 事实溯源（无来源即标「待人工补充」） ----
  ctx.tools.register(
    defineTool({
      name: 'bid_fact_check',
      description:
        '对章节正文做事实溯源核查：含具体数字、年限、规范编号、参数的句子，' +
        '必须在知识库来源（kb_search_materials 检索结果）中有对应 token，否则标记为「待人工补充」。' +
        '抗幻觉卡点：不允许以生成内容冒充已核实事实。统计占位符「＊＊＊＊＊＊」使用情况。' +
        '纯启发式、零 LLM；任何章节经本工具核查后均置 requires_human_review=true。',
      parameters: {
        section_text: { type: 'string', required: true, description: '章节正文' },
        citations_json: { type: 'string', description: '来源数组 JSON：[{source, content}]，来自 kb_search_materials' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const sectionText = String(args.section_text ?? '')
        if (!sectionText.trim()) return toJson({ error: 'section_text 为空' })
        let citations: unknown[] = []
        if (args.citations_json) {
          try {
            const parsed = JSON.parse(String(args.citations_json))
            citations = Array.isArray(parsed) ? parsed : (parsed?.results ?? [])
          } catch (err) {
            return toJson({ error: `citations_json 解析失败: ${err instanceof Error ? err.message : err}` })
          }
        }
        const report = factCheck(sectionText, citations as Array<{ source?: string; content?: string }>)
        ctx.logger?.info?.(
          `[bid-tools] FactCheck 完成：事实句 ${report.factual_sentences} 条，待人工补充 ${report.uncited} 条`,
        )
        return toJson(report)
      },
    }),
  )

  // ---- 步骤⑤：围串标/公平性自检（SimHash 雷同 + 报价规律，零 LLM） ----
  ctx.tools.register(
    defineTool({
      name: 'bid_check_collusion',
      description:
        '围串标/公平性自检：对调用方提供的多份文件做 SimHash 文本雷同比对（识别同一底稿/模板复用），' +
        '并对多份报价做等差/等比规律检测（串通投标疑似特征）。纯算法、零 LLM、可复现。' +
        '仅作用于提供的文件/报价（典型：同单位自有标书之间，或同一项目多家投标文件之间），不抓取外部数据。' +
        '命中即标 requires_human_review=true；结论不替代人工判断与法定责任。',
      parameters: {
        documents_json: { type: 'string', description: '待比对文档数组 JSON：[{id, text}]，text 为已解析的纯文本' },
        prices_json: { type: 'string', description: '待检测报价数组 JSON（元），如 [29100000,29200000,29300000,29400000]' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        let documents: Array<{ id: string; text: string }> = []
        let prices: number[] = []
        if (args.documents_json) {
          try {
            const parsed = JSON.parse(String(args.documents_json))
            documents = Array.isArray(parsed) ? parsed : (parsed.documents ?? [])
          } catch (err) {
            return toJson({ error: `documents_json 解析失败: ${err instanceof Error ? err.message : err}` })
          }
        }
        if (args.prices_json) {
          try {
            const parsed = JSON.parse(String(args.prices_json))
            prices = (Array.isArray(parsed) ? parsed : (parsed.prices ?? [])).map((x: unknown) => Number(x))
          } catch (err) {
            return toJson({ error: `prices_json 解析失败: ${err instanceof Error ? err.message : err}` })
          }
        }
        if (documents.length === 0 && prices.length === 0) {
          return toJson({ error: 'documents_json 与 prices_json 至少提供一个' })
        }
        const report = collusionCheck({ documents, prices })
        ctx.logger?.info?.(
          `[bid-tools] 围串标自检完成：风险等级 ${report.risk_level}` +
            `（文本雷同簇 ${report.text_similarity.risk_groups.length} 组 / 报价规律${report.price_pattern.detected ? '命中' + report.price_pattern.type : '未命中'}）`,
        )
        return toJson(report)
      },
    }),
  )

  // ---- 步骤①：招标文件公平竞争审查（FAIR.* 9 类，零 LLM，提示性） ----
  ctx.tools.register(
    defineTool({
      name: 'bid_check_fairness',
      description:
        '对招标文件（招标人起草的门槛/条款）做公平竞争审查，识别疑似排斥、限制竞争情形：' +
        '限定特定品牌/产地/供应商、地域业绩/本地分支限制、所有制/组织形式限制、特定奖项加分、' +
        '资质与规模不相适应、差别化对待外地企业、倾向性/歧视性错敏词、指定交易工具平台等 9 类。' +
        '规则数据外置可溯源到《招标投标领域公平竞争审查规则》（2024 年第 16 号令）等条文，纯正则、零 LLM。' +
        '本检测为提示性结论，不替代法定审查程序；命中即置 requires_human_review=true。' +
        '可传 text（纯文本/Markdown）或 docx_path（docx 自动抽取正文）。',
      parameters: {
        text: { type: 'string', description: '招标文件正文（已解析为纯文本/Markdown）' },
        docx_path: { type: 'string', description: 'docx 招标文件绝对路径（与 text 二选一；优先用 docx_path）' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const docxPath = String(args.docx_path ?? '')
        const text = String(args.text ?? '')
        try {
          let report
          if (docxPath.trim()) {
            report = await detectDocx(docxPath)
          } else if (text.trim()) {
            report = detectText(text)
          } else {
            return toJson({ error: 'text 与 docx_path 至少提供一个' })
          }
          ctx.logger?.info?.(
            `[bid-tools] 公平竞争审查：${report.summary.total_hits} 处命中` +
              `（HARD ${report.summary.hard_count} / SOFT ${report.summary.soft_count}，规则 ${report.rules_loaded} 条）`,
          )
          return toJson(report)
        } catch (err) {
          return toJson({ error: `公平竞争审查失败: ${err instanceof Error ? err.message : err}` })
        }
      },
    }),
  )

  // ---- ProjectFacts：单一事实源（init / update / check） ----

  ctx.tools.register(
    defineTool({
      name: 'project_facts_init',
      description:
        '从招标要求清单初始化项目事实表（单一事实源）。自动提取工期/最高限价/保证金/资质等级/' +
        '混凝土等级/评分权重等关键事实。也可手动传 facts 覆盖/补充。返回完整事实表 JSON。',
      parameters: {
        requirements: { type: 'json', description: 'tender_extract_requirements 的输出（RequirementList），用于自动提取事实' },
        project_name: { type: 'string', description: '项目名称' },
        tender_name: { type: 'string', description: '标段名称' },
        facts: { type: 'json', description: '手动补充/覆盖的事实键值对（可选）' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const reqs = Array.isArray(args.requirements?.items) ? args.requirements.items : []
        const facts = createEmptyFacts(String(args.project_name ?? ''), String(args.tender_name ?? ''))
        facts.facts = extractFactsFromRequirements(reqs)
        if (args.facts && typeof args.facts === 'object') {
          for (const [k, v] of Object.entries(args.facts)) facts.facts[k] = String(v)
        }
        ctx.logger?.info?.(`[bid-tools] ProjectFacts 初始化：${Object.keys(facts.facts).length} 个事实`)
        return toJson(facts)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'project_facts_update',
      description:
        '更新项目事实表中的指定事实键值（改一处全篇同步）。传入 facts 键值对覆盖现有值。' +
        '返回更新后的完整事实表。',
      parameters: {
        current_facts: { type: 'json', required: true, description: '当前事实表（project_facts_init 或上次 update 的输出）' },
        updates: { type: 'json', required: true, description: '要更新的事实键值对' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const facts: ProjectFacts = args.current_facts
        if (!facts || typeof facts !== 'object') return toJson({ error: 'current_facts 不是有效事实表' })
        if (args.updates && typeof args.updates === 'object') {
          for (const [k, v] of Object.entries(args.updates)) facts.facts[k] = String(v)
        }
        facts.updated_at = new Date().toISOString()
        ctx.logger?.info?.(`[bid-tools] ProjectFacts 更新：${Object.keys(args.updates ?? {}).length} 个键`)
        return toJson(facts)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'project_facts_check',
      description:
        '校验生成章节中的事实是否与项目事实表一致（跨章节一致性检查）。' +
        '对每个事实键，在文本中搜索对应值：找不到=缺失，找到但数值/单位不匹配=偏离。' +
        '用于发现"工期/限价/资质散落多页、手改必漏"的一致性问题。纯确定性，零 LLM。',
      parameters: {
        text: { type: 'string', required: true, description: '待校验的章节正文（Markdown/纯文本）' },
        facts: { type: 'json', required: true, description: '项目事实表（project_facts_init/update 的输出）' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const text = String(args.text ?? '')
        const facts = args.facts?.facts ?? args.facts
        if (!text.trim()) return toJson({ error: 'text 为空' })
        if (!facts || typeof facts !== 'object') return toJson({ error: 'facts 不是有效事实表' })
        const report = checkFactsConsistency(text, facts)
        ctx.logger?.info?.(
          `[bid-tools] 事实一致性校验：${report.total} 项（一致 ${report.consistent} / 偏离 ${report.deviated} / 缺失 ${report.missing}）`,
        )
        return toJson(report)
      },
    }),
  )

  // ---- 步骤⑥：OOXML 渲染导出（Markdown → .docx） ----

  ctx.tools.register(
    defineTool({
      name: 'bid_render_docx',
      description:
        '将 Markdown 标书正文渲染为 .docx 文件（OOXML 直写，无需 Word/WPS）。' +
        '支持标题(H1-H4)/段落/无序列表/有序列表/加粗/斜体/表格/分隔线。' +
        '可配页眉页脚、标题、作者、字体字号。输出含元数据（creator/title/subject）用于审计留痕。' +
        '对应设计文档 P4「Word 导出 + 审计留痕」。',
      parameters: {
        markdown: { type: 'string', required: true, description: 'Markdown 格式的标书正文' },
        output_path: { type: 'string', required: true, description: '输出 .docx 文件绝对路径' },
        title: { type: 'string', description: '文档标题（写入元数据）' },
        author: { type: 'string', description: '作者（写入元数据，默认 bid-tools-plugin）' },
        subject: { type: 'string', description: '主题（写入元数据）' },
        header: { type: 'string', description: '页眉文本（居中）' },
        footer: { type: 'string', description: '页脚文本（居中）' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args: Record<string, any>) {
        const md = String(args.markdown ?? '')
        const outputPath = String(args.output_path ?? '')
        if (!md.trim()) return toJson({ error: 'markdown 为空' })
        if (!outputPath.trim()) return toJson({ error: 'output_path 为空' })
        try {
          const size = await renderDocx(md, outputPath, {
            title: String(args.title ?? ''),
            author: String(args.author ?? ''),
            subject: String(args.subject ?? ''),
            header: String(args.header ?? ''),
            footer: String(args.footer ?? ''),
          })
          ctx.logger?.info?.(`[bid-tools] docx 渲染完成：${outputPath} (${size} 字节)`)
          return toJson({ output_path: outputPath, size, paragraphs: md.split('\n').filter((l: string) => l.trim()).length })
        } catch (err) {
          return toJson({ error: `docx 渲染失败: ${err instanceof Error ? err.message : err}` })
        }
      },
    }),
  )

  ctx.logger?.info?.(
    '[bid-tools] 16 个工具注册完成：tender_extract_requirements / tender_parse_constraints / kb_search_materials / ' +
      'bid_check_compliance / bid_check_rules / bid_audit_docx / bid_scan_disclosure / bid_mask_pii / bid_fact_check / ' +
      'bid_check_collusion / bid_check_fairness / bid_archive_final / project_facts_init / project_facts_update / project_facts_check / bid_render_docx',
  )
}
