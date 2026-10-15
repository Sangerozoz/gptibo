CREATE TABLE direct_media (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg')),
  base64 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE direct_site (
  id INTEGER PRIMARY KEY CHECK(id=1),
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  logo_media_id TEXT REFERENCES direct_media(id),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO direct_site(id,name_zh,name_en) VALUES (1,'硅基生物','MEGHAN');

CREATE TABLE direct_categories (
  id TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO direct_categories(id,name_zh,name_en,sort_order) VALUES
  ('ai','AI 订阅','AI subscriptions',0),
  ('learning','语言学习','Language learning',1),
  ('mail','邮箱账号','Email accounts',2),
  ('tool','工具服务','Tools',3);

CREATE TABLE direct_products (
  id TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  description_zh TEXT NOT NULL DEFAULT '',
  description_en TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL REFERENCES direct_categories(id),
  sort_order INTEGER NOT NULL,
  listed INTEGER NOT NULL DEFAULT 1 CHECK(listed IN (0,1)),
  image_media_id TEXT REFERENCES direct_media(id),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO direct_products(id,name_zh,name_en,description_zh,description_en,category_id,sort_order) VALUES
  ('chatgpt','ChatGPT','ChatGPT','自有账号充值 · Plus / Pro','Recharge your own account · Plus / Pro','ai',0),
  ('gemini','Gemini Pro','Gemini Pro','领取链接 · 邮件交付','Claim link · Delivered by email','ai',1),
  ('duolingo','多邻国','Duolingo','兑换 CDK · 邮件交付','Redeem a code · Delivered by email','learning',2),
  ('x-premium','X Premium','X Premium','3 / 6 个月 · 你的账号，继续精彩','3 / 6 months · For your own account','tool',3),
  ('gmail','Gmail 账号','Gmail accounts','带 2FA · 账号资料自动邮件交付','Includes 2FA · Account details by email','mail',4),
  ('claude','Claude','Claude','套餐待公布','Plans coming soon','ai',5),
  ('grok','Grok','Grok','套餐待公布','Plans coming soon','ai',6),
  ('codex-sms','Codex 接码','Codex SMS','按次服务','Pay per use','tool',7);
