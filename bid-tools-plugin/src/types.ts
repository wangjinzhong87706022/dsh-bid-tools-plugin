/** 工具契约类型：与 Python MCP 版 schemas.py 一一对应，保持跨形态稳定。 */

// 确定性模块产出的契约类型（与源码模块一一对应）
export type { TenderConstraintReport } from './parser.ts'
export type { MaskResult, LeakHit } from './pii.ts'
export type { Facts, RuleFinding, RuleVerdict } from './rules.ts'
export type { Citation, FactCheckItem, FactCheckReport } from './factcheck.ts'
export type { CollusionReport, CollusionDoc, SimilarityPair, PricePatternResult, RiskLevel } from './collusion.ts'
export type { FairnessReport, FairnessHit, FairnessRule, FairnessSummary } from './fairness.ts'
export type { ProjectFacts, ConsistencyReport, ConsistencyFinding } from './facts.ts'

export type RequirementCategory = '评分点' | '资质门槛' | '技术参数' | '商务条款' | '废标条款'

export interface RequirementItem {
  id: string
  category: RequirementCategory
  content: string
  mandatory: boolean
  keywords: string[]
  source_chunk?: string
}

export interface RequirementList {
  tender_name: string
  items: RequirementItem[]
}

export type ComplianceStatus = '完全响应' | '偏离' | '缺失'

export interface SingleCheck {
  status: ComplianceStatus
  evidence: string
  comment: string
}

export interface ComplianceItem {
  requirement_id: string
  requirement_content: string
  status: ComplianceStatus
  evidence: string
  comment: string
}

export interface ComplianceReport {
  total: number
  fully_met: number
  deviated: number
  missing: number
  items: ComplianceItem[]
}

export interface RagChunk {
  content: string
  document_keyword?: string
  docnm_kwd?: string
  similarity?: number
  dataset_id?: string
  document_id?: string
}
