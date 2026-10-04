# -*- coding: utf-8 -*-
"""RAGFlow v0.27.1 HTTP API 客户端：检索取材 + 定稿归档。

接口路径遵循 RAGFlow 官方 HTTP API（/api/v1/...，Bearer 认证）。
部署后请用 README 里的冒烟脚本对照实际版本核验一遍字段名。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

import config

log = logging.getLogger("bid-tools.ragflow")


class RagflowError(RuntimeError):
    pass


class RagflowClient:
    def __init__(self) -> None:
        if not config.RAGFLOW_API_KEY:
            log.warning("RAGFLOW_API_KEY 未配置，检索/归档工具将不可用")
        self._client = httpx.AsyncClient(
            base_url=config.RAGFLOW_BASE_URL.rstrip("/"),
            headers={
                "Authorization": f"Bearer {config.RAGFLOW_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=config.RAGFLOW_TIMEOUT,
        )

    async def _post(self, path: str, json: Dict[str, Any]) -> Dict[str, Any]:
        try:
            resp = await self._client.post(path, json=json)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise RagflowError(f"RAGFlow 请求失败 {path}: {exc}") from exc
        data = resp.json()
        if data.get("code") != 0:
            raise RagflowError(f"RAGFlow 业务错误 {path}: {data.get('message', data)}")
        return data.get("data", {})

    async def retrieval(
        self,
        question: str,
        dataset_ids: List[str],
        top_k: int,
        page: int = 1,
    ) -> List[Dict[str, Any]]:
        """知识库检索：返回带来源的 chunk 列表（BGE 向量召回 + Reranker 精排在 RAGFlow 内完成）。"""
        if not dataset_ids:
            raise RagflowError("dataset_ids 为空：请在 .env 配置 KB_DATASET_IDS 或在参数中显式传入")
        payload = {
            "question": question,
            "dataset_ids": dataset_ids,
            "top_k": top_k,
            "page": page,
            "page_size": top_k,
            "similarity_threshold": config.RETRIEVAL_SIM_THRESHOLD,
            "vector_similarity_weight": 0.3,  # 0.7 权重给关键词/BM25，标书术语匹配更稳
            "rerank_id": "",                  # 留空使用数据集默认；如配置了 BGE-Reranker 模型可在此指定
        }
        data = await self._post("/api/v1/retrieval", payload)
        return data.get("chunks", [])

    async def upload_document(
        self,
        dataset_id: str,
        file_path: str,
        display_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """上传文档到指定知识库（定稿归档回流）。返回 RAGFlow 的文档信息（含 id）。"""
        path = Path(file_path)
        if not path.is_file():
            raise RagflowError(f"文件不存在: {file_path}")
        name = display_name or path.name
        try:
            resp = await self._client.post(
                f"/api/v1/datasets/{dataset_id}/documents",
                files={"file": (name, path.open("rb"), "application/octet-stream")},
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise RagflowError(f"上传失败 {name}: {exc}") from exc
        data = resp.json()
        if data.get("code") != 0:
            raise RagflowError(f"上传业务错误: {data.get('message', data)}")
        docs = (data.get("data") or []) if isinstance(data.get("data"), list) else []
        return docs[0] if docs else {}

    async def close(self) -> None:
        await self._client.aclose()
