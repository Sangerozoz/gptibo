import { BrandMark } from './brand'
import { useState } from 'react'
import { Store } from 'lucide-react'
import './shop-brand.css'

function ShopLogo({ logo }: { logo: string }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  return <span className="shop-brand-avatar"><Store aria-hidden="true" />{!failed && <img className="shop-brand-logo" src={logo} alt="" width={32} height={32} style={{ opacity: loaded ? 1 : 0 }} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}</span>
}

export function ShopBrand({ name, logo, pending = false, platform = false }: { name?: string; logo?: string; pending?: boolean; platform?: boolean }) {
  if (pending) return <span className="shop-brand-placeholder" aria-hidden="true"><i /><i /></span>
  return <>{logo ? <ShopLogo key={logo} logo={logo} /> : platform ? <BrandMark /> : <Store aria-hidden="true" />}<span className="shop-brand-name">{name || (platform ? '硅基生物' : '商店')}</span></>
}
