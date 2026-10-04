/** LLM 客户端：直连 vLLM OpenAI 兼容接口。输出 JSON 容错提取 + 校验 + 重试。 */
import { config } from './config.ts'

export class LLMError extends Error {}

export interface ChatResult<T> {
  value: T
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inStr) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export { extractJson }

export class LLMClient {
  async chat(system: string, user: string, maxTokens = 4096): Promise<string> {
    const resp = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: config.llmTemperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(config.llmTimeoutMs),
    })
    if (!resp.ok) throw new LLMError(`LLM 请求失败: HTTP ${resp.status} ${await resp.text().catch(() => '')}`)
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new LLMError(`LLM 返回格式异常: ${JSON.stringify(data).slice(0, 200)}`)
    return content
  }

  /**
   * 要求 LLM 输出 JSON 并经 validate 校验/归一化，失败自动重试。
   * validate 抛错视为校验失败，会带上错误信息进入下一轮重试。
   */
  async chatJson<T>(
    system: string,
    user: string,
    validate: (data: Record<string, unknown>) => T,
    opts: { maxTokens?: number; hint?: string } = {},
  ): Promise<T> {
    let sys =
      `${system}\n\n` +
      '输出要求：只输出一个 JSON 对象，不要输出任何解释、markdown 代码块标记或其他文字。\n' +
      '字段名与取值必须严格符合要求中给出的类别/取值范围。'
    if (opts.hint) sys += `\n补充说明：${opts.hint}`

    let lastErr: unknown = new LLMError('未执行')
    for (let attempt = 1; attempt <= config.llmMaxRetries; attempt++) {
      try {
        const text = await this.chat(sys, user, opts.maxTokens ?? 4096)
        const parsed = extractJson(text)
        if (!parsed) throw new LLMError(`第${attempt}次未解析出 JSON：${text.slice(0, 200)}`)
        return validate(parsed)
      } catch (err) {
        lastErr = err
        console.warn(`[bid-tools] chatJson 第${attempt}次失败:`, err instanceof Error ? err.message : err)
      }
    }
    throw lastErr
  }
}
