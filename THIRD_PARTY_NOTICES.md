# 第三方组件、服务及许可证

本项目的 Apache-2.0 不覆盖第三方组件。安装依赖时以锁定版本附带的 LICENSE /
NOTICE 为准；再次分发 node_modules 或二进制时须另行履行其许可义务。

| 组件 | 用途 | 许可/边界 |
| --- | --- | --- |
| Wrangler / workerd 及 Cloudflare 工具链 | 开发、打包、部署 | 依赖包各自的 Apache-2.0 / MIT / BSD 等，以 package-lock.json 及包内文本为准 |
| Playwright | 可选真实浏览器测试 | Apache-2.0；下载的浏览器另有各自第三方声明 |
| ws | 本地测试 WebSocket | MIT |
| Node.js | 本地运行构建/测试脚本 | Node.js 及随附组件自己的许可证 |
| .NET Framework / Windows Forms | 可选 Windows 音轨工具运行时 | Microsoft 的适用条款；未打包运行时 |
| FFmpeg / ffprobe | 用户安装的独立转换进程 | 通常 LGPL-2.1-or-later；启用 GPL 组件的构建受 GPL 约束，nonfree 构建可能不得分发 |
| Cloudflare Workers / Durable Objects / Realtime SFU / TURN | 托管服务 | Cloudflare 服务条款及收费规则，不是本仓库开源代码 |

## FFmpeg 分发说明

仓库与本地工具发行包均**不附带 FFmpeg/ffprobe 二进制或其源码拷贝**，
不将其伪称为 Apache-2.0。封装工具通过独立进程调用用户选择的可执行文件。
从 [FFmpeg 官方下载入口](https://ffmpeg.org/download.html) 选择可信构建，
检查该构建的许可、配置及来源。FFmpeg 原生 AAC 编码器与其他 AAC 实现的许可不同。

若你将 FFmpeg 与自己的发行包一起提供，应重新审查其具体构建、完整对应源码、
版权/许可证文本及再分发义务；不能简单沿用本项目的源码包说明。
参考 [FFmpeg License and Legal Considerations](https://ffmpeg.org/legal.html)。
编解码器/专利义务因地区、用途和组件而异，开源不等于所有专利已获授权。

## 不包括的材料

没有第三方电影、剧集、音轨、商业字幕、截图、个人日志、账号或密钥。
examples/subtitles 中的极短演示句为项目示例，不来自电影。
“Private Cinema” 为中性工作名称，不保证在任何地区完成商标检索或注册。
