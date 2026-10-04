/** RAGFlow v0.27.1 HTTP API 客户端：检索取材 + 定稿归档。部署后按实际版本核验字段名。 */
import { readFile } from 'node:fs/promises'
import { config } from './config.ts'
import type { RagChunk } from './types.ts'

export class RagflowError extends Error {}

function authHeaders(): Record<string, string> {
  if (!config.ragflowApiKey) throw new RagflowError('RAGFLOW_API_KEY 未配置，检索/归档工具不可用')
  return { Authorization: `Bearer ${config.ragflowApiKey}` }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${config.ragflowBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.ragflowTimeoutMs),
  })
  if (!resp.ok) throw new RagflowError(`RAGFlow 请求失败 ${path}: HTTP ${resp.status}`)
  const data = (await resp.json()) as { code?: number; message?: string; data?: T }
  if (data.code !== 0) throw new RagflowError(`RAGFlow 业务错误 ${path}: ${data.message ?? 'unknown'}`)
  return (data.data ?? ({} as T)) as T
}

/** 知识库检索：BGE 向量召回 + Reranker 精排在 RAGFlow 内完成，返回带来源的 chunk。 */
export async function retrieval(question: string, datasetIds: string[], topK: number): Promise<RagChunk[]> {
  if (datasetIds.length === 0) throw new RagflowError('dataset_ids 为空：请配置 KB_DATASET_IDS 或在参数中传入')
  const data = await postJson<{ chunks?: RagChunk[] }>('/api/v1/retrieval', {
    question,
    dataset_ids: datasetIds,
    top_k: topK,
    page: 1,
    page_size: topK,
    similarity_threshold: config.retrievalSimThreshold,
    vector_similarity_weight: 0.3, // 0.7 权重给关键词/BM25，标书术语匹配更稳
    rerank_id: '', // 留空用数据集默认；已配置 BGE-Reranker 模型时可在此指定
  })
  return data.chunks ?? []
}

/** 上传文档到指定知识库（定稿归档回流）。返回 RAGFlow 文档信息（含 id）。 */
export async function uploadDocument(
  datasetId: string,
  filePath: string,
  displayName?: string,
): Promise<{ id?: string }> {
  let buf: Buffer
  try {
    buf = await readFile(filePath)
  } catch {
    throw new RagflowError(`文件不存在或不可读: ${filePath}`)
  }
  const name = displayName ?? filePath.split(/[\\/]/).pop() ?? 'bid.docx'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buf)]), name)
  const resp = await fetch(`${config.ragflowBaseUrl}/api/v1/datasets/${datasetId}/documents`, {
    method: 'POST',
    headers: { ...authHeaders() }, // 不手动设 Content-Type，让 fetch 带 FormData boundary
    body: form,
    signal: AbortSignal.timeout(config.ragflowTimeoutMs),
  })
  if (!resp.ok) throw new RagflowError(`上传失败 ${name}: HTTP ${resp.status}`)
  const data = (await resp.json()) as { code?: number; message?: string; data?: Array<{ id?: string }> }
  if (data.code !== 0) throw new RagflowError(`上传业务错误: ${data.message ?? 'unknown'}`)
  return data.data?.[0] ?? {}
}
