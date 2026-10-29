# 完整部署教程（Cloudflare Workers）

适用于新部署。已有私有发行版迁移先读 [PUBLISHING.md](docs/PUBLISHING.md)。
本开源包不含作者的账号、域名、API 密钥、邀请码或电影。

## 0. 先了解免费条件

准备自己的 GitHub 及 Cloudflare 账号、Node.js 22+、支持屏幕共享的桌面浏览器。
需要 Workers、SQLite Durable Objects、Realtime **SFU** 及可选但强烈建议的 TURN。
不是按参与分钟收费的 RealtimeKit。无需买 VPS、对象存储或独立数据库。
默认使用 Cloudflare 提供的 workers.dev 子域；不需要买域名。
账号可用产品、验证/支付方式要求以 Cloudflare 控制台为准。

Workers Free 可用 SQLite Durable Objects，但有每日计算、请求、存储限制。
Realtime 有自己的共享免费额度，超额可能收费；参见 [COSTS.md](docs/COSTS.md)。

## 1. 准备干净的代码仓库

Fork 此仓库，或在 GitHub 新建仓库后上传本开源包**内部文件**至根目录。
根目录应直接有 package.json、package-lock.json、wrangler.jsonc、src、public。
不要套上版本目录，不上传 node_modules、.wrangler、影片、生成音轨或历史 ZIP。
test 目录须保留，`npm run check` 会运行它；测试不是网站公开资产。

命令行方式在你自己的仓库 clone 后进入仓库目录，再执行：

```sh
npm ci
npm run check
npm run check:public
```

`package.json` 的 `private: true` 只防 npm 误发布，不影响 GitHub 公开或 Apache 授权。

## 2. 修改部署名称与品牌

wrangler.jsonc 中 `name` 默认 `private-cinema`，可改为自己的 Worker 名（小写字母、
数字、连字符，不能是完整网址）。默认没有 account_id / routes，避免部署到别人的账号。
`workers_dev: true` 会提供 HTTPS 地址。不要改三个 Durable Object 绑定和已有迁移记录。
public/site-config.js 修改公开展示信息；详见 [CUSTOMIZATION.md](docs/CUSTOMIZATION.md)。

## 3. 在 Cloudflare 创建 SFU 和 TURN

在控制台找到 **Realtime → SFU**（菜单名称可能调整），创建自己的 SFU application，
记录应用 ID 及应用 secret。不要创建 RealtimeKit meeting 代替 SFU application。
再创建自己的 **TURN key**，记录 key ID 和对应 API token。
官方指南：[SFU 入门](https://developers.cloudflare.com/realtime/sfu/get-started/)、
[TURN 凭据](https://developers.cloudflare.com/realtime/turn/generate-credentials/)。

当前代码会先创建 SFU 媒体会话，并保留热备，因此**不能只配置 STUN/P2P 而省略 SFU**。
未配置 TURN 时仍有 STUN，但严格 NAT、代理或运营商环境中的直连成功率会下降。
临时 TURN 凭据由后端为已授权入房者获取，不把长期 token 发给浏览器。

## 4A. 推荐首次使用本地 Wrangler 部署

```sh
npx wrangler login
npx wrangler whoami
npx wrangler deploy --dry-run
npx wrangler deploy
```

确认登录的是自己的账号。第一次 deploy 会建立自己的 Worker / 绑定和静态资源。
配置密钥前站点显示“未配置”是预期现象。OAuth 页面过期时重新运行 login 获取新链接，
不要反复使用旧授权链接；不要把登录回调或令牌发到 Issue。

为自己的 Worker 逐个录入以下秘密（命令会交互读取内容，不把值写在命令里）：

```sh
npx wrangler secret put APP_AUTH_SECRET
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CF_REALTIME_APP_ID
npx wrangler secret put CF_REALTIME_APP_SECRET
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

| 名称 | 内容 |
| --- | --- |
| APP_AUTH_SECRET | 至少 32 字符的密码学随机密钥，签名管理员会话和邀请 |
| ADMIN_PASSWORD | 强、独立的管理员登录密码，不是默认昵称 |
| CF_REALTIME_APP_ID | 你创建的 SFU application ID |
| CF_REALTIME_APP_SECRET | 该 SFU application secret |
| TURN_KEY_ID | 你的 TURN key ID |
| TURN_KEY_API_TOKEN | 该 TURN key 的长期 API token |

可在本机用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
生成签名密钥，复制后妥善保存，不提交到 Git。不要用示例占位符作为密钥。
也可在 Worker 的 Settings → Variables and Secrets 中逐项添加为 **Secret**。
密钥变更可能创建新部署版本；完成后重新确认站点配置。

## 4B. GitHub → Cloudflare Builds 自动部署

在 Cloudflare Workers 中选择连接现有 Git 仓库（不是纯静态 Pages 上传），
选择生产分支，配置：

- 根目录：仓库根目录（界面可能显示 `/`）。
- 构建命令：`npm run check && npm run check:public`。
- 部署命令：`npx wrangler deploy`。
- Node：22 或以上受支持版本。
- 使用自己的构建授权 token，限定自己的账号及 Worker 权限。

完成一次部署后，按第 4A 节添加六项 Worker Secrets。Build token 是部署授权，
与 SFU/TURN 的运行时密钥不是同一件事。不要把运行时 secrets 当公开构建变量，
更不能放进 public/site-config.js。

若平台停在 `Initializing build environment` 且尚未 clone/install，代码和测试还未执行；
先看官方状态/队列，取消过时任务后重试。可用第 4A 节本地部署同一提交绕过 Builds，
部署目的地与运行环境仍然是同一个 Cloudflare Worker，不是把服务器搬到本机。
本仓库 CI 不会替你自动部署生产，避免 Fork 后触发意外发布。

## 5. 检查配置与首次观影

访问自己的 `/api/config`，应有 version `2.4.0`、release
`2.4.0-open-source-20261029`，ownerConfigured/realtimeConfigured 为 true；配置 TURN
后 turnConfigured 也应为 true。接口不返回密钥值。

打开 `/host` 用 ADMIN_PASSWORD 登录，创建房间，发送 viewer 邀请链接。
邀请过期、撤销、踢人、锁房均由后端检查。不要公开主持人邀请或管理员密码。
多位部署者应各用自己的账号与凭据，不能公用本项目维护者的免费额度。

主持人打开本地电影源标签页，加载原片/必要的外置音轨。回房间使用
Share local player → Chrome Tab → 选择该播放器 → 勾选共享音频。
上传自己有权使用的 SRT/VTT，双方各选语言，先测试暂停、跳转、音画和字幕。
再测试异地网络至少 30–60 分钟；同一 Wi-Fi 测试通过不能代替跨国验收。

## 6. 自定义域名、开发与维护

可在 Worker Domains & Routes 中添加你拥有的自定义域名；默认 workers.dev 已有 HTTPS。
域名、DNS、证书及区域可达性问题与 WebRTC 媒体路径分别排查，不保证国内或海外均可达。

本地开发：将 `.dev.vars.example` 复制为 `.dev.vars`，填入自己的值，执行 `npm run dev`。
开发数据位于本机 `.wrangler`，不是生产房间。完整 HTTPS、Secure Cookie、采集与云媒体
验收应使用自己的测试 Worker；dry-run 不会证明云端凭据有效或建立真实媒体会话。

更新前保留自己的配置及密钥，保留迁移历史，先跑所有检查、再部署、双方刷新并重开源页。
轮换 APP_AUTH_SECRET 会使已有邀请/会话失效，应发新邀请。房间删除是不可恢复操作，
先确认目标；源码回滚不等同于数据库回滚。不要删除生产 Durable Object namespace 来“修复构建”。

定期看 SFU+TURN 出站、Workers 请求与 DO 存储用量；额度提醒不是硬停机。
如果公开运营，需要补上自己的运营主体、联系渠道、隐私政策、内容投诉及滥用处理流程。
