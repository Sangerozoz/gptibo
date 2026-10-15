import { ApiError, type Env } from '../platform.ts'
import { boundedResponseText } from '../bounded-response.ts'

const origin = 'https://5sim.net'
const segmentPattern = /^[a-z0-9-]{1,64}$/

export type FiveSimSms = { code: string; text: string; sender: string; date: string }
export type FiveSimOrder = {
  id: number
  phone: string
  operator: string
  product: string
  price: number
  status: string
  expires: string
  sms: FiveSimSms[]
  country: string
}
export type FiveSimPrice = { cost: number; count: number; rate?: number }

/** A timed-out purchase may have succeeded. Reconcile before any new buy attempt. */
export class FiveSimResultUncertainError extends ApiError {
  constructor() { super('5SIM 购号结果暂未确认，请核对上游订单后再处理。', 503) }
}
class FiveSimNoNumbersError extends ApiError {
  constructor() { super('5SIM 暂无可用号码。', 409) }
}

export const fivesimConfigured = (env: Env) => Boolean(env.FIVESIM_API_TOKEN?.trim())

function segment(value: string): string {
  if (!segmentPattern.test(value)) throw new ApiError('5SIM 参数无效。', 400)
  return value
}

function orderId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ApiError('5SIM 订单编号无效。', 400)
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('5SIM 响应格式异常。', 502)
  return value as Record<string, unknown>
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function token(env: Env): string {
  const value = env.FIVESIM_API_TOKEN?.trim()
  if (!value) throw new ApiError('5SIM 密钥尚未配置。', 503)
  return value
}

async function request(path: string, bearer?: string, purchase = false): Promise<unknown> {
  try {
    const response = await fetch(origin + path, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      signal: AbortSignal.timeout(15000),
    })
    if (response.status >= 300 && response.status < 400) throw new ApiError('5SIM 拒绝了重定向响应。', 502)
    const raw = await boundedResponseText(response, 128000)
    if (purchase && response.ok && raw.trim().toLowerCase() === 'no free phones') throw new FiveSimNoNumbersError()
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ApiError('5SIM 密钥无效或无权访问。', 503)
      throw new ApiError('5SIM 服务暂时不可用。', 503)
    }
    try { return JSON.parse(raw) as unknown }
    catch { throw new ApiError('5SIM 响应格式异常。', 502) }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (purchase) throw new FiveSimResultUncertainError()
    throw new ApiError('5SIM 服务暂时不可用。', 503)
  }
}

function parseOrder(value: unknown, expectedId?: number): FiveSimOrder {
  const item = record(value)
  if (!Number.isSafeInteger(item.id) || (item.id as number) <= 0 || (expectedId !== undefined && item.id !== expectedId)
    || typeof item.phone !== 'string' || !/^\+[1-9][0-9]{5,19}$/.test(item.phone)
    || typeof item.product !== 'string' || !item.product || typeof item.status !== 'string' || !item.status
    || typeof item.expires !== 'string' || !Number.isFinite(Date.parse(item.expires))
    || !nonnegative(item.price) || typeof item.country !== 'string' || !item.country
    || (item.operator !== undefined && typeof item.operator !== 'string')) throw new ApiError('5SIM 订单响应格式异常。', 502)
  if (item.sms !== null && item.sms !== undefined && !Array.isArray(item.sms)) throw new ApiError('5SIM 订单响应格式异常。', 502)
  const sms = (item.sms ?? []) as unknown[]
  if (sms.some(value => {
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    return !row || typeof row.code !== 'string' || typeof row.text !== 'string' || typeof row.sender !== 'string' || typeof row.date !== 'string'
  })) throw new ApiError('5SIM 短信响应格式异常。', 502)
  return { id: item.id as number, phone: item.phone, operator: (item.operator as string | undefined) ?? '', product: item.product, price: item.price, status: item.status, expires: item.expires, sms: sms as FiveSimSms[], country: item.country }
}

export async function fivesimProfile(env: Env): Promise<{ balance: number; frozenBalance: number }> {
  const data = record(await request('/v1/user/profile', token(env)))
  if (!nonnegative(data.balance) || (data.frozen_balance !== undefined && !nonnegative(data.frozen_balance))) throw new ApiError('5SIM 账户响应格式异常。', 502)
  return { balance: data.balance, frozenBalance: (data.frozen_balance as number | undefined) ?? 0 }
}

export async function fivesimPrices(_env: Env, country: string, product: string): Promise<Record<string, FiveSimPrice>> {
  country = segment(country); product = segment(product)
  const data = record(await request(`/v1/guest/prices?country=${country}&product=${product}`))
  const countryData = record(data[country])
  const prices = record(countryData[product])
  const result: Record<string, FiveSimPrice> = {}
  for (const [operator, value] of Object.entries(prices)) {
    const quote = record(value)
    if (!nonnegative(quote.cost) || !Number.isSafeInteger(quote.count) || (quote.count as number) < 0 || (quote.rate !== undefined && !nonnegative(quote.rate))) throw new ApiError('5SIM 价格响应格式异常。', 502)
    result[operator] = { cost: quote.cost, count: quote.count as number, ...(quote.rate === undefined ? {} : { rate: quote.rate as number }) }
  }
  return result
}

export async function fivesimBuyActivation(env: Env, input: { country: string; operator: string; product: string; maxPrice?: number }): Promise<FiveSimOrder> {
  const country = segment(input.country), operator = segment(input.operator), product = segment(input.product)
  if (input.maxPrice !== undefined && (!Number.isFinite(input.maxPrice) || input.maxPrice <= 0 || input.maxPrice > 1_000_000 || !/^\d+(\.\d{1,4})?$/.test(String(input.maxPrice)))) throw new ApiError('5SIM 价格上限无效。', 400)
  if (input.maxPrice !== undefined && operator !== 'any') throw new ApiError('5SIM 价格上限仅支持任意运营商。', 400)
  const query = input.maxPrice === undefined ? '' : `?maxPrice=${input.maxPrice}`
  const bearer = token(env)
  try { return parseOrder(await request(`/v1/user/buy/activation/${country}/${operator}/${product}${query}`, bearer, true)) }
  catch (error) {
    if (error instanceof FiveSimNoNumbersError || error instanceof FiveSimResultUncertainError) throw error
    throw new FiveSimResultUncertainError()
  }
}

export async function fivesimCheck(env: Env, id: number): Promise<FiveSimOrder> {
  return parseOrder(await request(`/v1/user/check/${orderId(id)}`, token(env)), id)
}

export async function fivesimFinish(env: Env, id: number): Promise<FiveSimOrder> {
  return parseOrder(await request(`/v1/user/finish/${orderId(id)}`, token(env)), id)
}

export async function fivesimCancel(env: Env, id: number): Promise<FiveSimOrder> {
  return parseOrder(await request(`/v1/user/cancel/${orderId(id)}`, token(env)), id)
}
