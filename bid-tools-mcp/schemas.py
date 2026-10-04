# -*- coding: utf-8 -*-
"""结构化数据模型：招标要求清单、合规自查报告。

schema 既是 LLM 抽取的强校验标准（不合格打回重抽），
也是 MCP 工具返回给技能编排层的稳定契约。
"""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

RequirementCategory = Literal[
    "评分点",        # 评分办法里的打分项
    "资质门槛",      # 投标资格硬性要求
    "技术参数",      # 技术规格/性能指标
    "商务条款",      # 工期、付款、质保、售后等
    "废标条款",      # 触发即废标的红线项
]


class RequirementItem(BaseModel):
    """单条招标要求。"""

    id: str = Field(description="要求编号，如 R001，跨块合并后全局唯一")
    category: RequirementCategory = Field(description="要求类别")
    content: str = Field(min_length=4, description="要求内容的一句话表述（保留原文关键数字与限定词）")
    mandatory: bool = Field(default=True, description="是否强制项（废标条款/资格门槛恒为 true）")
    keywords: List[str] = Field(
        default_factory=list,
        min_length=0,
        description="用于在标书草稿中定位响应内容的 2~5 个关键词（取原文实词）",
    )
    source_chunk: Optional[str] = Field(default=None, description="出处（页码/章节线索，便于溯源）")


class RequirementList(BaseModel):
    """招标要求清单——整本标书的指挥棒。"""

    tender_name: str = Field(default="", description="项目/标段名称")
    items: List[RequirementItem] = Field(default_factory=list)


ComplianceStatus = Literal["完全响应", "偏离", "缺失"]


class ComplianceItem(BaseModel):
    """单条要求的核查结论。"""

    requirement_id: str
    requirement_content: str
    status: ComplianceStatus
    evidence: str = Field(default="", description="标书草稿中响应该要求的原文片段（≤160 字）；缺失时为空")
    comment: str = Field(default="", description="偏离原因或补写建议")


class SingleCheck(BaseModel):
    """LLM 语义复核单条要求的结论。"""

    status: ComplianceStatus = Field(description="结论：完全响应 / 偏离 / 缺失")
    evidence: str = Field(default="", description="草稿中的响应原文片段，缺失时为空")
    comment: str = Field(default="", description="偏离原因或补写建议，可为空")


class ComplianceReport(BaseModel):
    """响应点偏离表——合规自查工具的输出。"""

    total: int = Field(description="核查要求总条数")
    fully_met: int = 0
    deviated: int = 0
    missing: int = 0
    items: List[ComplianceItem] = Field(default_factory=list)


def requirements_from_llm_json(data: dict) -> RequirementList:
    """把 LLM 返回的 JSON 宽松转换为 RequirementList（容忍字段缺失）。"""
    items = []
    for i, raw in enumerate(data.get("items", []), start=1):
        if not isinstance(raw, dict):
            continue
        content = str(raw.get("content", "")).strip()
        if len(content) < 4:  # 过滤空壳条目
            continue
        cat = raw.get("category", "商务条款")
        if cat not in ("评分点", "资质门槛", "技术参数", "商务条款", "废标条款"):
            cat = "商务条款"
        kws = raw.get("keywords") or []
        if not isinstance(kws, list):
            kws = []
        items.append(
            RequirementItem(
                id=f"R{len(items) + 1:03d}",  # 过滤脏数据后连续重编号，不留下空洞
                category=cat,  # type: ignore[arg-type]
                content=content,
                mandatory=bool(raw.get("mandatory", cat in ("废标条款", "资质门槛"))),
                keywords=[str(k) for k in kws if str(k).strip()][:5],
                source_chunk=raw.get("source_chunk"),
            )
        )
    return RequirementList(tender_name=str(data.get("tender_name", "")), items=items)
