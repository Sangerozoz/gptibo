package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"net/mail"
	"strings"
	"testing"

	"gptibo/storefront/internal/auth"
	"gptibo/storefront/internal/delivery"
	"gptibo/storefront/internal/domains"
	"gptibo/storefront/internal/httpapi"
	"gptibo/storefront/internal/mailer"
	"gptibo/storefront/internal/orders"
	"gptibo/storefront/internal/security"
)

type brandedLoginMail struct {
	*fakeMail
	brands  []mailer.Brand
	invites []mailer.Brand
}

func (m *brandedLoginMail) SendCode(ctx context.Context, role, to, code, id string) error {
	m.brands = append(m.brands, mailer.ContextBrand(ctx, testOrigin))
	return m.fakeMail.SendCode(ctx, role, to, code, id)
}
func (m *brandedLoginMail) SendInvitation(ctx context.Context, to, origin, id string) error {
	b := mailer.ContextBrand(ctx, testOrigin)
	b.WorkspaceURL = origin + "/join"
	m.invites = append(m.invites, b)
	return nil
}

func TestMailBrandingHierarchyStoreAndAuthentication(t *testing.T) {
	owner, app, _, _, fm := identityFixture(t)
	ctx := context.Background()
	logo := "/store-logos/" + security.Hash("parent") + "/" + strings.Repeat("a", 64) + ".png"
	childLogo := "/store-logos/" + security.Hash("child") + "/" + strings.Repeat("b", 64) + ".png"
	execSQL(t, owner, `INSERT INTO partners(id,slug,name,email,active,can_recruit) VALUES('parent','PAR123','一级店','parent@example.test',true,true),('other','OTH123','其他店','other@example.test',true,false);
 INSERT INTO partners(id,slug,name,email,active,parent_id) VALUES('child','CHI123','二级店','child@example.test',true,'parent');
 INSERT INTO partner_stores(id,partner_id,slot,slug,name,settings) VALUES('second','child',2,'SEC123','二级第二店','{"brandName":"二级品牌二店","wechat":"second-support"}');
 INSERT INTO partner_domains(partner_id,hostname,verification,state,checked_at) VALUES('parent','parent.example.com','fixture','active',now());`)
	execSQL(t, owner, `INSERT INTO partner_branding(partner_id,name,logo) VALUES('parent','一级品牌',$1),('child','二级品牌',$2)`, logo, childLogo)
	brands := mailer.Brands{DB: app.DB, Origin: testOrigin, DomainsEnabled: true}
	b, e := brands.Store(ctx, "child", "")
	if e != nil || b.Name != "二级品牌" || b.Logo != testOrigin+childLogo || b.OrdersURL != "https://parent.example.com/r/CHI123/orders" {
		t.Fatal(b, e)
	}
	b, e = brands.Store(ctx, "child", "second")
	if e != nil || b.Name != "二级品牌二店" || b.Logo != testOrigin+"/email-shop.png" || b.OrdersURL != "https://parent.example.com/r/SEC123/orders" || b.Contacts != "微信：second-support" {
		t.Fatal(b, e)
	}
	if _, e = brands.Store(ctx, "other", "second"); e == nil {
		t.Fatal("cross-owner store selected")
	}
	execSQL(t, owner, `UPDATE partner_stores SET settings=jsonb_build_object('brandName','','logo','') WHERE id='child'`)
	b, e = brands.Store(ctx, "child", "")
	if e != nil || b.Name != "二级店" || b.Logo != testOrigin+"/email-shop.png" {
		t.Fatal("cleared brand restored legacy identity", b, e)
	}
	execSQL(t, owner, `UPDATE partner_stores SET settings=jsonb_build_object('logo',$1::text) WHERE id='child'`, logo)
	b, e = brands.Store(ctx, "child", "")
	if e != nil || b.Logo != testOrigin+"/email-shop.png" {
		t.Fatal("another owner's logo accepted", b, e)
	}
	execSQL(t, owner, `UPDATE partner_stores SET settings='{}' WHERE id='child'`)
	execSQL(t, owner, `INSERT INTO partner_domains(partner_id,store_id,hostname,verification,state,checked_at) VALUES('child','second','second.example.com','fixture','active',now())`)
	b, e = brands.Store(ctx, "child", "second")
	if e != nil || b.OrdersURL != "https://second.example.com/orders" {
		t.Fatal("own store domain not preferred", b, e)
	}
	execSQL(t, owner, `UPDATE partner_domains SET free=false,expires_at=now()-interval '4 days' WHERE hostname='second.example.com'`)
	b, e = brands.Store(ctx, "child", "second")
	if e != nil || b.OrdersURL != "https://parent.example.com/r/SEC123/orders" {
		t.Fatal("expired domain selected", b, e)
	}
	execSQL(t, owner, `UPDATE partner_domains SET checked_at=now()-interval '25 hours'`)
	b, e = brands.Store(ctx, "child", "second")
	if e != nil || b.OrdersURL != testOrigin+"/r/SEC123/orders" {
		t.Fatal("stale domain selected", b, e)
	}
	execSQL(t, owner, `UPDATE partner_domains SET checked_at=now()`)
	brands.DomainsEnabled = false
	b, e = brands.Store(ctx, "child", "")
	if e != nil || strings.HasPrefix(b.OrdersURL, "https://parent.") {
		t.Fatal("disabled domains selected", b, e)
	}
	captured := &brandedLoginMail{fakeMail: fm}
	a, e := auth.New(app, auth.Config{Secret: strings.Repeat("a1", 32), AdminUsername: "fixture-admin", AdminEmail: "admin@example.test", AdminTOTP: testTOTP, Sender: captured})
	if e != nil {
		t.Fatal(e)
	}
	ds := &domains.Service{Store: app, Provider: &domainProvider{}, DNS: &domainDNS{}, Target: "shops.shop.example.invalid", Zone: "shop.example.invalid", Limit: 100}
	h := httpapi.Router(app, "fixture", slog.New(slog.NewTextHandler(io.Discard, nil)), httpapi.Options{Origin: testOrigin, Auth: a, Domains: ds, TrustedProxies: []string{"127.0.0.1/32"}})
	parent := login(t, h, fm, "partner", "parent@example.test")
	admin := login(t, h, fm, "admin", "")
	object(t, request(h, "POST", "/api/partner/children/child/invitation", map[string]any{}, parent), 200)
	if len(captured.invites) != 1 || captured.invites[0].Name != "一级品牌" || captured.invites[0].Logo != testOrigin+logo || captured.invites[0].WorkspaceURL != "https://parent.example.com/join" {
		t.Fatal(captured.invites)
	}
	execSQL(t, owner, `DELETE FROM auth_limits`)
	object(t, request(h, "POST", "/api/admin/partners/child/invitation", map[string]any{}, admin), 200)
	if captured.invites[1].Name != "硅基生物" {
		t.Fatal("admin invitation uses child identity")
	}
	object(t, request(h, "POST", "/api/orders/recovery/send", map[string]any{"email": "buyer@example.test", "shop": "SEC123"}, nil), 200)
	got := captured.brands[len(captured.brands)-1]
	if got.Name != "二级品牌二店" || got.OrdersURL != testOrigin+"/r/SEC123/orders" {
		t.Fatal("main referral recovery changed scope", got)
	}
	call := func(shop, path, email string) {
		t.Helper()
		execSQL(t, owner, `DELETE FROM auth_limits`)
		body, _ := json.Marshal(map[string]any{"email": email, "shop": "OTH123"})
		req := httptest.NewRequest("POST", path, bytes.NewReader(body))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("Origin", "https://parent.example.com")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Storefront-Host", "parent.example.com")
		req.Header.Set("X-Storefront-Shop", shop)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		object(t, w, 200)
	}
	call("CHI123", "/api/orders/recovery/send", "buyer@example.test")
	got = captured.brands[len(captured.brands)-1]
	if got.Name != "二级品牌" || got.OrdersURL != "https://parent.example.com/r/CHI123/orders" {
		t.Fatal("child store scope overridden", got)
	}
	call("", "/api/partner/auth/send", "child@example.test")
	got = captured.brands[len(captured.brands)-1]
	if got.Name != "一级品牌" || got.WorkspaceURL != "https://parent.example.com/join" {
		t.Fatal("workspace issuer not used", got)
	}
}

func TestMailBrandingDeliveryReminderAndNotificationSnapshots(t *testing.T) {
	f := hierarchySetup(t)
	ctx := context.Background()
	shop := makeShop(t, f, "二级品牌二店")
	shopID := shop["id"].(string)
	execSQL(t, f.owner, `UPDATE partner_stores SET settings='{"brandName":"二店品牌","wechat":"二店客服"}' WHERE id=$1`, shopID)
	execSQL(t, f.owner, `INSERT INTO catalog_plans(id,product_id,name,price_cents) VALUES('duolingo-12m','duolingo','Duolingo',1000)`)
	execSQL(t, f.owner, `INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,partner_id,store_id,mode,payment_status,status,customer_email,created_at,updated_at,last_event_id) VALUES('MAIL-BRAND','owner','mail-brand','duolingo-12m','Duolingo',1000,$1,$2,'live','paid','session','buyer@example.test',1,1,'fixture')`, f.childID, shopID)
	sender, _ := mailer.NewResend("fixture", "Platform <notify@example.test>")
	service := delivery.Service{Store: f.owner, Sender: sender, Origin: testOrigin}
	tx, e := f.owner.DB.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	var orderJSON []byte
	if e = tx.QueryRow(ctx, `SELECT to_jsonb(o) FROM orders o WHERE id='MAIL-BRAND'`).Scan(&orderJSON); e != nil {
		t.Fatal(e)
	}
	// Exercise the actual draft path used by both supplier and manual delivery.
	var o orders.Order
	if e = json.Unmarshal(orderJSON, &o); e != nil {
		t.Fatal(e)
	}
	if e = service.SaveDraft(ctx, tx, o, "CODE", "领取说明"); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	var raw string
	if e = f.owner.DB.QueryRow(ctx, `SELECT mail_body FROM email_deliveries WHERE order_id='MAIL-BRAND'`).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	var saved mailer.Frozen
	if e = json.Unmarshal([]byte(raw), &saved); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(saved.Subject, "二店品牌") || !strings.Contains(saved.Text, "二店品牌") || !strings.Contains(saved.HTML, "/r/"+shop["slug"].(string)+"/orders") || strings.Contains(saved.Text, "硅基生物") {
		t.Fatal("delivery used wrong brand")
	}
	reminder, e := service.ReminderMessage(ctx, "MAIL-BRAND", "Plus", f.childID, shopID)
	if e != nil || reminder.SenderName != "二店品牌" || !strings.Contains(reminder.Text, "二店客服") {
		t.Fatal("reminder lost brand/contact", e)
	}
	// Persisted drafts are not rebranded merely because settings are changed.
	execSQL(t, f.owner, `UPDATE partner_stores SET settings='{"brandName":"改名后的店"}' WHERE id=$1`, shopID)
	var again string
	if e = f.owner.DB.QueryRow(ctx, `SELECT mail_body FROM email_deliveries WHERE order_id='MAIL-BRAND'`).Scan(&again); e != nil || again != raw {
		t.Fatal("frozen draft changed", e)
	}
	// The real queued notification resolves store_id and freezes the branded body.
	execSQL(t, f.owner, `INSERT INTO partner_notification_settings(partner_id,order_completed_email) VALUES($1,true)`, f.childID)
	execSQL(t, f.owner, `UPDATE orders SET status='success' WHERE id='MAIL-BRAND'`)
	fake := &frozenMail{fail: true}
	service.Sender = fake
	out, e := service.PartnerOrderNotifications(ctx, 20)
	if e != nil || out["failed"] != 1 || len(fake.bodies) != 1 || !strings.Contains(fake.bodies[0], "改名后的店") {
		t.Fatal("notification brand", out, e)
	}
	execSQL(t, f.owner, `UPDATE partner_stores SET settings='{"brandName":"再次改名"}' WHERE id=$1;`, shopID)
	execSQL(t, f.owner, `UPDATE partner_order_notifications SET next_attempt_at=0 WHERE order_id='MAIL-BRAND'`)
	fake.fail = false
	out, e = service.PartnerOrderNotifications(ctx, 20)
	if e != nil || out["sent"] != 1 || len(fake.bodies) != 2 || fake.bodies[0] != fake.bodies[1] {
		t.Fatal("retry changed brand", out, e)
	}
}

// Exercise production From serialization while keeping every send in memory.
type upstreamNotificationMail struct {
	frozenMail
	sender *mailer.Resend
}

func (m *upstreamNotificationMail) Freeze(to string, value mailer.Message) (string, error) {
	return m.sender.Freeze(to, value)
}

func TestPartnerNotificationUpstreamBrand(t *testing.T) {
	for _, tc := range []struct{ name, partner, shop, shopName, sender, logo, workspace string }{
		{"top-level-default", "a", "a", "一级自有品牌", "硅基生物", "/email-logo.png", testOrigin + "/join"},
		{"top-level-second-store", "a", "a-second", "一级二店", "硅基生物", "/email-logo.png", testOrigin + "/join"},
		{"child-default", "b", "b", "二级自有品牌", "一级自有品牌", "/store-logos/" + security.Hash("a") + "/" + strings.Repeat("a", 64) + ".png", "https://parent.example.com/join"},
		{"child-second-store", "b", "b-second", "二级二店", "一级自有品牌", "/store-logos/" + security.Hash("a") + "/" + strings.Repeat("a", 64) + ".png", "https://parent.example.com/join"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			owner, app := notificationFixture(t)
			execSQL(t, owner, `UPDATE partners SET can_recruit=true WHERE id='a'; UPDATE partners SET parent_id='a' WHERE id='b'; INSERT INTO partner_notification_settings(partner_id,order_completed_email,version) VALUES('b',true,1);
    INSERT INTO partner_stores(id,partner_id,slot,slug,name,settings) VALUES('a-second','a',2,'ASEC12','一级二店','{"brandName":"一级二店"}'),('b-second','b',2,'BSEC12','二级二店','{"brandName":"二级二店"}');
    UPDATE partner_stores SET settings='{"brandName":"二级自有品牌"}' WHERE id='b';
    INSERT INTO partner_domains(partner_id,hostname,verification,state,checked_at) VALUES('a','parent.example.com','fixture','active',now());`)
			execSQL(t, owner, `INSERT INTO partner_branding(partner_id,name,logo) VALUES('a','一级自有品牌',$1)`, "/store-logos/"+security.Hash("a")+"/"+strings.Repeat("a", 64)+".png")
			notificationOrder(t, app, "UPSTREAM")
			execSQL(t, owner, `UPDATE orders SET partner_id=$1,store_id=$2 WHERE id='UPSTREAM'`, tc.partner, tc.shop)
			execSQL(t, app, `UPDATE orders SET status='success' WHERE id='UPSTREAM'`)
			resend, e := mailer.NewResend("fixture", "Platform <notify@example.test>")
			if e != nil {
				t.Fatal(e)
			}
			fake := &upstreamNotificationMail{frozenMail: frozenMail{fail: true}, sender: resend}
			svc := delivery.Service{Store: app, Sender: fake, Origin: testOrigin, DomainsEnabled: func() bool { return true }}
			out, e := svc.PartnerOrderNotifications(context.Background(), 20)
			if e != nil || out["failed"] != 1 || len(fake.bodies) != 1 {
				t.Fatal(out, e)
			}
			var message mailer.Frozen
			if e = json.Unmarshal([]byte(fake.bodies[0]), &message); e != nil {
				t.Fatal(e)
			}
			from, e := mail.ParseAddress(message.From)
			if e != nil || from.Name != tc.sender || from.Address != "notify@example.test" || !strings.HasPrefix(message.Subject, tc.sender+" · ") || !strings.Contains(message.HTML, testOrigin+tc.logo) || !strings.Contains(message.Text, tc.shopName+"，") || !strings.Contains(message.HTML, tc.workspace+"?tab=orders") {
				t.Fatal("upstream sender or recipient shop mismatch", from, message.Subject)
			}
			// A renamed upstream must not mutate a frozen retry or trigger a fresh send.
			execSQL(t, owner, `UPDATE partner_branding SET name='上级已改名' WHERE partner_id='a'; UPDATE partner_order_notifications SET next_attempt_at=0`)
			fake.fail = false
			out, e = svc.PartnerOrderNotifications(context.Background(), 20)
			if e != nil || out["sent"] != 1 || len(fake.bodies) != 2 || fake.bodies[0] != fake.bodies[1] || fake.keys[0] != fake.keys[1] {
				t.Fatal("upstream retry mutated", out, e)
			}
		})
	}
}
