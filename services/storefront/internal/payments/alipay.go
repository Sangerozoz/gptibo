package payments

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type AlipayConfig struct{ AppID, SellerID, PrivateKey, PublicKey, Gateway string }
type Alipay struct {
	config  AlipayConfig
	private *rsa.PrivateKey
	public  *rsa.PublicKey
	client  *http.Client
}

func keyBytes(raw string) ([]byte, error) {
	raw = strings.ReplaceAll(raw, `\n`, "\n")
	if block, _ := pem.Decode([]byte(raw)); block != nil {
		return block.Bytes, nil
	}
	raw = strings.Join(strings.Fields(raw), "")
	return base64.StdEncoding.DecodeString(raw)
}
func NewAlipay(c AlipayConfig) (*Alipay, error) {
	if c.Gateway == "" {
		c.Gateway = "https://openapi.alipay.com/gateway.do"
	}
	if c.Gateway != "https://openapi.alipay.com/gateway.do" && c.Gateway != "https://openapi-sandbox.dl.alipaydev.com/gateway.do" {
		return nil, errors.New("unsupported Alipay gateway")
	}
	if !regexp.MustCompile(`^[0-9]{1,32}$`).MatchString(c.AppID) || !regexp.MustCompile(`^[0-9]{1,32}$`).MatchString(c.SellerID) {
		return nil, errors.New("invalid Alipay identity")
	}
	b, e := keyBytes(c.PrivateKey)
	if e != nil {
		return nil, errors.New("invalid Alipay private key")
	}
	k, e := x509.ParsePKCS8PrivateKey(b)
	if e != nil {
		return nil, errors.New("invalid Alipay PKCS8 key")
	}
	priv, ok := k.(*rsa.PrivateKey)
	if !ok || priv.N.BitLen() < 2048 {
		return nil, errors.New("Alipay requires RSA 2048 or stronger")
	}
	b, e = keyBytes(c.PublicKey)
	if e != nil {
		return nil, errors.New("invalid Alipay public key")
	}
	p, e := x509.ParsePKIXPublicKey(b)
	if e != nil {
		return nil, errors.New("invalid Alipay SPKI key")
	}
	pub, ok := p.(*rsa.PublicKey)
	if !ok || pub.N.BitLen() < 2048 {
		return nil, errors.New("Alipay requires RSA 2048 or stronger")
	}
	return &Alipay{c, priv, pub, &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (a *Alipay) ID() string { return "alipay" }
func (a *Alipay) Account() string {
	return a.config.AppID + ":" + a.config.SellerID + ":" + a.config.Gateway
}
func canonical(values map[string]string, notification bool) string {
	keys := []string{}
	for k, v := range values {
		if v != "" && k != "sign" && (!notification || k != "sign_type") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	out := []string{}
	for _, k := range keys {
		out = append(out, k+"="+values[k])
	}
	return strings.Join(out, "&")
}
func (a *Alipay) sign(raw string) (string, error) {
	h := sha256.Sum256([]byte(raw))
	b, e := rsa.SignPKCS1v15(rand.Reader, a.private, crypto.SHA256, h[:])
	return base64.StdEncoding.EncodeToString(b), e
}
func (a *Alipay) verify(raw []byte, signature string) bool {
	b, e := base64.StdEncoding.DecodeString(signature)
	if e != nil {
		return false
	}
	h := sha256.Sum256(raw)
	return rsa.VerifyPKCS1v15(a.public, crypto.SHA256, h[:], b) == nil
}

// Reject duplicate keys throughout the response before decoding signed objects.
func uniqueJSON(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var walk func() error
	walk = func() error {
		token, e := d.Token()
		if e != nil {
			return e
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, e := d.Token()
				if e != nil {
					return e
				}
				s, ok := key.(string)
				if !ok || seen[s] {
					return errors.New("duplicate JSON key")
				}
				seen[s] = true
				if e = walk(); e != nil {
					return e
				}
			}
		case '[':
			for d.More() {
				if e := walk(); e != nil {
					return e
				}
			}
		default:
			return errors.New("invalid JSON delimiter")
		}
		_, e = d.Token()
		return e
	}
	if e := walk(); e != nil {
		return e
	}
	if _, e := d.Token(); e != io.EOF {
		return errors.New("extra JSON content")
	}
	return nil
}
func (a *Alipay) gateway(ctx context.Context, method string, biz map[string]any, extras map[string]string) (map[string]json.RawMessage, error) {
	b, e := json.Marshal(biz)
	if e != nil {
		return nil, e
	}
	values := map[string]string{"app_id": a.config.AppID, "method": method, "format": "JSON", "charset": "utf-8", "sign_type": "RSA2", "timestamp": time.Now().In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04:05"), "version": "1.0", "biz_content": string(b)}
	for k, v := range extras {
		values[k] = v
	}
	values["sign"], e = a.sign(canonical(values, false))
	if e != nil {
		return nil, e
	}
	form := url.Values{}
	for k, v := range values {
		form.Set(k, v)
	}
	req, e := http.NewRequestWithContext(ctx, "POST", a.config.Gateway, strings.NewReader(form.Encode()))
	if e != nil {
		return nil, e
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8")
	res, e := a.client.Do(req)
	if e != nil {
		return nil, errors.New("Alipay gateway unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, errors.New("Alipay gateway unavailable")
	}
	raw, e := io.ReadAll(io.LimitReader(res.Body, 100001))
	if e != nil || len(raw) > 100000 || uniqueJSON(raw) != nil {
		return nil, errors.New("Alipay response malformed")
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil {
		return nil, errors.New("Alipay response malformed")
	}
	signed := envelope[strings.ReplaceAll(method, ".", "_")+"_response"]
	var sign string
	if len(signed) == 0 || signed[0] != '{' || json.Unmarshal(envelope["sign"], &sign) != nil || !a.verify(signed, sign) {
		return nil, errors.New("Alipay response signature invalid")
	}
	var item map[string]json.RawMessage
	if json.Unmarshal(signed, &item) != nil {
		return nil, errors.New("Alipay response malformed")
	}
	return item, nil
}
func field(m map[string]json.RawMessage, key string) string {
	var s string
	_ = json.Unmarshal(m[key], &s)
	return s
}

var tradePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)
var orderPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func paymentResult(fields map[string]string, expected *Order) (Result, error) {
	r := Result{OrderID: fields["out_trade_no"], TradeNo: fields["trade_no"]}
	var e error
	r.Amount, e = AmountCents(fields["total_amount"])
	if e != nil || !orderPattern.MatchString(r.OrderID) || !tradePattern.MatchString(r.TradeNo) {
		return r, errors.New("invalid Alipay payment identity")
	}
	if expected != nil && (r.OrderID != expected.ID || r.Amount != expected.Amount) {
		return r, errors.New("Alipay payment identity or amount mismatch")
	}
	switch fields["trade_status"] {
	case "WAIT_BUYER_PAY":
		r.Status = "pending"
	case "TRADE_SUCCESS", "TRADE_FINISHED":
		r.Status = "paid"
	case "TRADE_CLOSED":
		r.Status = "closed"
	default:
		return r, errors.New("unknown Alipay trade status")
	}
	return r, nil
}
func (a *Alipay) Create(ctx context.Context, o Order, notify string) (string, error) {
	if o.Expires <= time.Now().UnixMilli() {
		return "", errors.New("payment expired")
	}
	amount, e := AmountText(o.Amount)
	if e != nil {
		return "", e
	}
	mins := (o.Expires - time.Now().UnixMilli() + 59999) / 60000
	if mins < 1 {
		mins = 1
	}
	timeout := strconv.FormatInt(mins, 10) + "m"
	r, e := a.gateway(ctx, "alipay.trade.precreate", map[string]any{"out_trade_no": o.ID, "seller_id": a.config.SellerID, "total_amount": amount, "subject": o.Subject, "timeout_express": timeout, "qr_code_timeout_express": timeout}, map[string]string{"notify_url": notify})
	if e != nil {
		return "", e
	}
	if field(r, "code") != "10000" || field(r, "out_trade_no") != o.ID {
		return "", errors.New("Alipay precreate rejected")
	}
	qr := field(r, "qr_code")
	u, e := url.Parse(qr)
	if e != nil || u.Scheme != "https" || u.Host != "qr.alipay.com" || u.User != nil {
		return "", errors.New("invalid Alipay QR URL")
	}
	return qr, nil
}
func (a *Alipay) Query(ctx context.Context, o Order) (Result, error) {
	r, e := a.gateway(ctx, "alipay.trade.query", map[string]any{"out_trade_no": o.ID}, nil)
	if e != nil {
		return Result{}, e
	}
	if field(r, "code") != "10000" {
		if field(r, "sub_code") == "ACQ.TRADE_NOT_EXIST" {
			return Result{OrderID: o.ID, Amount: o.Amount, Status: "not_found"}, nil
		}
		return Result{}, errors.New("Alipay query rejected")
	}
	if _, ok := r["seller_id"]; ok && field(r, "seller_id") != a.config.SellerID {
		return Result{}, errors.New("Alipay seller mismatch")
	}
	fields := map[string]string{}
	for _, k := range []string{"out_trade_no", "trade_no", "total_amount", "trade_status"} {
		fields[k] = field(r, k)
	}
	return paymentResult(fields, &o)
}
func (a *Alipay) Close(ctx context.Context, o Order) (bool, error) {
	r, e := a.gateway(ctx, "alipay.trade.close", map[string]any{"out_trade_no": o.ID}, nil)
	if e != nil {
		return false, e
	}
	if field(r, "code") != "10000" {
		return false, nil
	}
	if field(r, "out_trade_no") != o.ID {
		return false, errors.New("Alipay close identity mismatch")
	}
	return true, nil
}
func refundValid(o Order, r Refund) error {
	if _, e := AmountText(r.Amount); e != nil {
		return e
	}
	if r.Amount > o.Amount || !orderPattern.MatchString(r.ID) {
		return errors.New("invalid refund request")
	}
	return nil
}
func (a *Alipay) Refund(ctx context.Context, o Order, f Refund) (Refunded, error) {
	if e := refundValid(o, f); e != nil {
		return Refunded{}, e
	}
	amount, _ := AmountText(f.Amount)
	r, e := a.gateway(ctx, "alipay.trade.refund", map[string]any{"out_trade_no": o.ID, "out_request_no": f.ID, "refund_amount": amount, "refund_reason": "硅基生物 订单售后退款"}, nil)
	if e != nil {
		return Refunded{}, e
	}
	if field(r, "code") != "10000" || field(r, "out_trade_no") != o.ID {
		return Refunded{}, errors.New("Alipay refund rejected")
	}
	if field(r, "fund_change") != "Y" {
		return Refunded{}, nil
	}
	n, e := AmountCents(field(r, "refund_fee"))
	trade := field(r, "trade_no")
	if e != nil || n != f.Amount || !tradePattern.MatchString(trade) {
		return Refunded{}, errors.New("Alipay refund amount mismatch")
	}
	return Refunded{true, trade}, nil
}
func (a *Alipay) QueryRefund(ctx context.Context, o Order, f Refund) (Refunded, error) {
	if e := refundValid(o, f); e != nil {
		return Refunded{}, e
	}
	r, e := a.gateway(ctx, "alipay.trade.fastpay.refund.query", map[string]any{"out_trade_no": o.ID, "out_request_no": f.ID}, nil)
	if e != nil {
		return Refunded{}, e
	}
	if field(r, "code") != "10000" {
		code := field(r, "sub_code")
		if code == "ACQ.TRADE_NOT_EXIST" || code == "ACQ.REFUND_NOT_EXIST" {
			return Refunded{}, nil
		}
		return Refunded{}, errors.New("Alipay refund query rejected")
	}
	if field(r, "refund_status") != "REFUND_SUCCESS" {
		return Refunded{}, nil
	}
	total, e1 := AmountCents(field(r, "total_amount"))
	amount, e2 := AmountCents(field(r, "refund_amount"))
	trade := field(r, "trade_no")
	if e1 != nil || e2 != nil || total != o.Amount || amount != f.Amount || field(r, "out_trade_no") != o.ID || field(r, "out_request_no") != f.ID || !tradePattern.MatchString(trade) {
		return Refunded{}, errors.New("Alipay refund identity or amount mismatch")
	}
	return Refunded{true, trade}, nil
}
func (a *Alipay) Notification(req *http.Request) (Result, error) {
	typ, _, e := mime.ParseMediaType(req.Header.Get("Content-Type"))
	if e != nil || req.Method != "POST" || typ != "application/x-www-form-urlencoded" {
		return Result{}, errors.New("invalid notification format")
	}
	b, e := io.ReadAll(io.LimitReader(req.Body, 16385))
	if e != nil || len(b) > 16384 {
		return Result{}, errors.New("invalid notification size")
	}
	form, e := url.ParseQuery(string(b))
	if e != nil {
		return Result{}, errors.New("invalid notification form")
	}
	values := map[string]string{}
	for k, v := range form {
		if len(v) != 1 {
			return Result{}, errors.New("duplicate notification field")
		}
		values[k] = v[0]
	}
	if values["app_id"] != a.config.AppID || values["seller_id"] != a.config.SellerID || values["sign_type"] != "RSA2" || !a.verify([]byte(canonical(values, true)), values["sign"]) {
		return Result{}, fmt.Errorf("invalid Alipay notification")
	}
	return paymentResult(values, nil)
}
