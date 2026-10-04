/**
 * FactCheck（移植自 AIBidForge3.1 orchestrator 的「事实须有来源」思想）。
 *
 * 设计红线（抗幻觉）：
 * - 标书正文中的具体事实（数字、年限、规范编号、参数、业绩数据）必须有知识库来源；
 * - 无来源的断言一律标记为「待人工补充」，不允许以 LLM 生成内容冒充已核实事实；
 * - 身份信息已用「＊＊＊＊＊＊」占位的，属合规脱敏，单独统计、不计入缺来源。
 * - 任何经 FactCheck 的章节都 require_human_review = true（HITL 卡点）。
 *
 * 纯启发式、零 LLM、可复现。来源由 kb_search_materials 检索结果提供。
 */

export const PLACEHOLDER = '＊＊＊＊＊＊'

export interface Citation {
  source?: string
  content?: string
}

export interface FactCheckItem {
  index: number
  sentence: string
  has_number: boolean
  cited: boolean
  status: '已引用' | '待人工补充'
  reason: string
}

export interface FactCheckReport {
  total_sentences: number
  factual_sentences: number
  cited: number
  uncited: number
  placeholder_count: number
  requires_human_review: boolean
  items: FactCheckItem[]
  disclaimer: string
}

const NUMBER_RE = /(\d+(?:\.\d+)?\s*(?:%|％|年|月|日|天|m|km|km²|㎡|吨|t|万元|元|MPa|℃|°C|cm|mm|度|级|倍|次|项))/u
const STANDARD_RE = /(SL\s?\d+|GB\/?T?\s?\d+|DL\/T\s?\d+|JGJ\s?\d+|CJJ\s?\d+|规范|标准|规程|法|条例|主席令|部令)/u
// 明显非事实的叙述性/套话，不计入缺来源
const NARRATIVE_RE = /^(本章|本节|根据|依据|综上|因此|故|综上所|我方|本单位|投标人|说明：|注：)/

function splitSentences(text: string): string[] {
  return text
    .split(/[。；;！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
}

function citationTokens(citations: Citation[]): string[] {
  const toks: string[] = []
  for (const c of citations) {
    const blob = `${c.source ?? ''} ${c.content ?? ''}`
    // 抽取规范编号、数字、关键术语作为可匹配 token
    const m = blob.match(/(SL\s?\d+|GB\/?T?\s?\d+|DL\/T\s?\d+|JGJ\s?\d+|CJJ\s?\d+|\d+(?:\.\d+)?\s*(?:%|％|年|MPa|℃|°C|m|km|吨|t|万元|元|度|级|倍|次|项))/gu)
    if (m) toks.push(...m)
  }
  return toks.map((t) => t.toLowerCase().replace(/\s+/g, ''))
}

/** 对章节文本做事实溯源核查。 */
export function factCheck(sectionText: string, citations: Citation[] = []): FactCheckReport {
  const sents = splitSentences(sectionText)
  const tokens = citationTokens(citations)
  const items: FactCheckItem[] = []
  let factual = 0
  let cited = 0
  let placeholderCount = 0

  // 占位符统计（整篇）
  const phMatches = sectionText.match(new RegExp(PLACEHOLDER, 'g'))
  placeholderCount = phMatches ? phMatches.length : 0

  sents.forEach((s, i) => {
    const hasNumber = NUMBER_RE.test(s)
    const hasStandard = STANDARD_RE.test(s)
    const isNarrative = NARRATIVE_RE.test(s)
    const isFactual = (hasNumber || hasStandard) && !isNarrative
    if (!isFactual) return
    factual++

    const sLow = s.toLowerCase().replace(/\s+/g, '')
    const citedHit = tokens.length > 0 && tokens.some((t) => sLow.includes(t))
    if (citedHit) {
      cited++
      items.push({ index: i, sentence: s.slice(0, 120), has_number: hasNumber, cited: true, status: '已引用', reason: '命中知识库来源 token' })
    } else {
      items.push({
        index: i,
        sentence: s.slice(0, 120),
        has_number: hasNumber,
        cited: false,
        status: '待人工补充',
        reason: hasStandard ? '含规范/标准引用但无对应知识库来源' : '含具体数字/参数但无知识库来源',
      })
    }
  })

  return {
    total_sentences: sents.length,
    factual_sentences: factual,
    cited,
    uncited: factual - cited,
    placeholder_count: placeholderCount,
    requires_human_review: true,
    items,
    disclaimer:
      'FactCheck 为启发式溯源核查（非 LLM）。标「待人工补充」的句子必须由专业人员核实并补入真实来源后方可定稿；本工具不替代人工审校。',
  }
}
