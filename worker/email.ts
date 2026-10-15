import { emailTemplates } from './emails.generated.ts'
import type { Env } from './platform.ts'
import { membershipClaimUrl } from '../shared/membership-claim.ts'
import { boundedResponseText } from './bounded-response.ts'

type EmailMessage = { subject: string; html: string; text: string }
export function siteEmail(env: Env, message: EmailMessage): EmailMessage {
  const input = env.PUBLIC_SITE_ORIGIN || (env.ORDER_TESTING_ENABLED === 'true' ? 'http://127.0.0.1:8788' : '')
  let url: URL
  try { url = new URL(input) } catch { throw new Error('PUBLIC_SITE_ORIGIN must be configured before sending mail') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(env.ORDER_TESTING_ENABLED === 'true' && loopback && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_SITE_ORIGIN must be an HTTPS origin or local loopback in testing mode')
  const origin = url.origin
  return {
    subject: message.subject.replaceAll('__RECHARGE_SITE_ORIGIN__', origin),
    html: message.html.replaceAll('__RECHARGE_SITE_ORIGIN__', origin),
    text: message.text.replaceAll('__RECHARGE_SITE_ORIGIN__', origin),
  }
}

export type VerificationKind = Exclude<keyof typeof emailTemplates, 'partner-welcome' | 'recharge-reminder' | 'delivery-link' | 'delivery-cdk' | 'delivery-duolingo-link' | 'delivery-gmail'>

export function membershipDeliveryMessage(kind: 'link' | 'cdk', orderId: string, value: string, instructions: string, plan?: string) {
  const claimUrl = plan === 'gmail-account' ? null : membershipClaimUrl(value)
  if (plan !== 'gmail-account' && kind === 'link' && !claimUrl) throw new Error('Invalid membership claim link')
  const duo = plan === 'duolingo-12m' || kind === 'cdk'
  const template = emailTemplates[plan === 'gmail-account' ? 'delivery-gmail' : claimUrl && duo ? 'delivery-duolingo-link' : kind === 'link' ? 'delivery-link' : 'delivery-cdk']
  const values: Record<string, string> = { __RECHARGE_DELIVERY_ORDER__: orderId, __RECHARGE_DELIVERY_VALUE__: value, __RECHARGE_DELIVERY_URL__: claimUrl ?? '', __RECHARGE_DELIVERY_INSTRUCTIONS__: instructions }
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
  const pattern = /__RECHARGE_DELIVERY_(?:ORDER|VALUE|URL|INSTRUCTIONS)__/g
  return { subject: template.subject, html: template.html.replace(pattern, key => key === '__RECHARGE_DELIVERY_VALUE__' && claimUrl ? `<a href="${escape(claimUrl)}" style="color:#6256cf;word-break:break-all">${escape(value)}</a>` : escape(values[key]).replaceAll('\n', '<br />')), text: template.text.replace(pattern, key => values[key]) }
}

export type RechargeReminderDetails = { orderId: string; planName: string; contacts: string }
export function rechargeReminderMessage(details: RechargeReminderDetails) {
  const values: Record<string, string> = {
    '__RECHARGE_REMINDER_ORDER_ID__': details.orderId,
    '__RECHARGE_REMINDER_PLAN_NAME__': details.planName,
    '__RECHARGE_REMINDER_CONTACTS__': details.contacts,
  }
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]!)
  const template = emailTemplates['recharge-reminder']
  // One pass prevents customer/partner text from being interpreted as another placeholder.
  const pattern = /__RECHARGE_REMINDER_(?:ORDER_ID|PLAN_NAME|CONTACTS)__/g
  return { subject: template.subject, html: template.html.replace(pattern, key => escape(values[key]).replaceAll('\n', '<br />')), text: template.text.replace(pattern, key => values[key]) }
}

export async function sendRechargeReminderEmail(env: Env, to: string, message: ReturnType<typeof rechargeReminderMessage>, id: string) {
  await sendEmail(env, to, message, 'recharge-reminder/' + id)
}

export async function sendMembershipPreviewEmail(env: Env, to: string, message: ReturnType<typeof membershipDeliveryMessage>, id: string) {
  const response = await sendEmail(env, to, message, 'membership-preview/' + id)
  const result = JSON.parse(await boundedResponseText(response, 16384)) as { id?: unknown }
  if (typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.id)) throw new Error('Preview mail result not confirmed')
  return result.id
}

export function partnerInvitationMessage() {
  return emailTemplates['partner-welcome']
}

export function verificationMessage(kind: VerificationKind, code: string) {
  // Only server-generated codes enter the pre-rendered HTML; never accept arbitrary markup.
  if (!/^\d{6}$/.test(code)) throw new Error('Invalid verification code')
  const template = emailTemplates[kind]
  return {
    subject: template.subject,
    html: template.html.replaceAll('__RECHARGE_VERIFICATION_CODE__', code),
    text: template.text.replaceAll('__RECHARGE_VERIFICATION_CODE__', code),
  }
}

export async function sendVerificationEmail(env: Env, kind: VerificationKind, to: string, code: string, challenge: string) {
  await sendEmail(env, to, verificationMessage(kind, code), kind + '/' + challenge)
}

export async function sendPartnerInvitationEmail(env: Env, to: string, invitationId: string) {
  await sendEmail(env, to, partnerInvitationMessage(), 'partner-welcome/' + invitationId)
}

async function sendEmail(env: Env, to: string, message: { subject: string; html: string; text: string }, idempotencyKey: string) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    redirect: 'manual',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ from: env.RESEND_FROM, to: [to], ...siteEmail(env, message) }),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error('delivery failed')
  return response
}
