export type DirectSite = { nameZh: string; nameEn: string; logoUrl: string | null }
export type DirectCategory = { id: string; nameZh: string; nameEn: string; sortOrder: number; active: boolean }
export type DirectProduct = { id: string; nameZh: string; nameEn: string; descriptionZh: string; descriptionEn: string; categoryId: string; sortOrder: number; listed: boolean; imageUrl: string | null }
export type DirectStore = { site: DirectSite; categories: DirectCategory[]; products: DirectProduct[] }

export const directMediaUrl = (id: string | null) => id ? `/api/direct-media/${id}` : null
