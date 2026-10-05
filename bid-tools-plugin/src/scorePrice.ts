/**
 * 确定性价格分测算（移植自 AIBidForge5.0 data/eval/scoring_models.json 的
 * price_methods + base_price_algorithms）。
 *
 * 设计红线：本模块不使用任何 LLM、不做任何随机抽取。评标基准价的"双随机"
 * （HEBEI_DUAL_RANDOM）由评标委员会现场随机确定，工具不可替其决定——本模块
 * 对该方法的确定性实现是：对全部候选基准价算法各算一遍得分矩阵供现场查表，
 * 保证可复现、可举证。
 */
import scoringModels from './data/eval/scoring_models.json'

const METHODS = (scoringModels as unknown as {
  price_methods: Record<string, { name: string; desc: string; params: Record<string, unknown> }>
  base_price_algorithms: Record<string, string>
}).price_methods
const ALGO_DESC = (scoringModels as unknown as { base_price_algorithms: Record<string, string> }).base_price_algorithms

export type PriceMethod = keyof typeof METHODS
export type BaseAlgo = 'AVG_ALL' | 'AVG_DROP' | 'AVG_DROP_LOWER' | 'MIN_PRICE' | 'CONTROL_WEIGHT'

export interface PriceScoreItem {
  price: number
  score: number
  rank: number
  notes: string[]
}

export interface PriceScoreReport {
  method: string
  method_name: string
  method_desc: string
  unit: string
  full_score: number
  base_price: { value: number; algorithm: string; algorithm_desc: string; notes: string[] }
  params: Record<string, unknown>
  scores: PriceScoreItem[]
  candidate_matrix: Array<{ algorithm: string; base_price: number; scores: Array<{ price: number; score: number }> }>
  disclaimer: string
}

interface AlgoNotes {
  value: number
  notes: string[]
}

/** 基准价计算。dropN 不足时降级并注明；CONTROL_WEIGHT 缺最高限价时降级 AVG_ALL。 */
function calcBase(
  prices: number[],
  algo: string,
  dropN: number,
  controlPrice?: number,
): AlgoNotes {
  const a = algo as BaseAlgo
  const sorted = [...prices].sort((x, y) => x - y)
  const notes: string[] = []
  if (a === 'MIN_PRICE') return { value: sorted[0], notes }
  if (a === 'AVG_ALL') {
    return { value: avg(prices), notes }
  }
  if (a === 'AVG_DROP') {
    if (prices.length < dropN * 2 + 1) {
      notes.push(`有效报价仅 ${prices.length} 个，不足以去掉 ${dropN} 高 ${dropN} 低，降级为全体平均（AVG_ALL）`)
      return { value: avg(prices), notes }
    }
    return { value: avg(sorted.slice(dropN, sorted.length - dropN)), notes }
  }
  if (a === 'AVG_DROP_LOWER') {
    if (prices.length < dropN + 1) {
      notes.push(`有效报价仅 ${prices.length} 个，不足以去掉 ${dropN} 个最低价，降级为全体平均（AVG_ALL）`)
      return { value: avg(prices), notes }
    }
    return { value: avg(sorted.slice(dropN)), notes }
  }
  // CONTROL_WEIGHT：最高限价与平均价的加权平均（各 0.5）
  if (controlPrice === undefined || !Number.isFinite(controlPrice) || controlPrice <= 0) {
    notes.push('未提供最高限价，CONTROL_WEIGHT 降级为全体平均（AVG_ALL）')
    return { value: avg(prices), notes }
  }
  const mean = avg(prices)
  return { value: Math.round(((0.5 * controlPrice + 0.5 * mean) * 100) / 100), notes }
}

function avg(xs: number[]): number {
  return Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100
}

/** 修正到 2 位小数并保证不为负（扣完为止）。 */
function fix(x: number): number {
  return Math.max(0, Math.round(x * 100) / 100)
}

/** 单方法得分（BASE_PRICE_LINEAR 家族：以基准价为中心按偏离度扣分）。 */
function linearScores(
  prices: number[],
  base: number,
  abovePenalty: number,
  belowPenalty: number,
  full: number,
): PriceScoreItem[] {
  return prices.map((p) => {
    const notes: string[] = []
    if (p === base) return { price: p, score: full, rank: 1, notes }
    if (p > base) {
      const pct = ((p - base) / base) * 100
      notes.push(`高于基准价 ${pct.toFixed(2)}%，每 1% 扣 ${abovePenalty} 分`)
      return { price: p, score: fix(full - (pct * abovePenalty)), rank: 1, notes }
    }
    const pct = ((base - p) / base) * 100
    notes.push(`低于基准价 ${pct.toFixed(2)}%，每 1% 扣 ${belowPenalty} 分`)
    return { price: p, score: fix(full - (pct * belowPenalty)), rank: 1, notes }
  })
}

/**
 * 按评分方法计算各报价得分（确定性、零随机）。
 * HEBEI_DUAL_RANDOM 不替评标委员会做随机抽取，改为输出全部候选算法得分矩阵。
 */
export function scorePrice(options: {
  prices: number[]
  method?: string
  full_score?: number
  control_price?: number
  params?: Record<string, unknown>
  unit?: string
}): PriceScoreReport {
  const methodKey = (options.method && METHODS[options.method] ? options.method : 'BASE_PRICE_LINEAR') as PriceMethod
  const m = METHODS[methodKey]
  const merged: Record<string, unknown> = { ...m.params, ...(options.params ?? {}) }
  const full = options.full_score && options.full_score > 0 ? options.full_score : 100
  const prices = options.prices.filter((p) => Number.isFinite(p) && p > 0)
  const unit = options.unit === '元' ? '元' : '万元'
  const disclaimer =
    '本测算为确定性公式复算，仅用于投标报价策略参考；评标基准价与得分以评标委员会现场计算为准。'

  if (prices.length === 0) {
    throw new Error('prices 为空或不含有效正数报价')
  }

  const mkBase = (algo: string, dropN: number): AlgoNotes =>
    calcBase(prices, algo, dropN, options.control_price)

  let items: PriceScoreItem[] = []
  let baseNotes: string[] = []
  let baseAlgo: string = 'AVG_ALL'
  let baseValue = 0
  let candidateMatrix: PriceScoreReport['candidate_matrix'] = []
  const paramsOut: Record<string, unknown> = { ...merged }

  if (methodKey === 'BASE_PRICE_LINEAR') {
    baseAlgo = (merged.base as BaseAlgo) ?? 'AVG_DROP'
    const dropN = Number(merged.drop_n ?? 1)
    const above = Number(merged.above_penalty ?? 1.0)
    const below = Number(merged.below_penalty ?? 0.5)
    const b = mkBase(baseAlgo, dropN)
    baseValue = b.value
    baseNotes = b.notes
    items = linearScores(prices, baseValue, above, below, full)
    Object.assign(paramsOut, { base: baseAlgo, drop_n: dropN, above_penalty: above, below_penalty: below })
  } else if (methodKey === 'LOWEST_FULL') {
    const min = Math.min(...prices)
    baseAlgo = 'MIN_PRICE'
    baseValue = min
    items = prices.map((p) => ({
      price: p,
      score: fix(full * (min / p)),
      rank: 1,
      notes: p === min ? ['最低有效报价得满分'] : [`得分 = 满分 × (最低价 ${min} / 报价 ${p})`],
    }))
  } else if (methodKey === 'BASE_PRICE_RATIO') {
    baseAlgo = (merged.base as BaseAlgo) ?? 'AVG_ALL'
    const b = mkBase(baseAlgo, 0)
    baseValue = b.value
    baseNotes = b.notes
    items = prices.map((p) => {
      const raw = full * (baseValue / p)
      const score = fix(Math.min(full, raw))
      return {
        price: p,
        score,
        rank: 1,
        notes: raw > full ? ['按公式超满分，取满分'] : [`得分 = 满分 × (基准价 ${baseValue} / 报价 ${p})`],
      }
    })
  } else if (methodKey === 'REASONABLE_LOW') {
    baseAlgo = (merged.base as BaseAlgo) ?? 'AVG_DROP'
    const dropN = Number(merged.drop_n ?? 1)
    const lowerPct = Number(merged.lower_pct ?? 0.05)
    const upperPct = Number(merged.upper_pct ?? 0.03)
    const outPenalty = Number(merged.out_penalty ?? 2.0)
    const b = mkBase(baseAlgo, dropN)
    baseValue = b.value
    baseNotes = b.notes
    const lo = baseValue * (1 - lowerPct)
    const hi = baseValue * (1 + upperPct)
    items = prices.map((p) => {
      if (p >= lo && p <= hi) {
        return { price: p, score: full, rank: 1, notes: [`落在合理低价区间 [${lo.toFixed(2)}, ${hi.toFixed(2)}] 内，得满分`] }
      }
      const dev = p < lo ? ((lo - p) / baseValue) * 100 : ((p - hi) / baseValue) * 100
      return {
        price: p,
        score: fix(full - dev * outPenalty),
        rank: 1,
        notes: [`超出合理低价区间，偏离 ${dev.toFixed(2)}%，每 1% 扣 ${outPenalty} 分`],
      }
    })
    Object.assign(paramsOut, { lower_pct: lowerPct, upper_pct: upperPct, out_penalty: outPenalty })
  } else {
    // HEBEI_DUAL_RANDOM：随机抽取由评标委员会现场决定，本工具输出全部候选算法得分矩阵
    const candidates = (merged.candidates as BaseAlgo[]) ?? ['AVG_ALL', 'AVG_DROP', 'AVG_DROP_LOWER', 'MIN_PRICE']
    const above = Number(merged.above_penalty ?? 1.0)
    const below = Number(merged.below_penalty ?? 0.5)
    candidateMatrix = candidates.map((algo) => {
      const b = mkBase(algo, Number(merged.drop_n ?? 1))
      return { algorithm: algo, base_price: b.value, scores: linearScores(prices, b.value, above, below, full).map((x) => ({ price: x.price, score: x.score })) }
    })
    baseNotes.push(
      '河北双随机：基准价算法由评标委员会现场随机抽取，本工具不代抽；下方矩阵为各候选算法下的得分，供现场查表。',
    )
    baseAlgo = 'HEBEI_DUAL_RANDOM'
    baseValue = NaN
  }

  // 超最高限价否决（P05）：高于限价的报价直接 0 分
  if (options.control_price !== undefined && Number.isFinite(options.control_price) && options.control_price > 0) {
    for (const it of items) {
      if (it.price > options.control_price!) {
        it.score = 0
        it.notes.push(`报价高于最高投标限价 ${options.control_price}，按否决投标处理（实施条例第 51 条第 5 项）`)
      }
    }
  } else {
    baseNotes.push('未提供最高限价（control_price），未做超限价否决检查')
  }

  // 排名（得分降序；0 分超限价不参与排名）
  const ranked = [...items].filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  for (const it of items) {
    const idx = ranked.indexOf(it)
    it.rank = idx >= 0 ? idx + 1 : 0
    if (it.rank === 0) it.notes.push('得分为 0，不参与排名')
  }
  if (methodKey === 'HEBEI_DUAL_RANDOM') {
    for (const it of items) it.rank = 0
  }

  return {
    method: methodKey,
    method_name: m.name,
    method_desc: m.desc,
    unit,
    full_score: full,
    base_price: {
      value: baseValue,
      algorithm: baseAlgo,
      algorithm_desc: ALGO_DESC[baseAlgo] ?? '河北双随机（候选算法现场抽取）',
      notes: baseNotes,
    },
    params: paramsOut,
    scores: items.sort((a, b) => (a.rank === 0 ? 1 : 0) - (b.rank === 0 ? 1 : 0) || a.rank - b.rank),
    candidate_matrix: candidateMatrix,
    disclaimer,
  }
}