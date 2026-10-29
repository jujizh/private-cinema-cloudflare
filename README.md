# Private Cinema · 私人影院

可自行部署的邀请制一起看电影工具。网站、切路与诊断逻辑、房间字幕库、
本地音轨兼容工具及部署文档全部开源，采用 [Apache-2.0](LICENSE)。
允许修改、部署及商用，须遵守许可并自行处理内容授权、隐私及云账单。

**发行版本：2.4.1 / `2.4.1-host-settings-20261029`。**
部署成功后，进入 `/host` 登录，在“站点设置”修改站名、标语、默认主持人昵称等。
设置保存在现有 Directory Durable Object，保存后立即应用于当前页面，其他页面刷新生效。
无需改源码或重新部署；密码、密钥、域名和 Worker 名称不在这个面板中设置。
升级步骤见 [2.4.1 更新说明](docs/UPGRADE-2.4.1.md)。
以此前 2.3.11 功能为基础去个人化，并补充可配置品牌、源码构建及公开文档。
这不是跨国网络稳定性的保证，也不是 Cloudflare 官方产品。

## 包含什么

- Workers + SQLite Durable Objects：房间、权限、邀请、WebSocket 信令。
- 主持人向少量观看者 P2P 扇出；打洞失败可经 TURN，SFU 保留热备/分发能力。
- 先准备新媒体再切路、周期性 P2P 重试、冻结检测及恢复、重连宽限期。
- 分辨率、帧率、码率、区间丢包、RTT、可用带宽及路由状态诊断。
- 独立本地电影源标签页，减少窗口采集对 Windows 图形链路的依赖。
- SRT/VTT Room Caption Library：主持人上传，所有人独立选择语言、大小、偏移。
- 本地播放器暂停、跳转、倍速同步字幕时钟；外部网站仍需手动同步。
- 本地 MKV 音频元数据检查、兼容性提示、外置 M4A 与画面联动。
- Windows 音轨工具完整 C# 源码：DTS 等转 AAC，不改原片、不复制视频。
- 合成媒体测试、公开发行扫描、CI、部署/自定义/排错/费用文档。

不包含：电影下载/存储、云浏览器、DRM 绕过、自动语音识别/翻译服务、
字幕搜索站抓取器、全格式浏览器 MKV 解码、绝不掉线承诺或到额自动停机。

## 从这里开始

1. 阅读 [部署教程](DEPLOY.md)，Fork/新建仓库并部署到你自己的 Cloudflare。
2. 登录 `/host`，在“站点设置”修改站名、标语、默认主持人昵称等。
   [品牌配置](public/site-config.js) 现在作为未设置/离线时的源码默认值。
3. 打开 `https://你的站点/host` 登录，建房并发送私密邀请。
4. 本地电影点 **Open local video**；在新标签页选原片，再点房间内
   **Share local player**，选择该 Chrome 标签页并勾选音频。
5. 若源标签页无声，先按 [音轨教程](docs/AUDIO.md) 生成 AAC M4A，
   播放器加载原视频及 M4A；字幕仍以视频时间为基准。

推荐桌面 Chrome/Edge 作为主持人；观看端能力依设备/浏览器和网络而异。
`workers.dev` 可作为无需购买域名的入口，但并不保证所有地区可直接访问。

## 免费额度下能看多少

2026-10-29 核对官方文档：Realtime SFU 与 TURN **合计每月前 1,000 GB 出站免费**，
超出为 $0.05/GB。Workers、Durable Objects、构建及其他服务另计。
这意味着“小规模有机会 $0”，不是不限量零成本。[官方定价](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)

下表按**每部 2 小时、1 名远端观众、所有视频经 SFU**估计，只计算视频有效载荷：

| 每月电影数 | 观影时长 | 3 Mbps | 5 Mbps |
| --- | ---: | ---: | ---: |
| 8 部（约每周 2 部） | 16 小时 | 21.6 GB | 36 GB |
| 16 部 | 32 小时 | 43.2 GB | 72 GB |
| 30 部（每天 1 部） | 60 小时 | 81 GB | 135 GB |
| 60 部 | 120 小时 | 162 GB | 270 GB |

2 名远端观众约乘 2，3 名约乘 3；主持人只发不收时不计为该表中的观众。
音频、重传、冗余、额外 TURN 路径和并行热备会增加实际用量；显示 P2P 也未必
没有 SFU 热备流量。不能仅按表格判断账单。[完整算法及预算边界](docs/COSTS.md)。

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 本地部署 / GitHub 自动部署 / 配置六项密钥 | [DEPLOY.md](DEPLOY.md) |
| 标题、昵称、域名、工具品牌自定义 | [CUSTOMIZATION.md](docs/CUSTOMIZATION.md) |
| P2P / TURN / SFU 和热备的真实行为 | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 免费额度、观影流量、超额风险 | [COSTS.md](docs/COSTS.md) |
| 音轨转换、工具构建、无声排错 | [AUDIO.md](docs/AUDIO.md) |
| 多语言字幕、暂停和中途开始 | [SUBTITLES.md](docs/SUBTITLES.md) |
| 黑屏、卡顿、无法入房、构建卡初始化 | [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| 个人数据、P2P 地址与字幕存储 | [PRIVACY.md](docs/PRIVACY.md) |
| 安全报告与部署安全 | [SECURITY.md](SECURITY.md) |
| 测试范围及未验证项目 | [TESTING.md](TESTING.md) |
| 贡献、提问、修改与重新发行 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 开源前检查、旧版本迁移与历史风险 | [PUBLISHING.md](docs/PUBLISHING.md) |
| 版权 / 免责声明 / 第三方声明 | [COPYRIGHT.md](COPYRIGHT.md) · [DISCLAIMER.md](DISCLAIMER.md) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

## 源码结构

```text
public/                   浏览器页面、播放器、媒体路由、字幕、品牌配置
src/                      Worker API、Durable Objects、签名与云媒体 API
test/                     Node 测试（包括原有连接/路由/字幕回归）
tools/audio-prep/         Windows 音轨工具源码、构建脚本与教程
scripts/                  公开发行扫描、本地浏览器测试及安全打包
examples/subtitles/       项目自写的英/中/俄极短示例，不是影片字幕
docs/                     自部署、自定义、成本、架构与排错
.github/workflows/        仅检查，不带自动发布或生产部署
```

## 开发与验证

需要 Node.js 22+（建议当前受支持 LTS）。

```sh
npm ci
npm run check
npm run check:public
npx wrangler deploy --dry-run
```

真实本地浏览器集成测试为可选项：`npx playwright install chromium` 后
`npm run test:browser`。只生成合成媒体、访问 localhost，不用真实影片/云凭据。
音轨工具在 Windows 上按 `tools/audio-prep/README.md` 自行构建。

原理、测试通过与真实跨国长期可用是不同的证据。参见 TESTING.md，
不要将本仓库描述为已证明支持任意人数、任意国家或任意网络的生产 SLA。

## 版权及使用责任

Copyright 2026 Private Cinema contributors. Apache-2.0。
软件许可不授予影片、字幕、商标或所有编解码器专利的权利；
不允许据此声称“作者保证任何用途合法”。使用前阅读 DISCLAIMER.md。
