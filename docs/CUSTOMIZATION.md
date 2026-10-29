# 自定义站名、昵称与部署信息

## 推荐：部署后在 Host 页面修改

从 2.4.1 开始，不必修改源码：

1. 部署完整更新包，确认 `/api/config` 的 release 为 `2.4.1-host-settings-20261029`。
2. 打开自己的 `/host`，使用现有管理员密码登录。
3. 展开“站点设置”。首次尚未保存时会自动展开。
4. 填写站点名称、标语、默认主持人昵称及新房间默认标题；更多文案在高级折叠项中。
5. 点“保存设置”。当前页面即时更新，其他已打开页面刷新后读取新设置。

设置保存在现有 Directory Durable Object 的独立 siteSettings 记录，换浏览器也能读取，
不是只存本机 localStorage。读取与保存仍计入现有服务用量，但不新增服务/绑定/数据库。
只有管理员可保存/恢复，普通访客及房间主持人邀请不能修改全站设置。
所有文字是公开展示字段，不要填写秘密或不希望访客看到的个人信息。

默认主持人昵称在下次进入房间时生效；已有在线成员/已建房间不会被静默改名。
保存站名不会改变域名、Worker 资源名、密码或邀请签名。
恢复默认会清除这条设置记录，回到下面源码默认值，不删除房间、字幕或密钥。
源码默认值修改后，服务器已保存的设置优先；必要时先恢复默认再设置。
不支持 HTML 模板注入，显示按普通文本处理。

## 可选：维护源码默认值

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

2.4.1 不再让旧的本机主持人昵称覆盖全站默认昵称。若在线房间仍显示旧名字，
退出后重新进入；无需为此清除全部浏览器数据。观看者仍可在入房页填写自己的名字。

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
