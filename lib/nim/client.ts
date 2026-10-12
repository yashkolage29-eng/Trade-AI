import OpenAI from 'openai'

// ── Per-task model registry (all free-endpoint models on integrate.api.nvidia.com) ──
// Interactive chat wants speed → lightning, thinking disabled.
// Personality reviews want depth + image understanding → kimi-k3 (multimodal, reasoning).
// Chart-screenshot OCR wants the omni vision model.
// super-120b is the universal fallback (text-only — reviews degrade to text-only context).

export const NIM_MODEL_FAST = 'nvidia/nemotron-3.5-lightning-30b-a3b'
export const NIM_MODEL_VISION = 'moonshotai/kimi-k3'
export const NIM_MODEL_OMNI = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
/** nemotron-nano-3-30b-a3b 404s on the free endpoint; super-120b answers reviews in ~7s */
export const NIM_FALLBACK_MODEL = 'nvidia/nemotron-3-super-120b-a12b'

/** Cap for interactive (chat/suggestions) calls — fall back fast rather than hang */
export const NIM_REQUEST_TIMEOUT_MS = 20_000
/** Client-wide default — generous ceiling for heavy jobs (reviews) */
export const NIM_DEFAULT_TIMEOUT_MS = 90_000

/** Run a NIM call with retries on rate-limit (429) responses. Free-tier limits
 *  are shared per model, so bursts can 429 even under the account quota. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = (err as { status?: number })?.status
      const message = String((err as Error)?.message ?? '')
      const rateLimited = status === 429 || message.includes('429') || message.toLowerCase().includes('rate limit')
      if (!rateLimited || attempt === retries) throw lastErr
      const delayMs = 2000 * 2 ** attempt // 2s, 4s, 8s
      console.warn(`[nim] rate limited, retry ${attempt + 1}/${retries} in ${delayMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastErr
}

/** Run tasks with limited concurrency (default 2) — keeps the 5-personality
 *  reviews under NIM's concurrent-request limits while still parallel. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Request option that disables lightning's thinking mode for fast interactive replies.
 *  Cast needed: extra_body-style keys pass through the OpenAI SDK to NIM. */
export const NIM_NO_THINKING = {
  chat_template_kwargs: { enable_thinking: false },
} as unknown as Record<string, never>

let _nimClient: OpenAI | null = null

export function getNimClient(): OpenAI {
  if (!_nimClient) {
    if (!process.env.NVIDIA_NIM_API_KEY) {
      throw new Error('NVIDIA_NIM_API_KEY is not set')
    }
    _nimClient = new OpenAI({
      apiKey: process.env.NVIDIA_NIM_API_KEY,
      baseURL: 'https://integrate.api.nvidia.com/v1',
      timeout: NIM_DEFAULT_TIMEOUT_MS,
    })
  }
  return _nimClient
}
