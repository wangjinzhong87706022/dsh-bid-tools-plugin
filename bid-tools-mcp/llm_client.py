# -*- coding: utf-8 -*-
"""LLM 客户端：直连 vLLM 的 OpenAI 兼容接口（Qwen3.8-27B）。

只负责一件事：给提示词 -> 返回通过 schema 校验的结构化 JSON。
抽取失败自动重试（最多 config.LLM_MAX_RETRIES 次）。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional, Type, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

import config

log = logging.getLogger("bid-tools.llm")

T = TypeVar("T", bound=BaseModel)


class LLMError(RuntimeError):
    pass


class LLMClient:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=config.LLM_BASE_URL.rstrip("/"),
            headers={
                "Authorization": f"Bearer {config.LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=config.LLM_TIMEOUT,
        )

    async def chat(self, system: str, user: str, max_tokens: int = 4096) -> str:
        """单轮对话，返回纯文本。"""
        payload = {
            "model": config.LLM_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": config.LLM_TEMPERATURE,
            "max_tokens": max_tokens,
        }
        try:
            resp = await self._client.post("/chat/completions", json=payload)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise LLMError(f"LLM 请求失败: {exc}") from exc
        data = resp.json()
        try:
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError) as exc:
            raise LLMError(f"LLM 返回格式异常: {data}") from exc

    async def chat_json(
        self,
        system: str,
        user: str,
        schema: Type[T],
        max_tokens: int = 4096,
        hint: Optional[str] = None,
    ) -> T:
        """要求 LLM 输出 JSON 并按 pydantic schema 强校验，失败重试。"""
        sys_prompt = (
            f"{system}\n\n"
            "输出要求：只输出一个 JSON 对象，不要输出任何解释、markdown 代码块标记或其他文字。\n"
            f"JSON 必须符合以下 schema（字段名与类型严格一致）：\n"
            f"{json.dumps(schema.model_json_schema(), ensure_ascii=False, indent=1)}"
        )
        if hint:
            sys_prompt += f"\n补充说明：{hint}"
        last_err: Exception = LLMError("未执行")
        for attempt in range(1, config.LLM_MAX_RETRIES + 1):
            text = await self.chat(sys_prompt, user, max_tokens=max_tokens)
            parsed = self._extract_json(text)
            if parsed is None:
                last_err = LLMError(f"第{attempt}次未解析出 JSON：{text[:200]}")
                log.warning("%s", last_err)
                continue
            try:
                return schema.model_validate(parsed)
            except ValidationError as exc:
                last_err = LLMError(f"第{attempt}次 schema 校验失败：{exc.errors()[:3]}")
                log.warning("%s", last_err)
        raise last_err

    @staticmethod
    def _extract_json(text: str) -> Optional[dict]:
        """从 LLM 输出中提取第一个平衡的 JSON 对象（容忍 ```json 包裹）。"""
        text = re.sub(r"```(?:json)?", "", text).strip()
        start = text.find("{")
        if start < 0:
            return None
        depth = 0
        in_str = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        return None
        return None

    async def close(self) -> None:
        await self._client.aclose()
