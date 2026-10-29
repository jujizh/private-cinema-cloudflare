# 参与开发

欢迎修 Bug、补测试、改善跨平台体验和文档。提交前确认贡献是原创或有权按 Apache-2.0
提交，保留第三方归属；不要提交电影、实际影片字幕、真实用户日志或凭据。
故意提交的贡献适用 LICENSE 第 5 条；没有额外强制转让版权的 CLA。

先用 Issue 描述现象与版本，提供合成媒体的最小复现。安全问题走 SECURITY.md 私密渠道。
涉及编码参数、媒体切路、时钟/重连的修改应附测试及实测边界，不把“本机通过”写成全球保证。

```sh
npm ci
npm run check
npm run check:public
npx wrangler deploy --dry-run
```

可选 `npx playwright install chromium` 后 `npm run test:browser`；Windows 工具按其 README
构建并跑合成测试。CI 只检查不发布，PR 不应自动读取生产 secrets。
变更文件应说明改动，更新 CHANGELOG、测试和相关部署文档；依赖变更同步 lockfile。

重分发保留 LICENSE/NOTICE、适用第三方声明和修改说明；更名不是抹掉上游版权。
不要伪造官方 Cloudflare/FFmpeg 背书，不用刷账号规避计费，不引入违法内容来源。
