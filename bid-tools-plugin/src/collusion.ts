/**
 * 围串标/公平性自检（移植自 AIBidForge3.1 collusion/simhash.py + evaluation/engine.py）。
 *
 * 设计红线（方案 §4.3 / §9.3④，投标合规红线）：
 * - 本模块不使用任何 LLM。判定基于确定性算法（SimHash 文本指纹 + 报价规律统计），可复现、可解释。
 * - 仅对「调用方提供的文件/报价」做一致性比对——典型场景是**同单位自有标书之间**或
 *   **同一项目多家投标文件之间**（审计/采购方角色）的异常一致自查；
 *   不抓取、不比对任何未提供的外部投标人文件。
 * - 结论仅供人工核查参考，不替代自主判断，不改变法定责任。
 *   法律基础：《中华人民共和国招标投标法实施条例》第四十条第（四）项
 *   「不同投标人的投标文件异常一致或者报价呈规律性差异」视为投标人相互串通投标。
 */

import { createHash } from 'node:crypto'

const HASH_BITS = 64

export interface CollusionDoc {
  id: string
  text: string
}

export type SimilarityVerdict = '高度相似' | '较相似' | '差异明显'

export interface SimilarityPair {
  doc_a: string
  doc_b: string
  hamming_distance: number
  verdict: SimilarityVerdict
}

export interface PricePatternResult {
  detected: boolean
  type?: '等差规律' | '等比规律'
  detail?: string
  hint?: string
  prices?: number[]
}

export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW'

export interface CollusionReport {
  input_summary: { document_count: number; price_count: number; skipped_short: number }
  text_similarity: {
    pairs: SimilarityPair[]
    risk_groups: string[][]
    max_similarity_distance: number
    risk_level: RiskLevel
  }
  price_pattern: PricePatternResult
  risk_level: RiskLevel
  requires_human_review: true
  disclaimer: string
}

// ------------------------------------------------------------------ SimHash

/** 中文 bigram 分词（不依赖外部分词库）。保留 Unicode 字母/数字/下划线，剔除空白与标点。 */
export function tokenize(text: string): string[] {
  const t = (text || '').replace(/[^\p{L}\p{N}_]+/gu, '')
  if (!t) return []
  const out: string[] = []
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2))
  return out
}

/**
 * 稳定 64 位哈希（md5 前 8 字节，BigInt 精确表示 64 位）。
 * 注意：不能用 parseInt 解析 16 位 hex——超过 Number.MAX_SAFE_INTEGER(2^53) 会丢低位；
 * 且 JS 位运算是 32 位（ToInt32），>31 的移位取模后与低位重复。必须用 BigInt 才有真 64 位指纹。
 */
function hash64(token: string): bigint {
  const hex = createHash('md5').update(token, 'utf-8').digest('hex').slice(0, 16)
  return BigInt('0x' + hex)
}

/** 计算 64 位 SimHash 指纹（BigInt，64 位全部有效）。 */
export function simhash(text: string): bigint {
  const v = new Array<bigint>(HASH_BITS).fill(0n)
  for (const tok of tokenize(text)) {
    const h = hash64(tok)
    for (let i = 0; i < HASH_BITS; i++) {
      v[i] += (h >> BigInt(i)) & 1n ? 1n : -1n
    }
  }
  let fp = 0n
  for (let i = 0; i < HASH_BITS; i++) {
    if (v[i] > 0n) fp |= 1n << BigInt(i)
  }
  return fp
}

export function hammingDistance(a: bigint, b: bigint): number {
  return (a ^ b).toString(2).split('0').join('').length
}

/** 两份文本的相似度判定（64 位下：<=3 高度相似，<=10 较相似，否则差异明显）。 */
export function similarity(textA: string, textB: string): { hamming_distance: number; verdict: SimilarityVerdict } {
  const dist = hammingDistance(simhash(textA), simhash(textB))
  let verdict: SimilarityVerdict
  if (dist <= 3) verdict = '高度相似'
  else if (dist <= 10) verdict = '较相似'
  else verdict = '差异明显'
  return { hamming_distance: dist, verdict }
}

// ------------------------------------------------------------------ 报价规律

/** 报价规律性检测（围串标特征之一）。多份报价呈等差/等比规律，是串通投标的重要线索。 */
export function detectPricePattern(prices: number[]): PricePatternResult {
  const ps = prices.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  const n = ps.length
  if (n < 3) {
    return { detected: false, prices: ps }
  }

  // 等差检测：相邻差值变异系数极小
  const diffs = ps.slice(1).map((x, i) => x - ps[i])
  if (diffs.every((d) => d > 0)) {
    const meanD = diffs.reduce((s, d) => s + d, 0) / diffs.length
    const variance = diffs.reduce((s, d) => s + (d - meanD) ** 2, 0) / diffs.length
    const cv = meanD ? Math.sqrt(variance) / meanD : 0
    if (cv < 0.05) {
      return {
        detected: true,
        type: '等差规律',
        detail: `${n} 份报价相邻差值接近 ${meanD.toFixed(0)} 元（变异系数 ${cv.toFixed(3)}），呈等差分布`,
        hint: '投标报价呈等差规律性差异，属《招标投标法实施条例》第四十条第（四）项「报价呈规律性差异」的疑似情形，务必人工核查报价编制依据',
        prices: ps,
      }
    }
  }

  // 等比检测：相邻比值变异系数极小
  const ratios = ps.slice(1).map((x, i) => x / ps[i])
  if (ratios.length === n - 1) {
    const meanR = ratios.reduce((s, r) => s + r, 0) / ratios.length
    const varianceR = ratios.reduce((s, r) => s + (r - meanR) ** 2, 0) / ratios.length
    const cvr = meanR ? Math.sqrt(varianceR) / meanR : 0
    if (cvr < 0.01) {
      return {
        detected: true,
        type: '等比规律',
        detail: `${n} 份报价相邻比值接近 ${meanR.toFixed(4)}（变异系数 ${cvr.toFixed(3)}），呈等比分布`,
        hint: '投标报价呈等比规律性差异，属《招标投标法实施条例》第四十条第（四）项「报价呈规律性差异」的疑似情形，务必人工核查',
        prices: ps,
      }
    }
  }

  return { detected: false, prices: ps }
}

// ------------------------------------------------------------------ 编排

const MIN_CHARS = 30 // 过短文本无意义，排除出两两比对

function unionFind(groups: Map<string, string>, x: string): string {
  while (groups.get(x) !== x) {
    groups.set(x, groups.get(groups.get(x) as string) as string)
    x = groups.get(x) as string
  }
  return x
}

function union(groups: Map<string, string>, a: string, b: string): void {
  const ra = unionFind(groups, a)
  const rb = unionFind(groups, b)
  if (ra !== rb) groups.set(ra, rb)
}

/** 围串标/公平性自检编排：文本雷同 + 报价规律，输出风险报告。 */
export function collusionCheck(input: { documents?: CollusionDoc[]; prices?: number[] }): CollusionReport {
  const documents = (input.documents ?? []).filter((d) => d && typeof d.text === 'string')
  const prices = input.prices ?? []

  // ---- 文本雷同：两两 SimHash ----
  const eligible = documents.filter((d) => (d.text || '').replace(/\s/g, '').length >= MIN_CHARS)
  const skippedShort = documents.length - eligible.length
  const pairs: SimilarityPair[] = []
  const groups = new Map<string, string>()
  for (const d of eligible) groups.set(d.id, d.id)

  let maxDist = -1
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const sim = similarity(eligible[i].text, eligible[j].text)
      pairs.push({ doc_a: eligible[i].id, doc_b: eligible[j].id, hamming_distance: sim.hamming_distance, verdict: sim.verdict })
      maxDist = Math.max(maxDist, sim.hamming_distance)
      if (sim.verdict === '高度相似') union(groups, eligible[i].id, eligible[j].id)
    }
  }

  // 连通分量（高度相似簇）
  const comp = new Map<string, string[]>()
  for (const id of groups.keys()) {
    const root = unionFind(groups, id)
    if (!comp.has(root)) comp.set(root, [])
    comp.get(root)!.push(id)
  }
  const riskGroups = [...comp.values()].filter((g) => g.length > 1)

  const hasHigh = pairs.some((p) => p.verdict === '高度相似')
  const hasMedium = pairs.some((p) => p.verdict === '较相似')
  const textRisk: RiskLevel = hasHigh ? 'HIGH' : hasMedium ? 'MEDIUM' : 'LOW'

  // ---- 报价规律 ----
  const pricePattern = detectPricePattern(prices)

  // ---- 总体风险 ----
  const riskLevel: RiskLevel =
    hasHigh || pricePattern.detected ? 'HIGH' : hasMedium ? 'MEDIUM' : 'LOW'

  return {
    input_summary: {
      document_count: documents.length,
      price_count: prices.length,
      skipped_short: skippedShort,
    },
    text_similarity: {
      pairs,
      risk_groups: riskGroups,
      max_similarity_distance: maxDist < 0 ? 0 : maxDist,
      risk_level: textRisk,
    },
    price_pattern: pricePattern,
    risk_level: riskLevel,
    requires_human_review: true,
    disclaimer:
      '本自检仅对调用方提供的文件/报价做一致性比对（典型场景：同单位自有标书之间，或同一项目多家投标文件之间），' +
      '不抓取、不比对任何未提供的外部投标人文件。判定基于 SimHash 文本指纹与报价规律统计（确定性算法，非 LLM），' +
      '仅供人工核查参考，不替代自主判断，不改变法定责任。法律基础：《招标投标法实施条例》第四十条第（四）项。',
  }
}
