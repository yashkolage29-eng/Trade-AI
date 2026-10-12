import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service-client'
import { getNimClient, NIM_MODEL_VISION, NIM_FALLBACK_MODEL, NIM_REQUEST_TIMEOUT_MS, withRateLimitRetry, mapWithConcurrency } from '@/lib/nim/client'
import { parseNimJson } from '@/lib/nim/parse-nim-json'
import { base64FromUrl } from '@/lib/nim/extract-trade-from-image'
import { buildTradeContext } from '@/lib/nim/build-trade-context'
import {
  PROP_FIRM_EVALUATOR_PROMPT,
  TRADING_PSYCHOLOGIST_PROMPT,
  INSTITUTIONAL_TRADER_PROMPT,
  QUANTITATIVE_ANALYST_PROMPT,
  RISK_MANAGER_PROMPT,
  buildReviewSystemPrompt,
} from '@/lib/prompts/reviewer-system-prompts'
import type { PersonalityReview, TradeReview } from '@/lib/types/review'

export async function POST(request: Request) {
  try {
    // ── Auth verification ──────────────────────────────────────────────────
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { tradeId } = body

    if (!tradeId || typeof tradeId !== 'string') {
      return NextResponse.json(
        { error: 'tradeId is required' },
        { status: 400 },
      )
    }

    // ── Owner verification via RLS-enforced client ────────────────────────
    // Use the regular (RLS-enforced) client to verify the trade belongs to this user.
    const { data: trade, error: tradeError } = await supabase
      .from('trades')
      .select('*')
      .eq('id', tradeId)
      .eq('user_id', user.id)   // ← owner check: RLS + explicit filter
      .single()

    if (tradeError || !trade) {
      console.error('[api/review] trade fetch failed:', tradeError)
      return NextResponse.json({ error: 'Trade not found' }, { status: 404 })
    }

    // Check if review already exists
    const { data: existing } = await supabase
      .from('trade_reviews')
      .select('*')
      .eq('trade_id', tradeId)
      .maybeSingle()

    // A row where every personality failed (composite_score null) is retried, not served
    if (existing && existing.composite_score !== null) {
      return NextResponse.json({ review: existing })
    }
    if (existing) {
      await supabase.from('trade_reviews').delete().eq('id', existing.id)
    }

    const tradeContext = buildTradeContext(trade)

    const personalities = [
      { key: 'prop_firm_evaluator', prompt: PROP_FIRM_EVALUATOR_PROMPT },
      { key: 'trading_psychologist', prompt: TRADING_PSYCHOLOGIST_PROMPT },
      { key: 'institutional_trader', prompt: INSTITUTIONAL_TRADER_PROMPT },
      { key: 'quantitative_analyst', prompt: QUANTITATIVE_ANALYST_PROMPT },
      { key: 'risk_manager', prompt: RISK_MANAGER_PROMPT },
    ] as const

    // Call all 5 personalities (2 at a time). Vision model only when there are
    // screenshots to look at; otherwise (or on failure) the text-only fallback model.
    // NIM free tier 429s on wider bursts, so each call also backs off on 429.
    const hasScreenshots = Array.isArray(trade.screenshot_urls) && trade.screenshot_urls.length > 0
    const results = await mapWithConcurrency([...personalities], 2, async ({ key, prompt }) => {
      const systemPrompt = buildReviewSystemPrompt(prompt)
      try {
        if (!hasScreenshots) throw new Error('no screenshots — skip vision model')
        return { key, review: await withRateLimitRetry(() => callNim(NIM_MODEL_VISION, systemPrompt, tradeContext, trade.screenshot_urls, NIM_REQUEST_TIMEOUT_MS)) }
      } catch {
        // Fallback model, text-only — drop screenshots
        try {
          return { key, review: await withRateLimitRetry(() => callNim(NIM_FALLBACK_MODEL, systemPrompt, tradeContext, null)) }
        } catch (error) {
          console.error(`[api/review] ${key} failed after retry:`, error)
          return { key, review: null }
        }
      }
    })

    // Build review object
    const reviewData: Record<string, PersonalityReview | null> = {}
    let scoreSum = 0
    let scoreCount = 0

    for (const { key, review } of results) {
      reviewData[key] = review
      if (review) {
        scoreSum += review.overall
        scoreCount++
      }
    }

    const compositeScore = scoreCount > 0
      ? Math.round((scoreSum / scoreCount) * 10) / 10
      : null

    if (scoreCount === 0) {
      return NextResponse.json(
        { error: 'AI reviewers are unavailable right now. Please try again.' },
        { status: 503 },
      )
    }

    // Store in trade_reviews using the regular client (RLS-enforced, correct user_id)
    const { data: inserted, error: insertError } = await supabase
      .from('trade_reviews')
      .insert({
        trade_id: tradeId,
        user_id: user.id,
        prop_firm_evaluator: reviewData.prop_firm_evaluator,
        trading_psychologist: reviewData.trading_psychologist,
        institutional_trader: reviewData.institutional_trader,
        quantitative_analyst: reviewData.quantitative_analyst,
        risk_manager: reviewData.risk_manager,
        composite_score: compositeScore,
      })
      .select()
      .single()

    if (insertError) {
      console.error('[api/review] insert failed:', insertError)
      return NextResponse.json(
        { error: 'Failed to store review' },
        { status: 500 },
      )
    }

    return NextResponse.json({ review: inserted })
  } catch (error) {
    console.error('[api/review]', error)
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    )
  }
}

/** Review with the vision model. When the trade has chart screenshots, they are
 *  attached as images so the reviewer judges the actual setup, not just numbers. */
async function callNim(
  model: string,
  systemPrompt: string,
  tradeContext: string,
  screenshotUrls: string[] | null | undefined,
  timeoutMs?: number,
): Promise<PersonalityReview> {
  // Attach up to 3 screenshots; gracefully skip ones that fail to load
  const images: Array<Record<string, unknown>> = []
  if (screenshotUrls && screenshotUrls.length > 0) {
    const loaded = await Promise.allSettled(
      screenshotUrls.slice(0, 3).map(async (url) => ({
        type: 'image_url' as const,
        image_url: { url: `data:image/jpeg;base64,${await base64FromUrl(url)}` },
      })),
    )
    for (const r of loaded) {
      if (r.status === 'fulfilled') images.push(r.value)
    }
  }

  const userContent =
    images.length > 0
      ? [
          {
            type: 'text' as const,
            text: `${tradeContext}\n\n[SCREENSHOTS] The trade's chart screenshots follow. Use them to judge the setup itself — entry location, level quality, stop placement, context — not just the numbers above.`,
          },
          ...images,
        ]
      : tradeContext

  const completion = await getNimClient().chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent as never },
      ],
      max_tokens: 2048,
      temperature: 0.3,
    },
    timeoutMs ? { timeout: timeoutMs } : undefined,
  )

  const raw = completion.choices[0]?.message?.content
  if (!raw) throw new Error('Empty response from NIM')

  const parsed = parseNimJson<PersonalityReview>(raw)

  // Validate shape
  const requiredKeys: (keyof PersonalityReview)[] = [
    'entry_quality', 'risk_management', 'trade_psychology',
    'execution', 'strategy_adherence', 'overall', 'grade',
    'verdict', 'strengths', 'improvements',
  ]
  for (const k of requiredKeys) {
    if (parsed[k] === undefined || parsed[k] === null) {
      throw new Error(`Missing key: ${k}`)
    }
  }

  // Clamp scores to 1–10
  const scoreKeys: (keyof PersonalityReview)[] = [
    'entry_quality', 'risk_management', 'trade_psychology',
    'execution', 'strategy_adherence', 'overall',
  ]
  for (const k of scoreKeys) {
    if (typeof parsed[k] === 'number') {
      ;(parsed as unknown as Record<string, unknown>)[k] = Math.max(1, Math.min(10, parsed[k] as number))
    }
  }

  return parsed
}
