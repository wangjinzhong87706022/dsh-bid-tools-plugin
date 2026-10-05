/**
 * 确定性行业自动识别（移植自 AIBidForge5.0 knowledge/industry_detect.py）。
 *
 * 基于 data/industry_detect.json（11 大行业）的关键词做确定性识别，零 LLM，
 * 为资质匹配、业绩相似度、知识包选择提供行业上下文。
 *
 * 移植要点（源自 5.0 的两次实测教训）：
 * - `_meta` 是顶层键，遍历时必须滤掉下划线开头的键，否则会被当成行业名；
 * - 中文行业名 → pack_key 映射以数据文件 `_meta.pack_key_mapping` 为唯一来源
 *   （该表曾有 4 份副本不同步，导致 IT 招标拿到工程知识包、计价口径连带走错，
 *   全程不报错只是内容错）；
 * - 未收录行业名回落到通用工程包 construction，不凭名称猜一个不存在的包。
 */
import industryData from './data/industry_detect.json'

interface IndustryEntry {
  keywords?: string[]
  performance?: string[]
  qualifications?: string[]
}

const INDUSTRIES = industryData as unknown as Record<string, IndustryEntry>

/** 保守回落包：宁可走通用工程包，也不要凭名称猜一个不存在的包。 */
const DEFAULT_PACK = 'construction'

/** 全部行业名（滤掉 `_meta` 等下划线开头的内部键）。 */
export function allIndustryNames(): string[] {
  return Object.keys(INDUSTRIES).filter((k) => !k.startsWith('_'))
}

/** 中文行业名 → 知识包 pack_key（唯一来源：数据文件 `_meta.pack_key_mapping`）。 */
export function packKeyMapping(): Record<string, string> {
  const meta = (INDUSTRIES._meta ?? {}) as { pack_key_mapping?: Record<string, string> }
  return meta.pack_key_mapping ?? {}
}

/** 中文行业名 → BidForge 知识包 pack_key。 */
export function detectPackKey(industryName: string): string {
  return packKeyMapping()[industryName] ?? DEFAULT_PACK
}

export interface IndustryDetectResult {
  name: string
  pack_key: string
  confidence: number
  matched_keywords: string[]
  matches: Record<string, number>
}

/**
 * 根据招标文件文本识别所属行业，返回 {name, pack_key, confidence, matches}。
 * score = 行业关键词命中数；confidence = 最高分行业的命中词占其词表比例（0~1）。
 */
export function detectIndustry(text: string): IndustryDetectResult {
  const matches: Record<string, number> = {}
  const matchedKw: string[] = []
  let best = ''
  let bestScore = 0
  for (const name of allIndustryNames()) {
    const kws = INDUSTRIES[name]?.keywords ?? []
    let score = 0
    for (const kw of kws) {
      if (text.includes(kw)) {
        score++
        if (matchedKw.length < 20) matchedKw.push(kw)
      }
    }
    if (score > 0) {
      matches[name] = score
      if (score > bestScore || (score === bestScore && !best)) {
        best = name
        bestScore = score
      }
    }
  }
  if (!best || bestScore === 0) {
    return { name: '未识别', pack_key: DEFAULT_PACK, confidence: 0, matched_keywords: [], matches: {} }
  }
  const total = (INDUSTRIES[best]?.keywords ?? []).length || 1
  return {
    name: best,
    pack_key: detectPackKey(best),
    confidence: Math.round((bestScore / total) * 100) / 100,
    matched_keywords: matchedKw.slice(0, 12),
    matches,
  }
}