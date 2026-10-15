package payments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
	"gptibo/storefront/internal/fault"
	"gptibo/storefront/internal/orders"
	"gptibo/storefront/internal/security"
	"gptibo/storefront/internal/store"
)

type Service struct {
	Store        *store.Store
	Provider     Provider
	Providers    map[string]Provider
	NotifyOrigin string
	Checkout     bool
}
type Payment struct {
	Fee        int64   `json:"fee_cents"`
	FeeBPS     int64   `json:"fee_bps"`
	OrderID    string  `json:"order_id"`
	Provider   string  `json:"provider"`
	Account    string  `json:"account"`
	Amount     int64   `json:"amount_cents"`
	State      string  `json:"state"`
	TradeNo    *string `json:"trade_no"`
	QR         *string `json:"qr"`
	Expires    int64   `json:"expires_at"`
	Lease      *string `json:"lease_token"`
	LeaseUntil int64   `json:"lease_until"`
}

func Find(ctx context.Context, q orders.Query, id string, lock bool) (Payment, error) {
	var p Payment
	var raw []byte
	sql := `SELECT to_jsonb(p) FROM payments p WHERE order_id=$1`
	if lock {
		sql += ` FOR UPDATE`
	}
	e := q.QueryRow(ctx, sql, id).Scan(&raw)
	if e != nil {
		return p, e
	}
	e = json.Unmarshal(raw, &p)
	return p, e
}
func (s Service) provider(p Payment) (Provider, error) {
	return s.Resolve(p.Provider, p.Account)
}
func (s Service) notifyURL(ids ...string) (string, error) {
	u, e := url.Parse(s.NotifyOrigin)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return "", fault.New(503, "支付回调来源配置无效。")
	}
	id := ""
	if s.Provider != nil {
		id = s.Provider.ID()
	}
	if len(ids) > 0 {
		id = ids[0]
	}
	if s.Lookup(id) == nil {
		return "", fault.New(503, "支付服务未配置。")
	}
	return s.NotifyOrigin + "/api/payments/notify/" + id, nil
}
func details(p Payment, o orders.Order) Order {
	subject := "硅基生物 · " + o.PlanName
	if o.Test != 0 {
		subject = "硅基生物 · 支付联调测试（不交付商品）"
	}
	trade := ""
	if p.TradeNo != nil {
		trade = *p.TradeNo
	}
	return Order{ID: o.ID, Subject: subject, Amount: p.Amount, Expires: p.Expires, TradeNo: trade}
}
func (s Service) Apply(ctx context.Context, expected Payment, r Result) error {
	if r.OrderID != expected.OrderID || r.Amount != expected.Amount || (r.Status != "pending" && r.Status != "not_found" && r.Status != "paid" && r.Status != "closed") || (r.Status == "paid" && !tradePattern.MatchString(r.TradeNo)) {
		return fault.New(409, "支付结果与订单不匹配。")
	}
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	o, e := orders.Get(ctx, tx, expected.OrderID, nil, true)
	if e != nil {
		return e
	}
	p, e := Find(ctx, tx, expected.OrderID, true)
	if e != nil {
		return e
	}
	if p.Provider != expected.Provider || p.Account != expected.Account || p.Amount != expected.Amount || o.Mode != "live" || o.Price+p.Fee != p.Amount || (p.TradeNo != nil && r.TradeNo != "" && *p.TradeNo != r.TradeNo) {
		return fault.New(409, "支付身份、金额或流水不匹配。")
	}
	if r.Status == "pending" || r.Status == "not_found" || p.State == "paid" || p.State == r.Status {
		return tx.Commit(ctx)
	}
	var trade any
	if r.TradeNo != "" {
		trade = r.TradeNo
	}
	_, e = tx.Exec(ctx, `UPDATE payments SET state=$1,trade_no=COALESCE(trade_no,$2),qr=NULL,updated_at=$3 WHERE order_id=$4`, r.Status, trade, time.Now().UnixMilli(), o.ID)
	if e != nil {
		return e
	}
	if o.Payment == "unpaid" {
		next := o
		action := "payment-closed"
		note := "支付渠道已确认关闭交易"
		if r.Status == "paid" {
			next.Payment = "paid"
			if o.Status == "pending" || o.Status == "cancelled" {
				next.Status = "session"
			}
			action = "payment-confirmed"
			note = "支付渠道已核验收款，等待交付"
		} else if o.Status == "pending" {
			next.Status = "cancelled"
		}
		if _, e = orders.Change(ctx, tx, o, next, "payment", action, note); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
func (s Service) acquire(ctx context.Context, id string) (Payment, string, error) {
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		return Payment{}, "", e
	}
	defer tx.Rollback(ctx)
	if _, e = orders.Get(ctx, tx, id, nil, true); e != nil {
		return Payment{}, "", e
	}
	token := security.ID()
	now := time.Now().UnixMilli()
	tag, e := tx.Exec(ctx, `UPDATE payments SET lease_token=$1,lease_until=$2 WHERE order_id=$3 AND lease_until<=$4`, token, now+45000, id, now)
	if e != nil {
		return Payment{}, "", e
	}
	if tag.RowsAffected() != 1 {
		return Payment{}, "", fault.New(409, "支付状态正在确认，请稍后重试。")
	}
	p, e := Find(ctx, tx, id, false)
	if e != nil {
		return p, "", e
	}
	return p, token, tx.Commit(ctx)
}
func (s Service) release(id, token string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = s.Store.DB.Exec(ctx, `UPDATE payments SET lease_token=NULL,lease_until=0 WHERE order_id=$1 AND lease_token=$2`, id, token)
}
func (s Service) sync(ctx context.Context, p Payment, o orders.Order, close bool) error {
	provider, e := s.provider(p)
	if e != nil {
		return e
	}
	d := details(p, o)
	r, e := provider.Query(ctx, d)
	if e != nil {
		return e
	}
	if e = s.Apply(ctx, p, r); e != nil {
		return e
	}
	if close && r.Status != "paid" && r.Status != "closed" {
		closed, e := provider.Close(ctx, d)
		if e != nil {
			return e
		}
		if closed {
			r = Result{OrderID: o.ID, Amount: p.Amount, Status: "closed"}
		} else {
			r, e = provider.Query(ctx, d)
			if e != nil {
				return e
			}
			if r.Status == "not_found" && time.Now().UnixMilli() > p.Expires+120000 {
				r.Status = "closed"
			}
		}
		if e = s.Apply(ctx, p, r); e != nil {
			return e
		}
	}
	_, e = s.Store.DB.Exec(ctx, `UPDATE payments SET updated_at=$1 WHERE order_id=$2`, time.Now().UnixMilli(), o.ID)
	return e
}
func (s Service) Action(ctx context.Context, id string, access *orders.Access, action string, allowTest bool, methods ...string) (map[string]any, error) {
	if action != "create" && action != "query" && action != "close" && action != "options" {
		return nil, fault.New(400, "支付操作无效。")
	}
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	o, e := orders.Get(ctx, tx, id, access, true)
	if e != nil {
		return nil, e
	}
	if o.Mode != "live" {
		return nil, fault.New(409, "历史测试记录不能发起收款。")
	}
	var supplier bool
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM recharge_orders WHERE order_id=$1)`, id).Scan(&supplier)
	if e != nil {
		return nil, e
	}
	if supplier {
		return nil, fault.New(409, "请使用订单原平台付款入口。")
	}
	canCreate := s.Checkout || (allowTest && o.Test == 1 && o.Price == 1 && o.PartnerID == nil)
	p, e := Find(ctx, tx, id, false)
	if action == "options" {
		if e != nil && e != pgx.ErrNoRows {
			return nil, e
		}
		available, err := s.Methods(ctx, tx)
		if err != nil {
			return nil, err
		}
		if !canCreate || o.Status != "pending" || o.Payment != "unpaid" || o.Blocked != 0 || o.Hold != 0 || o.Refunded != 0 {
			available = []MethodOption{}
		}
		var payment any
		if e == nil {
			payment = paymentView(p, o)
			available = []MethodOption{}
		}
		return map[string]any{"payment": payment, "methods": available}, nil
	}
	if e == nil && action == "create" && len(methods) > 0 && methods[0] != "" && methods[0] != Method(p.Provider) {
		return nil, fault.New(409, "本订单已有付款单，请使用原支付方式，勿重复付款。")
	}
	if e == pgx.ErrNoRows && action == "create" {
		if !canCreate {
			return nil, fault.New(503, "真实收款尚未开放。")
		}
		var selected Provider
		selected, e = s.Selected(ctx, tx, methods...)
		if e != nil {
			return nil, e
		}
		if _, e = s.notifyURL(selected.ID()); e != nil {
			return nil, e
		}
		if o.Status != "pending" || o.Payment != "unpaid" || o.Blocked != 0 || o.Hold != 0 || o.Refunded != 0 {
			return nil, orders.Conflict()
		}
		expected, _ := ctx.Value(feeQuoteKey{}).(*int64)
		e = s.insertIntent(ctx, tx, o, selected, expected)
		if e != nil {
			return nil, e
		}
		p, e = Find(ctx, tx, id, false)
	}
	if e == pgx.ErrNoRows {
		return nil, fault.New(409, "该订单没有可用的支付记录。")
	}
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	p, lease, e := s.acquire(ctx, id)
	if e != nil {
		return nil, e
	}
	defer s.release(id, lease)
	if p.State == "pending" {
		if action == "create" && p.Expires > time.Now().UnixMilli() {
			if !canCreate {
				return nil, fault.New(503, "真实收款尚未开放。")
			}
			o, e = orders.Get(ctx, s.Store.DB, id, access, false)
			if e != nil {
				return nil, e
			}
			if o.Blocked != 0 || o.Hold != 0 || o.Refunded != 0 || o.Payment != "unpaid" || o.Status != "pending" {
				return nil, orders.Conflict()
			}
			if p.QR == nil {
				provider, e := s.provider(p)
				if e != nil {
					return nil, e
				}
				notify, e := s.notifyURL(p.Provider)
				if e != nil {
					return nil, e
				}
				qr, e := provider.Create(ctx, details(p, o), notify)
				if e != nil {
					return nil, e
				}
				tag, e := s.Store.DB.Exec(ctx, `UPDATE payments SET qr=$1,updated_at=$2 WHERE order_id=$3 AND state='pending' AND lease_token=$4 AND lease_until>$2`, qr, time.Now().UnixMilli(), id, lease)
				if e != nil {
					return nil, e
				}
				if tag.RowsAffected() != 1 {
					fresh, e := Find(ctx, s.Store.DB, id, false)
					if e != nil || fresh.State == "pending" {
						return nil, orders.Conflict()
					}
				}
			}
		} else if e = s.sync(ctx, p, o, action == "close" || p.Expires <= time.Now().UnixMilli()); e != nil {
			return nil, e
		}
	}
	p, e = Find(ctx, s.Store.DB, id, false)
	if e != nil {
		return nil, e
	}
	o, e = orders.Get(ctx, s.Store.DB, id, access, false)
	if e != nil {
		return nil, e
	}
	return map[string]any{"payment": paymentView(p, o)}, nil
}

// Persist the email-step choice in the same transaction as the retail order.
// No upstream payment is created until checkout opens this bound intent.
func (s Service) Prepare(ctx context.Context, tx pgx.Tx, o orders.Order, in orders.CreateInput) error {
	if in.PaymentMethod == "" {
		return nil
	} // Legacy clients choose on checkout.
	var supplier bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM recharge_orders WHERE order_id=$1)`, o.ID).Scan(&supplier); e != nil {
		return e
	}
	if supplier || o.Mode != "live" {
		return fault.New(400, "该订单使用平台付款入口。")
	}
	p, e := Find(ctx, tx, o.ID, false)
	if e == nil {
		if Method(p.Provider) != in.PaymentMethod {
			return fault.New(409, "原订单已选择其他支付方式，请打开原订单继续付款。")
		}
		return nil
	}
	if e != pgx.ErrNoRows {
		return e
	}
	if !s.Checkout || o.Status != "pending" || o.Payment != "unpaid" || o.Hold != 0 || o.Blocked != 0 || o.Refunded != 0 {
		return orders.Conflict()
	}
	selected, e := s.Selected(ctx, tx, in.PaymentMethod)
	if e != nil {
		return e
	}
	if _, e = s.notifyURL(selected.ID()); e != nil {
		return e
	}
	e = s.insertIntent(ctx, tx, o, selected, in.ExpectedFeeBPS)
	return e
}
func paymentView(p Payment, o orders.Order) map[string]any {
	var qr any
	if o.Blocked == 0 && o.Hold == 0 && o.Refunded == 0 && p.State == "pending" && p.Expires > time.Now().UnixMilli() {
		qr = p.QR
	}
	return map[string]any{"provider": p.Provider, "method": Method(p.Provider), "amountCents": p.Amount, "feeCents": p.Fee, "feeBps": p.FeeBPS, "status": p.State, "qr": qr, "expiresAt": p.Expires}
}

func (s Service) Notify(req *http.Request, providerID string) bool {
	provider := s.Lookup(providerID)
	if provider == nil {
		return false
	}
	r, e := provider.Notification(req)
	if e != nil {
		return false
	}
	p, e := Find(req.Context(), s.Store.DB, r.OrderID, false)
	if e != nil || p.Provider != providerID || p.Account != provider.Account() {
		return false
	}
	if s.Apply(req.Context(), p, r) != nil {
		return false
	}
	if r.Status == "paid" {
		_, e = s.Store.DB.Exec(req.Context(), `UPDATE payments SET notified_at=COALESCE(notified_at,$1) WHERE order_id=$2 AND state='paid'`, time.Now().UnixMilli(), r.OrderID)
	}
	return e == nil
}
func (s Service) Reconcile(ctx context.Context) (map[string]int, error) {
	rows, e := s.Store.DB.Query(ctx, `SELECT order_id FROM payments WHERE state='pending' AND lease_until<=$1 ORDER BY updated_at LIMIT 10`, time.Now().UnixMilli())
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	out := map[string]int{"checked": 0, "confirmed": 0, "failed": 0}
	for _, id := range ids {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		out["checked"]++
		e := func() error {
			p, token, e := s.acquire(ctx, id)
			if e != nil {
				return e
			}
			defer s.release(id, token)
			if p.State != "pending" {
				return nil
			}
			o, e := orders.Get(ctx, s.Store.DB, id, nil, false)
			if e != nil {
				return e
			}
			return s.sync(ctx, p, o, p.Expires <= time.Now().UnixMilli())
		}()
		if e != nil {
			out["failed"]++
			_, _ = s.Store.DB.Exec(ctx, `UPDATE payments SET updated_at=$1 WHERE order_id=$2`, time.Now().UnixMilli(), id)
		} else {
			out["confirmed"]++
		}
	}
	return out, nil
}
func (s Service) RefundOriginal(ctx context.Context, id, caseID string, amount int64) (string, error) {
	p, token, e := s.acquire(ctx, id)
	if e != nil {
		return "", e
	}
	defer s.release(id, token)
	o, e := orders.Get(ctx, s.Store.DB, id, nil, false)
	if e != nil {
		return "", e
	}
	if p.State != "paid" || o.Payment != "paid" || o.Hold == 0 || p.TradeNo == nil || o.Price+p.Fee != p.Amount {
		return "", orders.Conflict()
	}
	provider, e := s.provider(p)
	if e != nil {
		return "", e
	}
	d := details(p, o)
	f, state, e := s.refundIntent(ctx, p, o, caseID, amount)
	if e != nil {
		return "", e
	}
	if state == "confirmed" {
		return p.Provider + ":" + caseID, nil
	}
	if single, ok := provider.(interface{ SingleAttemptRefund() bool }); ok && single.SingleAttemptRefund() {
		tag, err := s.Store.DB.Exec(ctx, `UPDATE payment_refund_attempts SET state='submitted',updated_at=now() WHERE id=$1 AND state='prepared'`, caseID)
		if err != nil {
			return "", err
		}
		if tag.RowsAffected() != 1 {
			return "", fault.New(409, "该笔退款已进入核对状态，需在卓付后台核对结果，勿重复退款。")
		}
		r, err := provider.Refund(ctx, d, f)
		if err != nil || !r.Confirmed || r.TradeNo != *p.TradeNo {
			return "", fault.New(409, "卓付退款结果未确认，请在商户后台核对后登记；系统不会重复提交。")
		}
		if _, err = s.Store.DB.Exec(ctx, `UPDATE payment_refund_attempts SET state='confirmed',updated_at=now() WHERE id=$1`, caseID); err != nil {
			return "", err
		}
		return p.Provider + ":" + caseID, nil
	}
	var r Refunded
	if first, ok := provider.(interface{ SubmitRefundFirst() bool }); ok && first.SubmitRefundFirst() {
		// Even an ambiguous submission is reconciled by the same idempotency key.
		_, submitErr := provider.Refund(ctx, d, f)
		r, e = provider.QueryRefund(ctx, d, f)
		if e != nil {
			return "", e
		}
		if !r.Confirmed {
			if submitErr != nil {
				return "", submitErr
			}
			return "", errors.New("refund result unconfirmed")
		}
	} else {
		r, e = provider.QueryRefund(ctx, d, f)
		if e != nil {
			return "", e
		}
	}
	if !r.Confirmed {
		r, e = provider.Refund(ctx, d, f)
		if e != nil {
			return "", e
		}
	}
	if !r.Confirmed {
		r, e = provider.QueryRefund(ctx, d, f)
		if e != nil {
			return "", e
		}
	}
	if !r.Confirmed || r.TradeNo != *p.TradeNo {
		return "", errors.New("refund result unconfirmed")
	}
	if _, e = s.Store.DB.Exec(ctx, `UPDATE payment_refund_attempts SET state='confirmed',updated_at=now() WHERE id=$1`, caseID); e != nil {
		return "", e
	}
	return p.Provider + ":" + caseID, nil
}
