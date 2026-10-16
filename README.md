# GPTibo

可自托管的商城前台、管理后台、代理工作台及主站后端。前端使用 React、TypeScript 和 Vite；主后端使用 Go、Gin 与 PostgreSQL，同时保留 Cloudflare Workers + D1 实现。

这是经过脱敏的独立开源版本，使用 MIT 许可证。上游供应商和聚合支付通道已匿名化，接入地址使用保留域名 `example.invalid`，商户身份、密钥、授权商品映射和生产部署资料不随源码提供。接口适配器保留为开发参考，需要自行实现或核对协议；**不是填入原商户密钥即可上线的生产副本**。支付宝官方公开协议示例保留，真实支付、采购及通知默认关闭。

## 包含内容

- 商品展示、订单查询、售后、邮件模板和多语言界面。
- 管理员及代理工作台、商品定价、订单、客户、退款和结算管理。
- Go API、业务 Worker、数据库迁移、鉴权、交易状态机及回归测试。
- Cloudflare Worker / D1 备用实现与本地开发配置。

不包含生产数据、生产配置、历史 Git 提交、运营截图、独立供货平台和内部运维工具。数据库结构、配置名和部分路由已匿名化：仅使用新建的开发数据库，不可直接升级已有生产库。示例金额和商品仅用于演示，不构成报价。

## 前端开发

需要 Node.js 22.18+（推荐 24）、npm 和 Python 3。

```sh
npm ci
npm run dev
npm run build
npm test
npm run lint
npm run security:scan
```

默认 Vite 地址为 `http://127.0.0.1:5173`，API 代理至本地 Worker 8787。接 Go 后端时改用：

```sh
npx vite --config services/storefront/vite.config.ts
```

此时前端在 `http://127.0.0.1:5175`，API 代理至 Go 的 8093 端口。管理员入口 `/admin`，代理入口 `/partner`。空库和未配置身份时，相关功能不可用。

## Go 后端

见 [后端运行说明](services/storefront/README.md)。需要 Go 1.26+ 和独立 PostgreSQL 数据库，或使用 Docker Compose。默认不启用邮件和任何真实交易渠道。

```sh
cd services/storefront
go test ./...
go vet ./...
```

未设置 `STOREFRONT_TEST_DATABASE_URL` 时，PostgreSQL 集成测试会跳过；完整验收必须设置本机、库名以 `_test` 结尾的专用数据库连接。

## Cloudflare 本地运行

```sh
npm run admin:setup
npx wrangler d1 migrations apply gptibo-local --local
npm run preview:worker
```

`admin:setup` 会询问管理员用户名、邮箱、已验证的 Resend 发件地址和 Resend API Key，生成独立的验证器密钥并给出导入地址。将地址导入验证器后保存好；之后从 `/admin` 使用邮箱验证码和验证器验证码登录。现有 `.dev.vars` 中其他配置及有效的验证器密钥会保留，重复运行不会让原验证器失效。该文件只保存在本机，不会通过 Git 传到另一台电脑；在另一台电脑启动时要重新配置，或者通过可信的私密渠道转移已有 `.dev.vars`。不要把密钥提交到仓库。Resend 发件地址需要先在自己的账号中完成验证，脚本不会创建邮件服务账号。

若前端地址是 `http://127.0.0.1:5173/admin`，它的 `/api` 请求由 Vite 转发至本机 `127.0.0.1:8787` 的 Worker。配置 `.dev.vars` 后必须重启 Worker，再在登录页点击“已配置，重新检查”；仅启动或重启 Vite 不会加载新配置。没有 Resend 凭据时无法完成当前管理员登录。

只在本机预览后台时，可以在 `.dev.vars` 设置 `ADMIN_DEV_BYPASS="true"`、`ORDER_TESTING_ENABLED="true"`，并把 `PUBLIC_SITE_ORIGIN` 设为 `http://127.0.0.1:5173`，然后重启 Worker。此时打开 `/admin` 会直接进入工作台，页面会标明本地开发模式；无需邮件或验证器。这个开关只接受本机 HTTP 地址，关闭开关并重启后恢复正常登录。不要在公开部署的环境中配置它。

想同时使用 Vite 热更新时，在另一个终端运行 `npm run dev`；保持上面的 `npm run preview:worker` 继续运行。

### 直营商店管理（Worker / D1）

应用迁移 `0044_direct_store.sql` 和 `0046_plan_display_label.sql` 后，管理员可在 `/admin` 的“店铺设置”修改中英文店名和 Logo，在“分类管理”新增、改名、排序及停用分类，在“商品管理”编辑现有商品的中英文名称、简介、分类、图片、排序和上下架，并在展开的套餐表格中修改售价、上架状态和前台标签。英文内容留空时前台显示中文；停用分类不影响商品在“全部商品”中的展示；下架商品拒绝新订单，历史订单保留。

`PARTNER_MODE_ENABLED=false` 暂停代理登录、代理商店及新代理开通，同时隐藏后台代理入口。代理表和既有逻辑保留；将该变量设为 `true` 后可恢复。当前 `wrangler.jsonc` 的本地默认值是 `false`。

发送邮件时，直营邮件从数据库读取当前中文店名和 Logo。本机预览邮件会用文字标识代替无法从邮箱加载的本地图片。`PUBLIC_SITE_ORIGIN` 必须在对外发送邮件前设置为公开可访问的 HTTPS 站点地址，否则邮件中的返回按钮无法供其他设备访问；发件邮箱仍由 `RESEND_FROM` 控制。已有发货草稿保存的是创建当时的邮件快照，不会追溯修改。

本期直营管理接口只在 Worker / D1 实现。若以后改用 Go / PostgreSQL 部署，需要先在 Go 后端实现同一套迁移、管理接口、前台目录读取和下架拦截，再进行生产切换。

### 5SIM 接码接口（Worker / D1）

Worker 服务端已封装 5SIM 的账户余额、价格、激活号码购买、订单查询、完成和取消接口。将 5SIM protocol key 作为私密变量 `FIVESIM_API_TOKEN` 配置在本机 `.dev.vars` 或部署环境的 Worker secret 中；不要放入前端变量。管理员在“服务接入”可手动检测连接，检测只读取账户余额，不会采购号码。

本阶段没有把 5SIM 接到 Codex 接码商品订单，也没有开放自动购号或上架。配置密钥不会自动开启销售；商品、订单与财务状态的对接需另行实施。Go / PostgreSQL 后端尚无对应 5SIM 接口。

仓库没有一键生产部署命令。`wrangler.jsonc` 不绑定任何生产账号/域名，数据库 ID 是全零占位值。若自行部署，先创建自己的资源、注入独立秘密、完成迁移并验证隔离和交易流程。

## 接入与安全

- `recharge`：匿名充值适配器。
- `account_supplier`、`delivery_supplier`：匿名采购适配器。
- `gatewaya`、`gatewayb`：匿名聚合支付协议示例。
- `xgift`：商城侧赠送接口适配器，不包含供应商执行系统。

所有回调、金额、签名、商户归属和幂等校验仍然保留。匿名地址和演示映射不对应可用服务；需要按自己的服务重新适配。前端变量不得存放服务器秘密。

发布检查及报告见 [SECURITY.md](SECURITY.md) 和 [OPEN_SOURCE_REVIEW.md](OPEN_SOURCE_REVIEW.md)。第三方图标、字体和样式遵循各自许可证；MIT 授权不转授第三方商标和美术作品权利，详见 `public/brands/` 和 `src/styles/vendor/`。
