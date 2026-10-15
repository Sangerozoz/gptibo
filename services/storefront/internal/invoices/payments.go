package invoices

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"gptibo/storefront/internal/fault"
	"gptibo/storefront/internal/orders"
	"gptibo/storefront/internal/payments"
	"gptibo/storefront/internal/security"
)

func (s Service) paymentService() payments.Service {
	if s.Payments != nil {
		return *s.Payments
	}
	return payments.Service{Store: s.Store, Provider: s.Provider, NotifyOrigin: s.NotifyOrigin}
}
func (s Service) provider(p map[string]any) (payments.Provider, error) {
	return s.paymentService().Resolve(p["provider"].(string), p["account"].(string))
}
func payOrder(p map[string]any) payments.Order {
	return payments.Order{ID: p["id"].(string), Amount: p["amount_cents"].(int64), Expires: p["expires_at"].(int64), Subject: "硅基生物 · 开票手续费"}
}
func (s Service) Apply(ctx context.Context, expected map[string]any, r payments.Result) error {
	if expected["id"] != r.OrderID || expected["amount_cents"] != r.Amount || (r.Status != "pending" && r.Status != "not_found" && r.Status != "paid" && r.Status != "closed") || (r.Status == "paid" && r.TradeNo == "") {
		return orders.Conflict()
	}
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	row, e := get(ctx, tx, expected["invoice_id"].(string), "", true)
	if e != nil {
		return e
	}
	list, e := orders.Rows(ctx, tx, `SELECT * FROM invoice_payments WHERE id=$1 FOR UPDATE`, r.OrderID)
	if e != nil {
		return e
	}
	if len(list) != 1 {
		return orders.Conflict()
	}
	p := list[0]
	if p["invoice_id"] != row["id"] || p["account"] != expected["account"] || p["provider"] != expected["provider"] || p["amount_cents"] != r.Amount || row["fee_cents"] != r.Amount || (p["trade_no"] != nil && r.TradeNo != "" && p["trade_no"] != r.TradeNo) {
		return orders.Conflict()
	}
	if r.Status == "pending" || r.Status == "not_found" || p["state"] == "paid" || p["state"] == r.Status {
		return tx.Commit(ctx)
	}
	var trade any
	if r.TradeNo != "" {
		trade = r.TradeNo
	}
	now := time.Now().UnixMilli()
	_, e = tx.Exec(ctx, `UPDATE invoice_payments SET state=$1,trade_no=COALESCE(trade_no,$2),qr=NULL,updated_at=$3 WHERE id=$4`, r.Status, trade, now, r.OrderID)
	if e != nil {
		return e
	}
	if r.Status == "paid" && row["status"] == "awaiting_payment" {
		_, e = tx.Exec(ctx, `UPDATE partner_invoices SET status='awaiting_submission',paid_at=$1,updated_at=$1,version=version+1 WHERE id=$2`, now, row["id"])
		if e != nil {
			return e
		}
		if e = event(ctx, tx, row["id"].(string), "payment", "paid", "支付渠道已确认手续费到账"); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
func (s Service) acquire(ctx context.Context, id string) (string, error) {
	token := security.ID()
	now := time.Now().UnixMilli()
	tag, e := s.Store.DB.Exec(ctx, `UPDATE partner_invoices SET lease_token=$1,lease_until=$2 WHERE id=$3 AND lease_until<=$4`, token, now+60000, id, now)
	if e != nil {
		return "", e
	}
	if tag.RowsAffected() != 1 {
		return "", fault.New(409, "支付正在确认，请稍后重试。")
	}
	return token, nil
}
func (s Service) release(id, token string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = s.Store.DB.Exec(ctx, `UPDATE partner_invoices SET lease_token=NULL,lease_until=0 WHERE id=$1 AND lease_token=$2`, id, token)
}
func (s Service) sync(ctx context.Context, p map[string]any) error {
	provider, e := s.provider(p)
	if e != nil {
		return e
	}
	o := payOrder(p)
	r, e := provider.Query(ctx, o)
	if e != nil {
		return e
	}
	if e = s.Apply(ctx, p, r); e != nil {
		return e
	}
	row, e := get(ctx, s.Store.DB, p["invoice_id"].(string), "", false)
	if e != nil {
		return e
	}
	if r.Status != "paid" && r.Status != "closed" && (o.Expires <= time.Now().UnixMilli() || row["paid_at"] != nil) {
		closed, e := provider.Close(ctx, o)
		if e != nil {
			return e
		}
		if closed {
			r = payments.Result{OrderID: o.ID, Amount: o.Amount, Status: "closed"}
		} else {
			r, e = provider.Query(ctx, o)
			if e != nil {
				return e
			}
			if r.Status == "not_found" && time.Now().UnixMilli() > o.Expires+120000 {
				r.Status = "closed"
			}
		}
		if e = s.Apply(ctx, p, r); e != nil {
			return e
		}
	}
	_, e = s.Store.DB.Exec(ctx, `UPDATE invoice_payments SET updated_at=$1 WHERE id=$2`, time.Now().UnixMilli(), o.ID)
	return e
}
func (s Service) PaymentAction(ctx context.Context, role, token, id, action string, methods ...string) (map[string]any, error) {
	if (role != "partner" && role != "admin") || (action != "create" && action != "query" && action != "options") || (role == "admin" && action != "query") {
		return nil, fault.New(400, "支付操作无效。")
	}
	p, e := s.Auth.Require(ctx, s.Store.DB, role, token)
	if e != nil {
		return nil, e
	}
	row, e := get(ctx, s.Store.DB, id, scope(p), false)
	if e != nil {
		return nil, e
	}
	if e = s.Auth.Limit(ctx, "invoice-payment:"+row["partner_id"].(string), 30, 60); e != nil {
		return nil, e
	}
	if action == "options" {
		payment, e := currentPayment(ctx, s.Store.DB, id)
		if e != nil {
			return nil, e
		}
		available, e := s.paymentService().Methods(ctx, s.Store.DB)
		if e != nil {
			return nil, e
		}
		if payment != nil && payment["state"] != "closed" || row["status"] != "awaiting_payment" {
			available = []payments.MethodOption{}
		}
		return map[string]any{"invoice": public(row), "payment": paymentView(payment, row), "methods": available}, nil
	}
	lease, e := s.acquire(ctx, id)
	if e != nil {
		return nil, e
	}
	defer s.release(id, lease)
	row, e = get(ctx, s.Store.DB, id, scope(p), false)
	if e != nil {
		return nil, e
	}
	payment, e := currentPayment(ctx, s.Store.DB, id)
	if e != nil {
		return nil, e
	}
	if payment != nil && payment["state"] != "closed" && action == "create" && len(methods) > 0 && methods[0] != "" && methods[0] != payments.Method(payment["provider"].(string)) {
		return nil, fault.New(409, "本申请已有付款单，请使用原支付方式。")
	}
	if row["status"] == "awaiting_payment" {
		if payment != nil && payment["state"] == "pending" && (action == "query" || payment["expires_at"].(int64) <= time.Now().UnixMilli()) {
			if e = s.sync(ctx, payment); e != nil {
				return nil, e
			}
			payment, e = currentPayment(ctx, s.Store.DB, id)
			if e != nil {
				return nil, e
			}
			row, e = get(ctx, s.Store.DB, id, scope(p), false)
			if e != nil {
				return nil, e
			}
		}
		if action == "create" && row["status"] == "awaiting_payment" {
			u, e := url.Parse(s.NotifyOrigin)
			if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery || s.paymentService().Provider == nil {
				return nil, fault.New(503, "支付渠道或回调来源未配置。")
			}
			if payment == nil || payment["state"] == "closed" {
				tx, e := s.Store.DB.Begin(ctx)
				if e != nil {
					return nil, e
				}
				defer tx.Rollback(ctx)
				principal, e := s.Auth.Require(ctx, tx, role, token)
				if e != nil {
					return nil, e
				}
				row, e = get(ctx, tx, id, scope(principal), true)
				if e != nil {
					return nil, e
				}
				if row["status"] == "awaiting_payment" && row["lease_token"] == lease && row["lease_until"].(int64) > time.Now().UnixMilli() {
					selected, e := s.paymentService().Selected(ctx, tx, methods...)
					if e != nil {
						return nil, e
					}
					now := time.Now().UnixMilli()
					_, e = tx.Exec(ctx, `INSERT INTO invoice_payments(id,invoice_id,provider,account,amount_cents,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`, "INV"+strings.ReplaceAll(security.ID(), "-", ""), id, selected.ID(), selected.Account(), row["fee_cents"], now+900000, now)
					if e != nil {
						return nil, e
					}
				}
				if e = tx.Commit(ctx); e != nil {
					return nil, e
				}
				payment, e = currentPayment(ctx, s.Store.DB, id)
				if e != nil {
					return nil, e
				}
			}
			if payment != nil && payment["state"] == "pending" && payment["qr"] == nil && payment["expires_at"].(int64) > time.Now().UnixMilli() {
				provider, e := s.provider(payment)
				if e != nil {
					return nil, e
				}
				qr, e := provider.Create(ctx, payOrder(payment), s.NotifyOrigin+"/api/invoices/notify/"+provider.ID())
				if e != nil {
					return nil, e
				}
				_, e = s.Store.DB.Exec(ctx, `UPDATE invoice_payments SET qr=$1,updated_at=$2 WHERE id=$3 AND state='pending' AND EXISTS(SELECT 1 FROM partner_invoices i WHERE i.id=invoice_payments.invoice_id AND i.lease_token=$4 AND i.lease_until>$2 AND i.status='awaiting_payment')`, qr, time.Now().UnixMilli(), payment["id"], lease)
				if e != nil {
					return nil, e
				}
			}
		}
	}
	row, e = get(ctx, s.Store.DB, id, scope(p), false)
	if e != nil {
		return nil, e
	}
	payment, e = currentPayment(ctx, s.Store.DB, id)
	if e != nil {
		return nil, e
	}
	available := []payments.MethodOption{}
	if payment == nil || payment["state"] == "closed" {
		available, e = s.paymentService().Methods(ctx, s.Store.DB)
		if e != nil {
			return nil, e
		}
	}
	return map[string]any{"invoice": public(row), "payment": paymentView(payment, row), "methods": available}, nil
}
func (s Service) Notify(req *http.Request, ids ...string) bool {
	provider := s.Provider
	if len(ids) > 0 {
		provider = s.paymentService().Lookup(ids[0])
	}
	if provider == nil {
		return false
	}
	r, e := provider.Notification(req)
	if e != nil {
		return false
	}
	p, e := orders.Rows(req.Context(), s.Store.DB, `SELECT * FROM invoice_payments WHERE id=$1`, r.OrderID)
	if e != nil || len(p) != 1 || p[0]["provider"] != provider.ID() || p[0]["account"] != provider.Account() {
		return false
	}
	if e = s.Apply(req.Context(), p[0], r); e != nil {
		return false
	}
	if r.Status == "paid" {
		_, e = s.Store.DB.Exec(req.Context(), `UPDATE invoice_payments SET notified_at=COALESCE(notified_at,$1) WHERE id=$2 AND state='paid'`, time.Now().UnixMilli(), r.OrderID)
	}
	return e == nil
}
func (s Service) Reconcile(ctx context.Context) (map[string]int, error) {
	rows, e := orders.Rows(ctx, s.Store.DB, `SELECT p.* FROM invoice_payments p JOIN partner_invoices i ON i.id=p.invoice_id WHERE p.state='pending' AND i.lease_until<=$1 ORDER BY p.updated_at LIMIT 10`, time.Now().UnixMilli())
	if e != nil {
		return nil, e
	}
	out := map[string]int{"checked": 0, "failed": 0}
	for _, p := range rows {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		out["checked"]++
		id := p["invoice_id"].(string)
		e := func() error {
			lease, e := s.acquire(ctx, id)
			if e != nil {
				return e
			}
			defer s.release(id, lease)
			return s.sync(ctx, p)
		}()
		if e != nil {
			out["failed"]++
			_, _ = s.Store.DB.Exec(ctx, `UPDATE invoice_payments SET updated_at=$1 WHERE id=$2`, time.Now().UnixMilli(), p["id"])
		}
	}
	return out, nil
}
