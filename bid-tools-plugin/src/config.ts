/** 环境变量集中管理。插件随 DSH 进程运行，配置经环境变量或 DSH settings 注入。 */

function str(key: string, def: string): string {
  const v = process.env[key]
  return v === undefined || v === '' ? def : v
}
function num(key: string, def: number): number {
  const v = (process.env[key] ?? '').trim()
  if (v === '') return def // 空串防 Number('')===0：避免 CHUNK_SIZE= 之类写法导致 0 值配置（如分块死循环）
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}
function list(key: string): string[] {
  return str(key, '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

export const config = {
  // LLM（Qwen3.8-27B，vLLM OpenAI 兼容 API）
  llmBaseUrl: str('LLM_BASE_URL', 'http://127.0.0.1:8000/v1').replace(/\/+$/, ''),
  llmModel: str('LLM_MODEL', 'qwen3.8-27b-awq'),
  llmApiKey: str('LLM_API_KEY', 'EMPTY'),
  llmTimeoutMs: num('LLM_TIMEOUT_MS', 300_000),
  llmTemperature: num('LLM_TEMPERATURE', 0.2),
  llmMaxRetries: num('LLM_MAX_RETRIES', 3),

  // RAGFlow v0.27.1 HTTP API（API 端口默认 9380；部署在不同主机时改 RAGFLOW_BASE_URL）
  ragflowBaseUrl: str('RAGFLOW_BASE_URL', 'http://127.0.0.1:9380').replace(/\/+$/, ''),
  ragflowApiKey: str('RAGFLOW_API_KEY', ''),
  ragflowTimeoutMs: num('RAGFLOW_TIMEOUT_MS', 60_000),

  // 默认检索知识库（历史标书库/资质业绩库/项目案例库的 dataset_id，逗号分隔）
  kbDatasetIds: list('KB_DATASET_IDS'),
  retrievalTopK: num('RETRIEVAL_TOP_K', 8),
  retrievalSimThreshold: num('RETRIEVAL_SIM_THRESHOLD', 0.2),

  // 定稿归档回流的知识库（历史标书库）
  bidArchiveDatasetId: str('BID_ARCHIVE_DATASET_ID', ''),

  // 规则引擎口径（决定生效的暗标/地域模板，common_disclosure 始终叠加）
  // 注意：ruleIndustry 是「评标口径行业」（工程/房建/市政…），
  // 与知识库行业包（water.json 等）是两回事，不要混淆。
  ruleRegion: str('RULE_REGION', '河北省'),
  ruleCity: str('RULE_CITY', ''),
  ruleIndustry: str('RULE_INDUSTRY', '工程'),
  ruleTenderType: str('RULE_TENDER_TYPE', '工程'),

  // 调优
  complianceLlmCheckMax: num('COMPLIANCE_LLM_CHECK_MAX', 20),
  maxTextChars: num('MAX_TEXT_CHARS', 120_000),
  chunkSize: num('CHUNK_SIZE', 6000),
  chunkOverlap: num('CHUNK_OVERLAP', 400),
}
