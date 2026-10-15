// Package securityaudit stores bounded, redacted security records and short bans.
package securityaudit

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/netip"
	"strings"
	"time"

	"gptibo/storefront/internal/auth"
	"gptibo/storefront/internal/fault"
	"gptibo/storefront/internal/mailer"
	"gptibo/storefront/internal/security"
	"gptibo/storefront/internal/store"
)

type Service struct {
	Store     *store.Store
	Auth      *auth.Service
	Sender    mailer.Sender
	Recipient string
}
type Event struct {
	ID        string    `json:"id"`
	Time      time.Time `json:"time"`
	Kind      string    `json:"kind"`
	IP        string    `json:"ip"`
	Host      string    `json:"host"`
	RequestID string    `json:"requestId"`
	Route     string    `json:"route"`
	Method    string    `json:"method"`
	Status    int       `json:"status"`
	Role      string    `json:"role"`
	Account   string    `json:"account"`
	Session   string    `json:"session"`
	Target    string    `json:"target"`
}

func Mask(value string) string {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, "@")
	if len(parts) == 2 && len(parts[0]) > 0 && len(parts[1]) > 0 && len(value) <= 254 {
		return string([]rune(parts[0])[:1]) + "***@" + parts[1]
	}
	if value != "" {
		return "***"
	}
	return ""
}
func (s *Service) Blocked(ctx context.Context, ip, session string) (bool, error) {
	var blocked bool
	err := s.Store.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM auth_limits WHERE key=ANY($1::text[]) AND reset_at>now())`, []string{s.Auth.Fingerprint("block-ip", network(ip)), s.Auth.Fingerprint("block-session", session)}).Scan(&blocked)
	return blocked, err
}
func (s *Service) insert(ctx context.Context, e Event) error {
	e.ID = security.ID()
	e.Time = time.Now().UTC()
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	_, err = s.Store.DB.Exec(ctx, `INSERT INTO audit_events(id,actor_role,actor_id,action,target,detail) VALUES($1,$2,$3,$4,$5,$6)`, e.ID, e.Role, e.Session, "security-"+e.Kind, e.Target, raw)
	return err
}
func (s *Service) Record(ctx context.Context, e Event, suspicious bool) error {
	if suspicious {
		for _, dimension := range []struct{ scope, value string }{{"ip", network(e.IP)}, {"session", e.Session}} {
			if dimension.value == "" {
				continue
			}
			err := s.Auth.Limit(ctx, "security-fail:"+dimension.scope+":"+dimension.value, 20, 300)
			if err != nil && fault.Status(err) != 429 {
				return err
			}
			if fault.Status(err) == 429 {
				result, err := s.Store.DB.Exec(ctx, `INSERT INTO auth_limits(key,attempts,reset_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=1,reset_at=excluded.reset_at WHERE auth_limits.reset_at<=now()`, s.Auth.Fingerprint("block-"+dimension.scope, dimension.value))
				if err != nil {
					return err
				}
				if result.RowsAffected() > 0 {
					b := e
					b.Kind = "block"
					if err = s.insert(ctx, b); err != nil {
						return err
					}
				}
			}
		}
	}
	// Record every sensitive mutation up to a bounded per-source budget; sample reads.
	max := 60
	if e.Method == "GET" && e.Status < 400 {
		max = 3
	}
	if err := s.Auth.Limit(ctx, "security-log:"+e.IP+":"+e.Route, max, 60); err != nil {
		if fault.Status(err) == 429 {
			return nil
		}
		return err
	}
	e.Kind = "request"
	return s.insert(ctx, e)
}
func (s *Service) Recent(ctx context.Context) ([]Event, error) {
	rows, err := s.Store.DB.Query(ctx, `SELECT detail FROM audit_events WHERE created_at>now()-interval '7 days' AND action IN ('security-request','security-block') ORDER BY created_at DESC,id DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var raw []byte
		var e Event
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Closed 15-minute windows produce one immutable message each. Drafts and receipts
// share the append-only audit ledger; Resend idempotency covers crash-after-send.
// Retries stop well before the provider's 24-hour idempotency retention expires.
func (s *Service) Alerts(ctx context.Context) error {
	if s.Sender == nil || s.Recipient == "" {
		return nil
	}
	end := time.Now().UTC().Truncate(15 * time.Minute)
	for start := end.Add(-2 * time.Hour); start.Before(end); start = start.Add(15 * time.Minute) {
		if err := s.alertWindow(ctx, start); err != nil {
			return err
		}
	}
	return nil
}
func (s *Service) alertWindow(ctx context.Context, start time.Time) error {
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(903498)`).Scan(&locked); err != nil || !locked {
		return err
	}
	id := "security-alert:" + start.Format("20060102T1504")
	var sent bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM audit_events WHERE id=$1)`, id+":sent").Scan(&sent); err != nil || sent {
		return err
	}
	var count int
	var ips string
	err = tx.QueryRow(ctx, `SELECT count(*),coalesce(string_agg(DISTINCT detail->>'ip',', '),'') FROM audit_events WHERE action='security-block' AND created_at>=$1 AND created_at<$2`, start, start.Add(15*time.Minute)).Scan(&count, &ips)
	if err != nil || count == 0 {
		return err
	}
	if len(ips) > 1500 {
		ips = ips[:1500] + "…"
	}
	body := fmt.Sprintf("%s 至 %s（UTC）触发 %d 次短时安全限制。来源 IP：%s。限制持续 15 分钟，支付回调不受影响。详情请登录管理后台的安全审计。", start.Format(time.RFC3339), start.Add(15*time.Minute).Format(time.RFC3339), count, ips)
	frozen, err := s.Sender.Freeze(s.Recipient, mailer.Message{Subject: "硅基生物 异常访问告警", Text: body, HTML: "<p>" + html.EscapeString(body) + "</p>"})
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(map[string]string{"payload": frozen})
	_, err = tx.Exec(ctx, `INSERT INTO audit_events(id,actor_role,actor_id,action,target,detail) VALUES($1,'system','security','security-alert-draft','',$2) ON CONFLICT(id) DO NOTHING`, id, raw)
	if err != nil {
		return err
	}
	if err = tx.QueryRow(ctx, `SELECT detail->>'payload' FROM audit_events WHERE id=$1`, id).Scan(&frozen); err != nil {
		return err
	}
	// Commit the immutable payload before contacting the external mail service.
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if _, err = s.Sender.SendFrozen(ctx, frozen, id); err != nil {
		return err
	}
	_, err = s.Store.DB.Exec(ctx, `INSERT INTO audit_events(id,actor_role,actor_id,action,target,detail) VALUES($1,'system','security','security-alert-sent','', '{}'::jsonb) ON CONFLICT(id) DO NOTHING`, id+":sent")
	return err
}

func network(raw string) string {
	ip, e := netip.ParseAddr(raw)
	if e != nil {
		return "unknown"
	}
	ip = ip.Unmap()
	if ip.Is6() {
		return netip.PrefixFrom(ip, 64).Masked().String()
	}
	return ip.String()
}
