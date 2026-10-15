package mailer

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"gptibo/storefront/internal/security"
)

type Brand struct {
	Name, Logo, OrdersURL, WorkspaceURL, AdminURL, Contacts string
}

func PlatformBrand(origin string) Brand {
	origin = strings.TrimRight(origin, "/")
	if origin == "" {
		origin = "https://shop.example.invalid"
	}
	return Brand{Name: "硅基生物", Logo: origin + "/email-logo.png", OrdersURL: origin + "/orders", WorkspaceURL: origin + "/join", AdminURL: origin + "/admin"}
}

type brandKey struct{}

func WithBrand(ctx context.Context, brand Brand) context.Context {
	return context.WithValue(ctx, brandKey{}, brand)
}
func ContextBrand(ctx context.Context, origin string) Brand {
	if b, ok := ctx.Value(brandKey{}).(Brand); ok {
		return b
	}
	return PlatformBrand(origin)
}

type BrandQuery interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}
type Brands struct {
	DB             BrandQuery
	Origin         string
	DomainsEnabled bool
}

// Store identity comes from the order's store_id, not the currently signed-in actor.
// Historical single-store orders use their owner's default store.
func (r Brands) Store(ctx context.Context, partner, shop string) (Brand, error) {
	b := PlatformBrand(r.Origin)
	if partner == "" || partner == "platform" {
		return b, nil
	}
	var slug, name, logo, host, hostShop, wechat, qq, email string
	e := r.DB.QueryRow(ctx, `SELECT s.slug,
 COALESCE(NULLIF(s.settings->>'brandName',''),CASE WHEN NOT(s.settings ? 'brandName') THEN NULLIF(b.name,'') END,NULLIF(s.name,''),'代理商店'),
 COALESCE(s.settings->>'logo',b.logo,''),
 COALESCE(d.hostname,''),COALESCE(d.store_id,''),
 COALESCE(s.settings->>'wechat',sc.wechat,''),COALESCE(s.settings->>'qq',sc.qq,''),COALESCE(s.settings->>'email',sc.email,'')
 FROM partner_stores s JOIN partners p ON p.id=s.partner_id
 LEFT JOIN partner_branding b ON b.partner_id=p.id AND s.slot=1
 LEFT JOIN support_contacts sc ON sc.owner=p.id AND s.slot=1
 LEFT JOIN LATERAL (SELECT d.hostname,COALESCE(d.store_id,d.partner_id) store_id FROM partner_domains d JOIN partner_stores ds ON ds.id=COALESCE(d.store_id,d.partner_id) JOIN partners dp ON dp.id=d.partner_id
 WHERE $3 AND d.partner_id IN(p.id,p.parent_id) AND p.active AND dp.active AND ds.active AND d.state='active' AND d.checked_at>now()-interval '24 hours' AND (d.free OR d.expires_at+interval '3 days'>now())
 ORDER BY (COALESCE(d.store_id,d.partner_id)=s.id) DESC,(d.partner_id=p.id) DESC,(ds.slot=1) DESC,d.free DESC,d.created_at,d.id LIMIT 1) d ON true
 WHERE s.partner_id=$1 AND s.id=COALESCE(NULLIF($2,''),$1)`, partner, shop, r.DomainsEnabled).Scan(&slug, &name, &logo, &host, &hostShop, &wechat, &qq, &email)
	if e != nil {
		return Brand{}, e
	}
	if strings.ContainsFunc(name, unicode.IsControl) {
		return Brand{}, fmt.Errorf("invalid mail brand name")
	}
	b.Name = name
	// Assets use the configured platform origin; a shop domain may expire after queuing.
	assetOrigin := strings.TrimSuffix(b.AdminURL, "/admin")
	b.Logo = assetOrigin + "/email-shop.png"
	if regexp.MustCompile(`^/store-logos/` + security.Hash(partner) + `/[a-f0-9]{64}\.png$`).MatchString(logo) {
		b.Logo = assetOrigin + logo
	}
	origin := assetOrigin
	path := "/s/" + url.PathEscape(slug)
	if regexp.MustCompile(`^(?:[A-Z0-9]{6}|[A-Z]{8})$`).MatchString(slug) {
		path = "/r/" + slug
	}
	if host != "" {
		origin = "https://" + host
		if hostShop == shop || (shop == "" && hostShop == partner) {
			path = ""
		}
	}
	b.OrdersURL = origin + path + "/orders"
	b.WorkspaceURL = origin + "/join"
	lines := []string{}
	for _, v := range []struct{ label, value string }{{"微信", wechat}, {"QQ", qq}, {"邮箱", email}} {
		if v.value != "" {
			lines = append(lines, v.label+"："+v.value)
		}
	}
	b.Contacts = strings.Join(lines, "\n")
	return b, nil
}

func (r Brands) Slug(ctx context.Context, slug string) (Brand, error) {
	var partner, shop string
	e := r.DB.QueryRow(ctx, `SELECT s.partner_id,s.id FROM partner_stores s JOIN partners p ON p.id=s.partner_id WHERE s.slug=$1 AND s.active AND p.active AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM partners parent WHERE parent.id=p.parent_id AND parent.active))`, slug).Scan(&partner, &shop)
	if e != nil {
		return Brand{}, e
	}
	return r.Store(ctx, partner, shop)
}

func (r Brands) Order(ctx context.Context, id string) (Brand, error) {
	var partner, shop string
	e := r.DB.QueryRow(ctx, `SELECT COALESCE(partner_id,''),COALESCE(store_id,'') FROM orders WHERE id=$1`, id).Scan(&partner, &shop)
	if e != nil {
		return Brand{}, e
	}
	return r.Store(ctx, partner, shop)
}

// A partner's sales notification is issued by its upstream, not its own shop.
// Top-level partners receive platform-branded notices.
func (r Brands) Upstream(ctx context.Context, partner string) (Brand, error) {
	var parent string
	if e := r.DB.QueryRow(ctx, `SELECT COALESCE(parent_id,'') FROM partners WHERE id=$1`, partner).Scan(&parent); e != nil {
		return Brand{}, e
	}
	return r.Store(ctx, parent, "")
}
