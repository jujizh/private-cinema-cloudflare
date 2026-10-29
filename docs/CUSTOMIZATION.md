# 自定义站名、昵称与部署信息

## 一个配置文件修改主要展示字段

编辑 `public/site-config.js`，修改双引号内的值，保留 JavaScript 语法。例如：

```js
title: "星夜放映室",
tagline: "A private night, a shared screen.",
defaultHostName: "房主",
defaultRoomTitle: "今晚一起看",
guestPlaceholder: "请输入昵称",
invitePlaceholder: "给这个邀请起个备注",
```

可修改字段：title（页签及页头名称）、tagline（标语）、description（页面描述）、
eyebrow（首页小标题）、heroTitle/heroAccent（首页主标题两行）、introduction（介绍）、
defaultHostName（房主默认昵称）、defaultRoomTitle（新房间标题默认值）、
guestPlaceholder / invitePlaceholder（输入提示）、localPlayerTitle（本地播放器页签前缀）。

所有字段都是**公开文本，不要放密码、邮箱私钥、云 token 或 account ID**。
文字使用 textContent 更新，不作为 HTML 插入。需要给爬虫/禁用 JS 用户展示相同品牌时，
同时修改 `public/index.html` 的 title、meta description 和相应静态回退文案。

浏览器先前记住的昵称会优先于默认值：更改默认主持人名后，如果本机仍显示旧昵称，
可在本站控制台执行 `localStorage.removeItem("cinema.ownerName")` 后刷新。
这只清掉昵称，不清除邀请码/全部站点数据；不要让用户在陌生网站运行粘贴脚本。
观看者可在入房页直接填写自己的名字。

## 外观、图标及其他界面文案

主站样式 `public/styles.css`，源播放器样式 `public/player.css`；页头图标是本地 CSS
图形，不依赖外部图片或远程字体。可以替换为自己有权使用的标识。完整界面翻译仍需
编辑 index.html/player.html/app.js/player.js，当前没有完整 i18n 语言包。
改 UI 的 id 前同时更新绑定和测试；不要为了品牌更名改路由/权限逻辑。

## Worker 名称、域名、账号

- `wrangler.jsonc` 的 name 改部署资源名；它和品牌名称不同。
- 默认使用自己的 workers.dev HTTPS 子域，无作者 account_id 或固定域名。
- 自定义域名在 Cloudflare 中绑定你拥有的域名；不要复制他人的 routes/account_id。
- 已有部署不要随意改 Worker name，否则可能创建另一个站点，原房间不会自动迁移。
- token issuer 是内部协议标识 `private-cinema`，不是用户可见品牌，不要随站名改动。
  改它会让旧签名会话/邀请失效。

## 本地音轨工具

编辑 `tools/audio-prep/src/Branding.cs` 的 ProductTitle 和 Version，再按工具 README
构建。源码命名空间、内部配置目录 `CinemaAudio` 是技术组件标识，不是个人姓名。
可改可执行文件名，但教程链接文件 guide.html 应与 EXE 同目录。

品牌可自由更改；再分发仍须保留 LICENSE/NOTICE 等归属及第三方声明。
修改者应标明改动、保留上游许可。开源并不保证你选择的新站名没有商标冲突。
