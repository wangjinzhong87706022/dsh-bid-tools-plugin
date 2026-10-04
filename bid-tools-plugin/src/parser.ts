/**
 * 确定性招标解析器（移植自 AIBidForge3.1 tender_parser/extract.py）。
 *
 * 设计红线：本模块不使用任何 LLM。招标文件解析是投标人最该逐条核对的红线，
 * 必须用可复现、可举证的确定性规则抽取，不能交给概率模型。
 *
 * 抽取五类信息：
 *   1. 废标/否决条款（reject_clauses）—— 红线中的红线
 *   2. 技术暗标格式要求（format_clauses）—— 与暗标口径自动比对
 *   3. 评分办法关键词（scoring_clauses）+ 评分权重（scoring_weights）
 *   4. 资质与业绩要求（qualifications）
 *   5. 关键参数（key_params）：工期 / 投标保证金 / 最高限价
 */

const REJECT_KEYWORDS = [
  '否决', '废标', '无效投标', '取消投标资格', '作废', '不予受理', '拒绝受理',
  '丧失资格', '取消资格', '视为无效', '否决其投标', '不得参加', '取消中标资格',
  '重新招标', '拒收',
]
const REJECT_NEGATIVE = ['不否决', '不予否决', '不应否决', '不得否决', '不视为无效']

const FORMAT_KEYWORDS = [
  '暗标', '字体', '字号', '行距', '页边距', '页眉', '页脚', '页码', '宋体',
  '仿宋', '黑体', '楷体', '磅', '四号', '小四', '五号', '三号', '加粗', '彩色',
  '明示', '隐去', '不得出现', '单位名称', '法定代表人', 'logo', '标识', '页数',
]

const SCORE_KEYWORDS = [
  '评分', '分值', '权重', '评分标准', '评标办法', '综合评估', '综合评分',
  '合理低价', '技术分', '商务分', '价格分', '资信分', '业绩分', '得分',
]

const QUAL_KEYWORDS = [
  '资质', '证书', '注册建造师', '安全生产许可证', '业绩要求', '类似业绩',
  '信用等级', '体系认证', '执业资格', '专业承包', '施工总承包',
]

/** 按中英文句末标点切分句子，过短片段（<6 字）无抽取价值直接丢弃。 */
function splitSentences(text: string): string[] {
  const raw = text.split(/[。；;！？\n]+/)
  const out: string[] = []
  for (const s of raw) {
    const t = s.trim()
    if (t.length >= 6) out.push(t)
  }
  return out
}

function matchSentences(
  sents: string[],
  keywords: string[],
  negative?: string[],
): Array<{ text: string; matched: string[] }> {
  const hits: Array<{ text: string; matched: string[] }> = []
  for (const s of sents) {
    if (keywords.some((k) => s.includes(k))) {
      if (negative && negative.some((n) => s.includes(n))) continue
      hits.push({ text: s, matched: keywords.filter((k) => s.includes(k)).slice(0, 3) })
    }
  }
  return hits
}

function extractAmount(text: string, pattern: RegExp): Array<{ raw: string; value_yuan: number }> {
  const out: Array<{ raw: string; value_yuan: number }> = []
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = pattern.exec(text)) !== null && guard < 3) {
    let num = parseFloat(m[1])
    const unit = m[2]
    if (unit === '亿' || unit === '亿元') num *= 100_000_000
    else if (unit === '万' || unit === '万元') num *= 10_000
    out.push({ raw: m[0].trim(), value_yuan: Math.round(num * 100) / 100 })
    guard++
    if (m.index === pattern.lastIndex) pattern.lastIndex++ // 防止零宽死循环
  }
  return out.slice(0, 3)
}

export interface TenderConstraintReport {
  reject_clauses: Array<{ text: string; matched: string[] }>
  format_clauses: Array<{ text: string; matched: string[] }>
  scoring_clauses: Array<{ text: string; matched: string[] }>
  qualifications: Array<{ text: string; matched: string[] }>
  scoring_weights: Record<string, string>
  key_params: {
    duration_days?: number
    duration_raw?: string
    bid_bond?: Array<{ raw: string; value_yuan: number }>
    control_price?: Array<{ raw: string; value_yuan: number }>
  }
  stats: {
    sentence_count: number
    reject_count: number
    format_count: number
    scoring_count: number
    qualification_count: number
    char_count: number
  }
  disclaimer: string
}

/**
 * 解析招标文件全文，返回结构化约束清单（确定性、无 LLM）。
 * 输入应为已由 MinerU/DeepDoc 解析的纯文本/Markdown。
 */
export function parseTender(text: string): TenderConstraintReport {
  const sents = splitSentences(text)

  const reject = matchSentences(sents, REJECT_KEYWORDS, REJECT_NEGATIVE)
  const fmt = matchSentences(sents, FORMAT_KEYWORDS)
  const scoring = matchSentences(sents, SCORE_KEYWORDS)
  const qual = matchSentences(sents, QUAL_KEYWORDS)

  // ---- 评分权重抽取（技术/商务/价格/资信/业绩 X 分 或 X%）----
  const weights: Record<string, string> = {}
  const weightPatterns: Record<string, RegExp> = {
    技术: /技术(?:标|部分|分)?[^\d]{0,12}(\d{1,3})\s*(?:分|%|％)/,
    商务: /商务(?:标|部分|分)?[^\d]{0,12}(\d{1,3})\s*(?:分|%|％)/,
    价格: /价格(?:分)?[^\d]{0,12}(\d{1,3})\s*(?:分|%|％)/,
    资信: /资信(?:标|部分|分)?[^\d]{0,12}(\d{1,3})\s*(?:分|%|％)/,
    业绩: /业绩(?:分)?[^\d]{0,12}(\d{1,3})\s*(?:分|%|％)/,
  }
  for (const [label, pat] of Object.entries(weightPatterns)) {
    const m = text.match(pat)
    if (m) weights[label] = m[1]
  }

  // ---- 关键参数 ----
  const params: TenderConstraintReport['key_params'] = {}
  const durM = text.match(/(?:工期|工期要求)[^\d]{0,15}(\d+)\s*(?:个)?\s*(?:日历天|天|日)/)
  if (durM) {
    params.duration_days = parseInt(durM[1], 10)
    params.duration_raw = durM[0].trim()
  }
  const bond = extractAmount(text, /(?:投标)?保证金[^\d]{0,15}(\d+(?:\.\d+)?)\s*(亿元|万元|万|元)/g)
  if (bond.length) params.bid_bond = bond
  const ctrl = extractAmount(
    text,
    /(?:最高投标限价|最高限价|拦标价|招标控制价|控制价)[^\d]{0,15}(\d+(?:\.\d+)?)\s*(亿元|万元|万|元)/g,
  )
  if (ctrl.length) params.control_price = ctrl

  return {
    reject_clauses: reject,
    format_clauses: fmt,
    scoring_clauses: scoring,
    qualifications: qual,
    scoring_weights: weights,
    key_params: params,
    stats: {
      sentence_count: sents.length,
      reject_count: reject.length,
      format_count: fmt.length,
      scoring_count: scoring.length,
      qualification_count: qual.length,
      char_count: text.length,
    },
    disclaimer:
      '本解析为确定性规则抽取的辅助信息，仅供参考，投标人应以招标文件原文为准并逐条核对。',
  }
}
