export type SupportContacts = { wechat: string; qq: string; email: string; wechatQrUrl?: string; qqQrUrl?: string }
export type SupportContactsSettings = { contacts: SupportContacts; qrMediaIds: { wechat: string | null; qq: string | null }; version: number }

export const emptySupportContacts: SupportContacts = { wechat: '', qq: '', email: '' }
