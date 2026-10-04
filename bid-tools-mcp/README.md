# bid-tools — 标书工具集 MCP Server

灵知/DSH「标书写作」技能的**确定性工具层**（plugin）。对应标书六步流程：

| 六步流程 | 实现层 | 本工程 |
|---------|--------|--------|
| ① 解析招标文件 | 本服务 | `tender_extract_requirements` |
| ② 生成章节大纲 | DSH 技能直调 LLM | — |
| ③ 分章检索取材 | 本服务 | `kb_search_materials` |
| ④ 分章生成长文 | DSH 技能直调 LLM | — |
| ⑤ 合规自查 | 本服务 | `bid_check_compliance` |
| ⑥ 人工审校（HITL）+ 归档回流 | 技能卡点 + 本服务 | `bid_archive_final` |

设计原则：确定性步骤代码化（可测试、可复现、可审计），生成性步骤留给 LLM，
关键结论（要求清单、偏离表）带 schema 强校验与来源溯源。

## 工程结构

```
bid-tools-mcp/
├── server.py          # MCP 入口：4 个工具定义
├── schemas.py         # RequirementList / ComplianceReport 等 pydantic 契约
├── llm_client.py      # vLLM OpenAI 兼容客户端（JSON 输出 + schema 强校验 + 重试）
├── ragflow_client.py  # RAGFlow HTTP API 客户端（检索 / 上传归档）
├── config.py          # 环境变量集中管理
├── .env.example       # 配置模板（复制为 .env）
├── requirements.txt
├── Dockerfile
└── docker-compose.yml
```

## 快速开始

### 1. 本地运行（联调）

```bash
cd bid-tools-mcp
pip install -r requirements.txt
cp .env.example .env   # 填入 LLM/RAGFlow 地址与 API KEY
python server.py       # MCP 端点 http://127.0.0.1:8300/mcp
```

用 MCP Inspector 调试：

```bash
npx @modelcontextprotocol/inspector
# Transport 选 Streamable HTTP，URL 填 http://127.0.0.1:8300/mcp
```

### 2. Docker 部署（应用服务器）

```bash
docker compose up -d --build
docker logs -f bid-tools-mcp
```

> 注意：`bid_archive_final` 的 `file_path` 是**容器内路径**。定稿文件若在宿主机，
> 放入 `./data/`（已挂载到容器 `/data`），传 `/data/xxx.docx`。

### 3. 注册进灵知

在灵知「专家协同 → 外部连接」中新增 MCP 连接：

- URL：`http://<应用服务器IP>:8300/mcp`
- 传输：Streamable HTTP
- 注册后在「工具箱」确认 4 个工具已出现，再在技能工坊的"标书写作"技能中勾选。

## 工具契约速览

### tender_extract_requirements(tender_text, tender_name) -> JSON
要求清单：`{tender_name, items: [{id, category, content, mandatory, keywords, source_chunk}]}`。
长文自动分块抽取（块间重叠防截断），跨块去重、全局重编号。

### kb_search_materials(question, dataset_ids?, top_k?) -> JSON
`{question, results: [{source, similarity, content, dataset_id, document_id}]}`。
每条素材带文档来源，供技能层做引用溯源。

### bid_check_compliance(requirements_json, draft_text) -> JSON
响应点偏离表：`{total, fully_met, deviated, missing, items: [{requirement_id, status, evidence, comment}]}`。
规则比对优先（关键词命中），未命中走 LLM 语义复核（上限 `COMPLIANCE_LLM_CHECK_MAX`）。
**「缺失」条目应回流步骤③补素材。**

### bid_archive_final(file_path, project, client?, industry?, year?, result?) -> JSON
定稿上传到历史标书库（`BID_ARCHIVE_DATASET_ID`），返回 `document_id`。
调用前提：人工审校已完成。

## 部署核验清单（上线前必做）

1. **RAGFlow API 冒烟**：本工程按 RAGFlow 官方 `/api/v1/retrieval`、
   `/api/v1/datasets/{id}/documents` 实现，请对照部署的 0.27.1 实际版本核验字段名
   （尤其 retrieval 返回的 `chunks[].document_keyword/similarity`）。
2. **LLM 连通**：`curl http://<LLM_IP>:8000/v1/models` 确认模型名与 `LLM_MODEL` 一致。
3. **128K 注意**：`tender_text` 超过 `MAX_TEXT_CHARS` 会截断，超大标书建议先分卷。
4. **权限**：RAGFlow API KEY 具备对应 dataset 的读写权；该 KEY 不要下发到办公网侧。
5. **最小闭环优先**：先只验 `tender_extract_requirements` + `kb_search_materials` 两个工具，
   跑通"解析→检索→生成"主线，再接合规自查与归档。

## 已知边界

- 招标文件需先经 MinerU/DeepDoc 解析为文本再传入（本服务不做 PDF 解析）。
- `bid_check_compliance` 的关键词规则比对是"快速通道"，语义边界情况以 LLM 复核为准，
  最终结论仍应经人工审校确认。
- 技能层（DSH 技能工坊）的编排格式以灵知开发方提供的规范为准；本服务只保证 MCP 协议稳定。
