# -*- coding: utf-8 -*-
"""标书工具集 MCP Server（bid-tools）。

对应标书六步流程中的**确定性环节**，由 DSH「标书写作」技能编排调用：

  tender_extract_requirements  -> 步骤① 解析招标文件，产出结构化要求清单
  kb_search_materials          -> 步骤③ 分章检索取材（RAGFlow 检索，带来源）
  bid_check_compliance         -> 步骤⑤ 合规自查，产出响应点偏离表
  bid_archive_final            -> 步骤⑥ 定稿归档回流历史标书库

步骤②④（LLM 生成大纲/长文）由技能层直接调 LLM；步骤⑥的人工审校是 HITL 卡点，
审校通过后技能层再调用 bid_archive_final 归档。

启动：python server.py（默认 streamable-http，监听 :8300，MCP 端点 /mcp）
"""
from __future__ import annotations

import json
import logging
import re
from typing import List, Optional

from mcp.server.fastmcp import FastMCP

import config
from llm_client import LLMClient, LLMError
from ragflow_client import RagflowClient, RagflowError
from schemas import (
    ComplianceItem,
    ComplianceReport,
    RequirementItem,
    RequirementList,
    SingleCheck,
    requirements_from_llm_json,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("bid-tools")

mcp = FastMCP("bid-tools", host=config.MCP_HOST, port=config.MCP_PORT)
llm = LLMClient()
rag = RagflowClient()


# --------------------------------------------------------------------------
# 内部工具函数
# --------------------------------------------------------------------------

def _clip(text: str) -> str:
    return text if len(text) <= config.MAX_TEXT_CHARS else text[: config.MAX_TEXT_CHARS] + "\n…[截断]"


def _split_chunks(text: str) -> List[str]:
    """按段落边界切块，块间保留少量重叠，避免评分表格被拦腰切断。"""
    text = _clip(text)
    size = config.CHUNK_SIZE
    overlap = 400
    chunks: List[str] = []
    pos = 0
    while pos < len(text):
        end = min(pos + size, len(text))
        if end < len(text):
            # 从块尾向前找段落分隔，尽量在段落边界切
            cut = text.rfind("\n\n", pos + size - 800, end)
            if cut > pos:
                end = cut
        chunks.append(text[pos:end])
        if end >= len(text):
            break
        pos = end - overlap if end > overlap else end
    return chunks


EXTRACT_SYSTEM = (
    "你是资深招投标文件分析师。从招标文件片段中抽取结构化要求，"
    "类别限定为：评分点、资质门槛、技术参数、商务条款、废标条款。"
    "保留原文中的关键数字、时间、金额、等级等限定词；"
    "为每条要求给出 2~5 个原文实词关键词（用于后续在标书草稿中定位响应内容）；"
    "资质门槛与废标条款一律视为强制项。不编造片段中不存在的要求。"
)

COMPLIANCE_SYSTEM = (
    "你是投标合规审查员。判断标书草稿是否响应了给定的招标要求，"
    "结论只能是：完全响应 / 偏离 / 缺失。"
    "完全响应=草稿中有实质响应且关键限定一致；"
    "偏离=有相关内容但关键限定（数量/时间/等级/范围）不一致；"
    "缺失=草稿完全没有响应。给出结论对应的草稿原文片段作为证据，"
    "偏离时附一句修改建议。不臆测草稿中不存在的内容。"
)


async def _llm_semantic_check(req: RequirementItem, draft: str) -> ComplianceItem:
    """关键词未命中时，交 LLM 做语义复核。"""
    try:
        result = await llm.chat_json(
            COMPLIANCE_SYSTEM,
            f"【招标要求】{req.content}\n\n【标书草稿节选】{draft[:8000]}",
            schema=SingleCheck,
        )
    except Exception:  # noqa: BLE001 - LLM 复核失败时降级为缺失，不阻塞整份报告
        log.exception("要求 %s 的 LLM 复核失败", req.id)
        return ComplianceItem(
            requirement_id=req.id,
            requirement_content=req.content,
            status="缺失",
            evidence="",
            comment="语义复核失败，请人工确认",
        )
    return ComplianceItem(
        requirement_id=req.id,
        requirement_content=req.content,
        status=result.status,
        evidence=result.evidence,
        comment=result.comment,
    )


def _find_evidence(draft: str, keywords: List[str], width: int = 80) -> str:
    """在草稿中定位关键词，返回上下文片段作为证据。"""
    low = draft.lower()
    for kw in keywords:
        idx = low.find(kw.lower())
        if idx >= 0:
            start = max(0, idx - width)
            end = min(len(draft), idx + len(kw) + width)
            return re.sub(r"\s+", " ", draft[start:end]).strip()
    return ""


# --------------------------------------------------------------------------
# MCP 工具
# --------------------------------------------------------------------------

@mcp.tool()
async def tender_extract_requirements(
    tender_text: str,
    tender_name: str = "",
) -> str:
    """解析招标文件全文，抽取结构化要求清单（评分点/资质门槛/技术参数/商务条款/废标条款）。

    对应标书流程步骤①。产物 JSON 是后续大纲生成（步骤②）与合规自查（步骤⑤）的指挥棒。

    Args:
        tender_text: 招标文件全文文本（已由 MinerU/DeepDoc 解析为纯文本/Markdown）。
        tender_name: 项目或标段名称，可选。

    Returns:
        JSON 字符串：RequirementList 结构，items 内每条含 id/category/content/mandatory/keywords。
    """
    if not tender_text.strip():
        return json.dumps({"error": "tender_text 为空"}, ensure_ascii=False)

    chunks = _split_chunks(tender_text)
    log.info("招标文件共 %d 块，开始抽取", len(chunks))
    merged: List[RequirementItem] = []
    seen_contents: set[str] = set()

    for i, chunk in enumerate(chunks, 1):
        user = f"【项目名称】{tender_name or '未知'}\n\n【文件片段 {i}/{len(chunks)}】\n{chunk}"
        try:
            part = await llm.chat_json(
                EXTRACT_SYSTEM,
                user,
                schema=RequirementList,
                hint="本片段若无任何要求可返回空 items；id 用 R001 起的局部编号，合并时会被重编。",
                max_tokens=8192,
            )
        except LLMError as exc:
            log.error("片段 %d 抽取失败：%s", i, exc)
            continue

        for item in part.items:
            # 跨块去重：内容前 40 字相同视为同一条（块间有重叠）
            key = re.sub(r"\s+", "", item.content)[:40]
            if key in seen_contents:
                continue
            seen_contents.add(key)
            item.id = f"R{len(merged) + 1:03d}"
            item.source_chunk = f"片段{i}/{len(chunks)}"
            merged.append(item)

    report = RequirementList(tender_name=tender_name, items=merged)
    log.info("抽取完成：%d 条要求", len(merged))
    return report.model_dump_json()


@mcp.tool()
async def kb_search_materials(
    question: str,
    dataset_ids: Optional[List[str]] = None,
    top_k: int = 0,
) -> str:
    """按章节主题定向检索知识库，返回带来源的素材段落（供 LLM 写作时引用）。

    对应标书流程步骤③。检索在 RAGFlow 内完成（BGE-M3 召回 + Reranker 精排），
    本工具不调用 LLM。不传 dataset_ids 时使用 .env 配置的默认知识库。

    Args:
        question: 检索问题，如"XX 行业类似项目的实施与验收情况"。
        dataset_ids: 知识库 ID 列表，可选；为空时用 KB_DATASET_IDS。
        top_k: 返回条数，默认取服务端配置（8）。

    Returns:
        JSON 字符串：{"question", "results": [{source, similarity, content, dataset_id}]}
    """
    ids = dataset_ids or config.KB_DATASET_IDS
    k = top_k or config.RETRIEVAL_TOP_K
    try:
        chunks = await rag.retrieval(question, ids, k)
    except RagflowError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)

    results = [
        {
            "source": c.get("document_keyword") or c.get("docnm_kwd") or "未知文档",
            "similarity": c.get("similarity"),
            "content": (c.get("content") or "")[:2000],
            "dataset_id": c.get("dataset_id"),
            "document_id": c.get("document_id"),
        }
        for c in chunks
    ]
    log.info("检索「%s」命中 %d 条", question[:40], len(results))
    return json.dumps({"question": question, "results": results}, ensure_ascii=False)


@mcp.tool()
async def bid_check_compliance(
    requirements_json: str,
    draft_text: str,
) -> str:
    """对照招标要求清单逐条核查标书草稿，产出响应点偏离表。

    对应标书流程步骤⑤。先做关键词规则比对（快速、可复现），
    未命中的条目再交 LLM 语义复核（有上限，防止打爆 LLM）。
    「缺失」条目应回流到步骤③补素材。

    Args:
        requirements_json: tender_extract_requirements 返回的要求清单 JSON。
        draft_text: 标书草稿全文（或待核查章节全文）。

    Returns:
        JSON 字符串：ComplianceReport 结构，含 total/fully_met/deviated/missing/items。
    """
    try:
        req_data = json.loads(requirements_json)
        reqs = requirements_from_llm_json(req_data).items
    except (json.JSONDecodeError, ValueError) as exc:
        return json.dumps({"error": f"要求清单解析失败: {exc}"}, ensure_ascii=False)

    draft = _clip(draft_text)
    draft_low = draft.lower()
    items: List[ComplianceItem] = []
    llm_pending: List[RequirementItem] = []

    for req in reqs:
        hits = [kw for kw in req.keywords if kw.lower() in draft_low]
        if len(hits) >= max(1, len(req.keywords) // 2):
            items.append(
                ComplianceItem(
                    requirement_id=req.id,
                    requirement_content=req.content,
                    status="完全响应",
                    evidence=_find_evidence(draft, req.keywords),
                    comment="",
                )
            )
        else:
            llm_pending.append(req)

    # LLM 语义复核（限流）
    for req in llm_pending[: config.COMPLIANCE_LLM_CHECK_MAX]:
        items.append(await _llm_semantic_check(req, draft))
    for req in llm_pending[config.COMPLIANCE_LLM_CHECK_MAX :]:
        items.append(
            ComplianceItem(
                requirement_id=req.id,
                requirement_content=req.content,
                status="缺失",
                evidence="",
                comment="超出自动复核上限，请人工核查",
            )
        )

    report = ComplianceReport(
        total=len(items),
        fully_met=sum(1 for x in items if x.status == "完全响应"),
        deviated=sum(1 for x in items if x.status == "偏离"),
        missing=sum(1 for x in items if x.status == "缺失"),
        items=items,
    )
    log.info("合规自查完成：%d 条（响应%d/偏离%d/缺失%d）", report.total, report.fully_met, report.deviated, report.missing)
    return report.model_dump_json()


@mcp.tool()
async def bid_archive_final(
    file_path: str,
    project: str,
    client: str = "",
    industry: str = "",
    year: int = 0,
    result: str = "",
) -> str:
    """将人工审校定稿的标书归档到"历史标书库"知识库，供后续标书写作检索复用。

    对应标书流程步骤⑥的收尾动作。调用前必须已完成人工审校（HITL 卡点在技能层）。

    Args:
        file_path: 定稿文档的绝对路径（docx/pdf/md 均可，RAGFlow 会自动解析）。
        project: 项目名称（作为检索标签）。
        client: 客户名称，可选。
        industry: 行业领域，可选。
        year: 投标年份，可选。
        result: 结果：中标/落标/进行中，可选。

    Returns:
        JSON 字符串：{"ok", "document_id", "message"}
    """
    if not config.BID_ARCHIVE_DATASET_ID:
        return json.dumps({"error": "未配置 BID_ARCHIVE_DATASET_ID（历史标书库）"}, ensure_ascii=False)
    try:
        info = await rag.upload_document(config.BID_ARCHIVE_DATASET_ID, file_path)
    except RagflowError as exc:
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
    meta = {k: v for k, v in {"project": project, "client": client, "industry": industry, "year": year, "result": result}.items() if v}
    log.info("定稿归档成功：%s，元数据 %s", file_path, meta)
    return json.dumps(
        {"ok": True, "document_id": info.get("id", ""), "message": f"已归档：{project}，元数据 {meta}"},
        ensure_ascii=False,
    )


if __name__ == "__main__":
    mcp.run(transport=config.MCP_TRANSPORT)
