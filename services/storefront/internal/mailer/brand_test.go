package mailer

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/mail"
	"strings"
	"testing"
)

func TestPlatformBrandUsesChineseIdentityAndConfiguredOrigin(t *testing.T) {
	b := PlatformBrand("https://meghan.example.test/")
	if b.Name != "硅基生物" || b.Logo != "https://meghan.example.test/email-logo.png" || b.AdminURL != "https://meghan.example.test/admin" {
		t.Fatalf("unexpected platform mail brand: %+v", b)
	}
}

func TestBrandedTemplatesCoverEveryMailAndEscapeIdentity(t *testing.T) {
	var templates map[string]Message
	if e := json.Unmarshal(templateJSON, &templates); e != nil {
		t.Fatal(e)
	}
	brand := PlatformBrand("https://platform.example.test")
	brand.Name = `星河 <商店> & "服务"`
	brand.Logo = "https://platform.example.test/store-logos/fixture.png"
	brand.OrdersURL = "https://shop.example.test/r/ABC123/orders"
	brand.WorkspaceURL = "https://shop.example.test/join"
	fields := map[string]string{"VERIFICATION_CODE": "001234", "DELIVERY_ORDER": "order", "DELIVERY_VALUE": "fixture", "DELIVERY_URL": "https://claim.example.test/claim", "DELIVERY_INSTRUCTIONS": "help", "REMINDER_ORDER_ID": "order", "REMINDER_PLAN_NAME": "Plus", "REMINDER_CONTACTS": "客服", "ORDER_ID": "order", "SHOP_NAME": brand.Name, "ORDER_PRODUCT": "Plus", "ORDER_AMOUNT": "¥120.00", "ORDER_CUSTOMER": "buyer@example.test", "ORDER_COMPLETED": "2026/10/12"}
	for kind := range templates {
		t.Run(kind, func(t *testing.T) {
			m, e := BrandedTemplate(kind, brand, fields)
			if e != nil {
				t.Fatal(e)
			}
			if !strings.HasPrefix(m.Subject, brand.Name+" · ") || !strings.Contains(m.HTML, "星河 &lt;商店&gt; &amp;") || !strings.Contains(m.Text, brand.Name) || m.SenderName != brand.Name {
				t.Fatal("missing branded subject/html/text/sender", m.Subject)
			}
			if strings.Contains(m.HTML, "<商店>") || strings.Contains(m.HTML+m.Text+m.Subject, "__RECHARGE_") || strings.Contains(m.HTML+m.Text+m.Subject, "硅基生物") || strings.Contains(m.HTML, "RECHARGE AI") {
				t.Fatal("unsafe, unresolved or platform identity remains")
			}
			if !strings.Contains(m.HTML, brand.Logo) {
				t.Fatal("wrong logo")
			}
		})
	}
	brand.Name = "品牌 __RECHARGE_VERIFICATION_CODE__"
	fields["BRAND_NAME"] = "不可覆盖的品牌"
	m, e := BrandedTemplate("partner-login", brand, fields)
	if e != nil || !strings.Contains(m.HTML, "品牌 __RECHARGE_VERIFICATION_CODE__") || strings.Contains(m.HTML, fields["BRAND_NAME"]) {
		t.Fatal("brand was interpreted as a second template", e)
	}
}

func TestBrandedSenderFreezesDisplayNameAndVerifiedMailbox(t *testing.T) {
	r, e := NewResend("fixture", "Platform <notify@example.test>")
	if e != nil {
		t.Fatal(e)
	}
	b := PlatformBrand("https://platform.example.test")
	b.Name = `星河 "店铺"`
	m, e := BrandedTemplate("partner-welcome", b, nil)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := r.Freeze("child@example.test", m)
	if e != nil {
		t.Fatal(e)
	}
	var frozen Frozen
	if e = json.Unmarshal([]byte(raw), &frozen); e != nil {
		t.Fatal(e)
	}
	from, e := mail.ParseAddress(frozen.From)
	if e != nil || from.Address != "notify@example.test" || from.Name != b.Name {
		t.Fatal("sender mismatch", from, e)
	}
	calls := 0
	r.client.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		calls++
		body, _ := io.ReadAll(req.Body)
		if string(body) != raw || req.Header.Get("Idempotency-Key") != "fixture-original" {
			t.Fatal("retry mutated original mail")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":"fixture"}`)), Header: http.Header{}}, nil
	})
	r.from = "Renamed Platform <notify@example.test>"
	if _, e = r.SendFrozen(context.Background(), raw, "fixture-original"); e != nil {
		t.Fatal(e)
	}
	r.from = "Platform <different@example.test>"
	if _, e = r.SendFrozen(context.Background(), raw, "fixture-original"); e == nil || calls != 1 {
		t.Fatal("switched verified mailbox accepted")
	}
	m.SenderName = "Store\r\nBcc: victim@example.test"
	if _, e = r.Freeze("child@example.test", m); e == nil {
		t.Fatal("header injection accepted")
	}
}

func TestInvitationContextBrandAndSeparateDestination(t *testing.T) {
	r, _ := NewResend("fixture", "Platform <notify@example.test>")
	r.Origin = "https://platform.example.test"
	b := PlatformBrand(r.Origin)
	b.Name = "一级店"
	b.Logo = "https://platform.example.test/parent.png"
	r.client.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		var f Frozen
		if e := json.NewDecoder(req.Body).Decode(&f); e != nil {
			t.Fatal(e)
		}
		a, _ := mail.ParseAddress(f.From)
		if a.Name != "一级店" || !strings.Contains(f.HTML, b.Logo) || !strings.Contains(f.Text, "https://child.example.test/join") || strings.Contains(f.Text, "硅基生物") {
			t.Fatal("inviter identity or child login destination lost")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":"fixture"}`)), Header: http.Header{}}, nil
	})
	if e := r.SendInvitation(WithBrand(context.Background(), b), "child@example.test", "https://child.example.test", "fixture"); e != nil {
		t.Fatal(e)
	}
}
