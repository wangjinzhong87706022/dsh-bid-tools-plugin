# -*- coding: utf-8 -*-
"""集中管理环境变量配置。所有部署相关的差异都通过 .env 注入，代码不改。"""
from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent / ".env")
except ImportError:  # python-dotenv 缺失时仍可读系统环境变量
    pass


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# ---- MCP 服务自身 ----
MCP_HOST = os.environ.get("MCP_HOST", "0.0.0.0")
MCP_PORT = _int("MCP_PORT", 8300)
MCP_TRANSPORT = os.environ.get("MCP_TRANSPORT", "streamable-http")  # stdio / streamable-http

# ---- LLM（Qwen3.8-27B，vLLM OpenAI 兼容 API）----
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:8000/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen3.8-27b-awq")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "EMPTY")
LLM_TIMEOUT = _int("LLM_TIMEOUT", 300)          # 长文抽取耗时较长，放宽
LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", "0.2"))
LLM_MAX_RETRIES = _int("LLM_MAX_RETRIES", 3)

# ---- RAGFlow v0.27.1 HTTP API ----
RAGFLOW_BASE_URL = os.environ.get("RAGFLOW_BASE_URL", "http://127.0.0.1")  # 默认走 nginx 80 端口
RAGFLOW_API_KEY = os.environ.get("RAGFLOW_API_KEY", "")                    # RAGFlow 系统设置里生成的 API KEY
RAGFLOW_TIMEOUT = _int("RAGFLOW_TIMEOUT", 60)

# 默认知识库 dataset_id（历史标书库等）。为空时调用方必须在参数里显式传 dataset_ids。
KB_DATASET_IDS = [
    x.strip()
    for x in os.environ.get("KB_DATASET_IDS", "").split(",")
    if x.strip()
]
RETRIEVAL_TOP_K = _int("RETRIEVAL_TOP_K", 8)
RETRIEVAL_SIM_THRESHOLD = float(os.environ.get("RETRIEVAL_SIM_THRESHOLD", "0.2"))

# 标书定稿归档回流的知识库（"历史标书库"）dataset_id
BID_ARCHIVE_DATASET_ID = os.environ.get("BID_ARCHIVE_DATASET_ID", "")

# ---- 合规自查 ----
# 关键词比对未命中时，交给 LLM 做语义复核的最大条数，防止要求清单很长时打爆 LLM
COMPLIANCE_LLM_CHECK_MAX = _int("COMPLIANCE_LLM_CHECK_MAX", 20)
# 检索/生成的单次文本上限（字符），超长截断
MAX_TEXT_CHARS = _int("MAX_TEXT_CHARS", 120000)
# 招标文件分块抽取的单块大小（字符）
CHUNK_SIZE = _int("CHUNK_SIZE", 6000)
