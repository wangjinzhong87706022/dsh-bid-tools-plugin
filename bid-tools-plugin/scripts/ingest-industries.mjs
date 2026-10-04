#!/usr/bin/env node
/**
 * 行业知识包批量灌库脚本 —— 把 src/data/industries/*.json 建成 RAGFlow 可检索知识库。
 *
 * 用法：
 *   # 1) 仅产出某包的扁平化语料（不碰 RAGFlow，可直接检视/评审）
 *   node scripts/ingest-industries.mjs --pack water --dry-run
 *   node scripts/ingest-industries.mjs --all --dry-run
 *
 *   # 2) 真实灌库（需 RAGFlow 可达 + API Key）
 *   RAGFLOW_BASE_URL=http://<host>:9380 RAGFLOW_API_KEY=<key> \
 *     node scripts/ingest-industries.mjs --pack water --dataset-name "水利标书知识库"
 *   RAGFLOW_BASE_URL=... RAGFLOW_API_KEY=... \
 *     node scripts/ingest-industries.mjs --all        # 每个行业建一个独立知识库
 *
 *   # 3) 灌库后抽样验证检索
 *   RAGFLOW_BASE_URL=... RAGFLOW_API_KEY=... \
 *     node scripts/ingest-industries.mjs --pack water --verify "施工导流度汛方案"
 *
 * 默认（不带 --pack/--all）= 灌 water 包，向后兼容旧用法。
 *
 * 设计要点：
 *   - 扁平化粒度 = 一个逻辑单元一篇文档（章节/工法/资质/评分点/规范/风险/模板），
 *     让 RAGFlow 分块后检索命中更精准（而非整包一大块）。
 *   - 每篇带 tags（行业 + 单元类型 + 章节/层级），便于后续按口径过滤。
 *   - 零 LLM：纯结构化展开，可复现、可审计。
 *   - 真实灌库会先建库（同名库已存在则复用），逐篇上传并轮询解析状态至 DONE。
 *
 * 依赖：Node >= 18（fetch / FormData / Blob 均已内置）。
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const INDUSTRIES_DIR = path.join(ROOT, 'src/data/industries')

const ARGS = new Set(process.argv.slice(2))
const DRY_RUN = ARGS.has('--dry-run')
const ALL = ARGS.has('--all')
const PACK_ARG = (() => {
  const i = process.argv.indexOf('--pack')
  return i >= 0 ? process.argv[i + 1] : undefined
})()
const VERIFY = (() => {
  const i = process.argv.indexOf('--verify')
  return i >= 0 ? process.argv[i + 1] : undefined
})()
const DATASET_NAME = (() => {
  const i = process.argv.indexOf('--dataset-name')
  return i >= 0 ? process.argv[i + 1] : undefined
})()
const EMBEDDING_MODEL = process.env.RAGFLOW_EMBEDDING_MODEL || 'BGE-M3'

const BASE = (process.env.RAGFLOW_BASE_URL || 'http://127.0.0.1:9380').replace(/\/+$/, '')
const API_KEY = process.env.RAGFLOW_API_KEY || ''
const TIMEOUT_MS = Number(process.env.RAGFLOW_TIMEOUT_MS || 60000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function log(...a) { console.log('[ingest-industries]', ...a) }
function warn(...a) { console.warn('[ingest-industries] WARN', ...a) }

// ------------------------------------------------------------------ 发现包
async function discoverPacks() {
  const files = (await readdir(INDUSTRIES_DIR)).filter((f) => f.endsWith('.json'))
  const packs = []
  for (const f of files) {
    const p = JSON.parse(await readFile(path.join(INDUSTRIES_DIR, f), 'utf8'))
    packs.push({ file: f, pack: p })
  }
  return packs
}

function pickPacks(all) {
  if (ALL) return all
  if (PACK_ARG) {
    const hit = all.find(
      ({ pack, file }) => pack.pack_key === PACK_ARG || file.replace(/\.json$/, '') === PACK_ARG,
    )
    if (!hit) throw new Error(`未找到行业包 "${PACK_ARG}"（可用：${all.map((x) => x.pack.pack_key).join(', ')}）`)
    return [hit]
  }
  const water = all.find(({ pack }) => pack.pack_key === 'water')
  if (!water) throw new Error('默认 water 包不存在')
  return [water]
}

// ------------------------------------------------------------------ 扁平化（通用，防御性 ?? []）
function buildDocs(pack) {
  const tagBase = pack.industry || pack.pack_key
  const docs = []
  docs.push({
    id: `${pack.pack_key}__overview`,
    title: `${pack.name} · 知识包总览`,
    tags: [tagBase, 'overview'],
    content: [
      `# ${pack.name} 知识包总览`,
      '',
      pack.description,
      '',
      pack.sub_domains?.length ? `细分领域：${pack.sub_domains.join('、')}` : '',
      `关键词：${(pack.keywords || []).join('、')}`,
      '',
      `版本：${pack.version}`,
    ].filter(Boolean).join('\n'),
  })

  for (const s of pack.outline || []) {
    docs.push({
      id: `${pack.pack_key}__outline_${s.code}`,
      title: `章节${s.code} ${s.title}`,
      tags: [tagBase, 'outline', `section-${s.code}`],
      content: [
        `# 章节 ${s.code}：${s.title}`,
        '',
        '## 编写要点',
        ...(s.key_points || []).map((k) => `- ${k}`),
        '',
        '## 写作指引',
        s.writing_guide || '',
        '',
        '## 常见雷区',
        ...(s.common_traps || []).map((t) => `- ${t}`),
      ].join('\n'),
    })
  }

  ;(pack.methods || []).forEach((m, i) => {
    docs.push({
      id: `${pack.pack_key}__method_${i + 1}`,
      title: `工法 ${m.name}`,
      tags: [tagBase, 'method', m.category],
      content: [
        `# 关键工法：${m.name}`,
        '',
        `分类：${m.category}　风险等级：${m.risk_level}`,
        '',
        '## 关键控制点',
        ...(m.key_controls || []).map((k) => `- ${k}`),
      ].join('\n'),
    })
  })

  ;(pack.qualifications || []).forEach((q, i) => {
    docs.push({
      id: `${pack.pack_key}__qual_${i + 1}`,
      title: `资质 ${q.name}`,
      tags: [tagBase, 'qualification'],
      content: [
        `# 资质要求：${q.name}`,
        '',
        `等级：${(q.levels || []).join(' / ')}`,
        `依据：${q.basis || ''}`,
        `说明：${q.note || ''}`,
      ].join('\n'),
    })
  })

  ;(pack.score_points || []).forEach((p, i) => {
    docs.push({
      id: `${pack.pack_key}__score_${i + 1}`,
      title: `评分点 ${p.item}`,
      tags: [tagBase, 'score_point'],
      content: [
        `# 评分点：${p.item}`,
        '',
        `常见分值区间：${p.typical_range || ''}`,
        '',
        '## 评分关注',
        ...(p.scoring_focus || []).map((x) => `- ${x}`),
        '',
        '## 易扣分雷区',
        ...(p.lose_point_traps || []).map((x) => `- ${x}`),
      ].join('\n'),
    })
  })

  ;(pack.regulations || []).forEach((r, i) => {
    docs.push({
      id: `${pack.pack_key}__reg_${i + 1}`,
      title: `规范 ${r.name} ${r.doc_no || ''}`,
      tags: [tagBase, 'regulation', r.level],
      content: [
        `# 规范：${r.name}（${r.doc_no || ''}）`,
        '',
        `层级：${r.level || ''}`,
        `关键条款：${r.key_articles || ''}`,
      ].join('\n'),
    })
  })

  ;(pack.risks || []).forEach((rk, i) => {
    docs.push({
      id: `${pack.pack_key}__risk_${i + 1}`,
      title: `风险 ${rk.name}`,
      tags: [tagBase, 'risk', rk.category, rk.severity],
      content: [
        `# 风险：${rk.name}`,
        '',
        `类别：${rk.category}　严重程度：${rk.severity}`,
        '',
        `描述：${rk.description || ''}`,
        '',
        `防控：${rk.mitigation || ''}`,
      ].join('\n'),
    })
  })

  ;(pack.templates || []).forEach((t, i) => {
    docs.push({
      id: `${pack.pack_key}__tpl_${i + 1}`,
      title: `模板 ${t.name}`,
      tags: [tagBase, 'template', `section-${t.section}`],
      content: [
        `# 模板：${t.name}`,
        '',
        `对应章节：${t.section}`,
        '',
        '```',
        t.body || '',
        '```',
      ].join('\n'),
    })
  })

  return docs
}

// ------------------------------------------------------------------ RAGFlow 客户端
async function ragflowReq(method, p, { json, form } = {}) {
  if (!API_KEY) throw new Error('RAGFLOW_API_KEY 未配置')
  const headers = { Authorization: `Bearer ${API_KEY}` }
  const init = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) }
  if (json) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(json)
  }
  if (form) init.body = form // FormData 自带 boundary
  let resp
  try {
    resp = await fetch(`${BASE}${p}`, init)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|connect/i.test(msg)) {
      throw new Error(`RAGFlow 不可达（${BASE}）：${msg}。请确认服务已启动/端口转发，并设置 RAGFLOW_BASE_URL 与 RAGFLOW_API_KEY。`)
    }
    throw e
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} @ ${p}`)
  const data = await resp.json()
  if (data.code !== 0) throw new Error(`业务错误 ${data.code}：${data.message || 'unknown'}`)
  return data.data
}

function docsOf(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.docs)) return data.docs
  return []
}

async function ensureDataset(name) {
  const list = docsOf(await ragflowReq('GET', '/api/v1/datasets'))
  const found = list.find((d) => d.name === name)
  if (found) {
    log(`复用已存在知识库 "${name}" (id=${found.id})`)
    return found.id
  }
  const created = await ragflowReq('POST', '/api/v1/datasets', {
    json: {
      name,
      description: `标书知识库（${name}，自动灌库，BGE-M3 嵌入）`,

      embedding_model: EMBEDDING_MODEL,
      permission: 'me',
    },
  })
  log(`已创建知识库 "${name}" (id=${created.id})`)
  return created.id
}

async function uploadDoc(datasetId, corpusDir, doc) {
  const file = `${doc.id}.md`
  const tmp = path.join(corpusDir, file)
  await writeFile(tmp, doc.content, 'utf8')
  const form = new FormData()
  form.append('file', new Blob([await readFile(tmp)]), file)
  form.append('meta', JSON.stringify({ title: doc.title, tags: doc.tags }))
  const res = docsOf(await ragflowReq('POST', `/api/v1/datasets/${datasetId}/documents`, { form }))
  return res[0]?.id
}

async function triggerParse(docIds) {
  return ragflowReq('POST', '/api/v1/documents/ingest', { json: { doc_ids: docIds, run: 1 } })
}

async function waitParsed(datasetId, docId) {
  for (let i = 0; i < 40; i++) {
    const lst = docsOf(
      await ragflowReq('GET', `/api/v1/datasets/${datasetId}/documents?id=${encodeURIComponent(docId)}&page=1&page_size=1`),
    )
    const d = lst.find((x) => x.id === docId) || lst[0]
    if (d?.run === 'DONE') return 'DONE'
    if (d?.run === 'FAIL') return 'FAIL'
    await sleep(2000)
  }
  return 'TIMEOUT'
}

async function verifyRetrieval(datasetId, question) {
  const data = await ragflowReq('POST', '/api/v1/retrieval', {
    json: {
      question,
      dataset_ids: [datasetId],
      top_k: 5,
      page: 1,
      page_size: 5,
      similarity_threshold: 0.2,
      vector_similarity_weight: 0.3,
    },
  })
  const chunks = (data && data.chunks) || []
  log(`verify 检索 "${question}" 命中 ${chunks.length} 块：`)
  for (const c of chunks) {
    const txt = (c.content || '').replace(/\s+/g, ' ').slice(0, 80)
    log(`  - [${c.document_name || c.doc_name || '?'}] ${txt}`)
  }
  return chunks.length
}

// ------------------------------------------------------------------ 单包处理
async function ingestPack({ pack, file }, datasetNameOverride) {
  const corpusDir = path.join(INDUSTRIES_DIR, `${pack.pack_key}_corpus`)
  const docs = buildDocs(pack)
  log(`[${pack.pack_key}] 扁平化完成：${docs.length} 篇（${pack.name} v${pack.version}）`)

  if (DRY_RUN) {
    await mkdir(corpusDir, { recursive: true })
    for (const d of docs) await writeFile(path.join(corpusDir, `${d.id}.md`), d.content, 'utf8')
    log(`[${pack.pack_key}] --dry-run：语料已写入 ${corpusDir}（${docs.length} 篇 .md）`)
    return null
  }

  if (!API_KEY) throw new Error('真实灌库需要 RAGFLOW_API_KEY。当前未配置（或服务不可达）。')
  const datasetName = datasetNameOverride || `标书知识库·${pack.name}`
  const datasetId = await ensureDataset(datasetName)
  await mkdir(corpusDir, { recursive: true })
  let ok = 0
  let fail = 0
  const docIds = []
  const idByTitle = new Map()
  for (const d of docs) {
    try {
      const id = await uploadDoc(datasetId, corpusDir, d)
      if (id) { docIds.push(id); idByTitle.set(d.title, id) }
    } catch (e) {
      fail++
      warn(`  ✗ ${d.title}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (docIds.length) await triggerParse(docIds)
  for (const d of docs) {
    const id = idByTitle.get(d.title)
    const st = id ? await waitParsed(datasetId, id) : 'NO_ID'
    if (st === 'DONE') { ok++; log(`  ✓ ${d.title} 解析完成`) }
    else { fail++; warn(`  ✗ ${d.title} 状态=${st}`) }
  }
  log(`[${pack.pack_key}] 灌库完成：成功 ${ok} / 失败 ${fail} / 共 ${docs.length}（dataset_id=${datasetId}）`)
  if (VERIFY && fail === 0) await verifyRetrieval(datasetId, VERIFY)
  return datasetId
}

// ------------------------------------------------------------------ main
async function main() {
  const all = await discoverPacks()
  const selected = pickPacks(all)
  log(`已选择 ${selected.length} 个行业包：${selected.map((s) => s.pack.pack_key).join(', ')}`)
  if (DRY_RUN) log('（--dry-run 模式：只产出语料，不碰 RAGFlow）')

  const ids = []
  for (const s of selected) {
    const id = await ingestPack(s, selected.length === 1 ? DATASET_NAME : undefined)
    if (id) ids.push({ key: s.pack.pack_key, id })
  }

  if (DRY_RUN) {
    log('下一步：设置 RAGFLOW_BASE_URL / RAGFLOW_API_KEY 后去掉 --dry-run 重跑即可（--all 批量，--pack <key> 单包）。')
    log('建库成功后请把对应 dataset id 回填到 KB_DATASET_IDS（检索取材）与 BID_ARCHIVE_DATASET_ID（归档）。')
    return
  }
  log(`全部完成。dataset 清单：${ids.map((x) => `${x.key}=${x.id}`).join(' ')}（请回填环境变量）`)
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[ingest-industries] ERROR', err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
