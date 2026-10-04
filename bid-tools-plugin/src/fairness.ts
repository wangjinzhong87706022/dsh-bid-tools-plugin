/**
 * fairness — 招标文件公平竞争审查（确定性规则，零 LLM）。
 *
 * 移植自 AIBidForge3.1 app/modules/tender_detect/engine.py + app/data/fairness/fairness_rules.json。
 *
 * 设计原则（与 rules.ts / collusion.ts 同红线）：
 * - 不使用任何 LLM。判定可复现、可解释、可在公平竞争审查中举证。
 * - 规则数据外置于 data/fairness/fairness_rules.json，每条规则均可溯源到具体政策条文
 *   （《招标投标领域公平竞争审查规则》2024 年第 16 号令 / 《招标投标法》第二十条 / 《实施条例》第三十二条）。
 * - 本检测为**提示性**结论：只识别疑似排斥、限制竞争情形并给修改建议，
 *   不替代招标人/代理机构/监管部门的公平竞争审查程序与自主判断。命中条款均须人工复核。
 *
 * 与围串标（collusion.ts）的区别：
 * - fairness 作用于「招标文件」本身（招标人起草的门槛/条款是否排斥限制竞争）；
 * - collusion 作用于「多家投标文件/报价」之间（是否雷同底稿/报价规律）；
 * - 二者互补，共同覆盖投标合规的两条红线。
 */

import fairnessRules from './data/fairness/fairness_rules.json'
import { collectDocxFacts } from './docxFacts.ts'

export const ENGINE_VERSION = '1.0.0'

export interface FairnessRule {
  id: string
  name: string
  category: string
  type: 'HARD' | 'SOFT'
  severity: string
  detect: { keywords?: string[]; patterns?: string[] }
  message: string
  suggestion: string
  basis: string
  source_url: string
  auto_fixable: boolean
}

export interface FairnessHit {
  rule_id: string
  rule_name: string
  category: string
  type: 'HARD' | 'SOFT'
  severity: string
  sentence: string
  matched: string[]
  message: string
  suggestion: string
  basis: string
  source_url: string
}

export interface FairnessSummary {
  total_hits: number
  hard_count: number
  soft_count: number
  by_category: Record<string, number>
  sentence_count: number
  char_count: number
  requires_human_review: boolean
}

export interface FairnessReport {
  engine_version: string
  template: {
    template_id: string
    name: string
    legal_level: string
    effective_from: string
    basis: string
    source_url: string
  }
  rules_loaded: number
  hits: FairnessHit[]
  summary: FairnessSummary
  disclaimer: string
}

interface FairnessTemplate {
  template_id: string
  name: string
  legal_level?: string
  effective_from?: string
  basis?: string
  source_url?: string
  rules: FairnessRule[]
}

const TEMPLATE = fairnessRules as unknown as FairnessTemplate

/** 加载公平竞争审查规则集（内置 data/fairness/fairness_rules.json）。 */
export function loadRules(): FairnessRule[] {
  return (TEMPLATE.rules ?? []).slice()
}

/** 按中文标点 + 换行切句，过滤过短片段（与 Python _split_sentences 一致）。 */
function splitSentences(text: string, minLen = 6): string[] {
  const raw = (text || '').split(/[。；;！？\n]+/)
  const out: string[] = []
  for (const s of raw) {
    const t = s.trim()
    if (t.length >= minLen) out.push(t)
  }
  return out
}

/** 返回某规则在某句中命中的关键词/正则片段列表（与 Python _match_rule 一致）。 */
function matchRule(rule: FairnessRule, sentence: string): string[] {
  const detect = rule.detect || {}
  const matched: string[] = []
  for (const kw of detect.keywords || []) {
    if (kw && sentence.includes(kw)) matched.push(kw)
  }
  for (const pat of detect.patterns || []) {
    if (!pat) continue
    try {
      const re = new RegExp(pat)
      const m = re.exec(sentence)
      if (m) matched.push(`匹配：${m[0].slice(0, 40)}`)
    } catch {
      // 正则非法则跳过（不阻塞其余规则）
      continue
    }
  }
  return matched
}

/** 对招标文件文本执行公平竞争审查检测。 */
export function detectText(text: string): FairnessReport {
  const rules = loadRules()
  const sentences = splitSentences(text)

  const hits: FairnessHit[] = []
  for (const rule of rules) {
    for (const sent of sentences) {
      const matched = matchRule(rule, sent)
      if (!matched.length) continue
      hits.push({
        rule_id: rule.id,
        rule_name: rule.name,
        category: rule.category,
        type: rule.type,
        severity: rule.severity,
        sentence: sent,
        matched,
        message: rule.message,
        suggestion: rule.suggestion,
        basis: rule.basis,
        source_url: rule.source_url,
      })
    }
  }

  const hard = hits.filter((h) => h.type === 'HARD')
  const soft = hits.filter((h) => h.type === 'SOFT')
  const byCategory: Record<string, number> = {}
  for (const h of hits) byCategory[h.category] = (byCategory[h.category] ?? 0) + 1

  return {
    engine_version: ENGINE_VERSION,
    template: {
      template_id: TEMPLATE.template_id,
      name: TEMPLATE.name,
      legal_level: TEMPLATE.legal_level ?? '',
      effective_from: TEMPLATE.effective_from ?? '',
      basis: TEMPLATE.basis ?? '',
      source_url: TEMPLATE.source_url ?? '',
    },
    rules_loaded: rules.length,
    hits,
    summary: {
      total_hits: hits.length,
      hard_count: hard.length,
      soft_count: soft.length,
      by_category: byCategory,
      sentence_count: sentences.length,
      char_count: (text || '').length,
      requires_human_review: hits.length > 0,
    },
    disclaimer:
      '本检测为确定性规则提供的提示性结论，依据现行法律法规对疑似排斥限制竞争情形进行识别，' +
      '不替代招标人、招标代理机构及监管部门的公平竞争审查程序与自主判断。' +
      '命中条款均须由人工结合项目实际情况复核确认。',
  }
}

/** 从 docx（OOXML）抽取正文后执行公平竞争审查检测。 */
export async function detectDocx(docxPath: string): Promise<FairnessReport> {
  const facts = await collectDocxFacts(docxPath)
  return detectText(facts.text)
}
