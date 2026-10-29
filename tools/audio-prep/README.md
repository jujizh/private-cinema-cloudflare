# Audio Prep · 本地音轨准备工具

Windows Forms C# 源码，Apache-2.0。独立调用用户安装的 FFmpeg/ffprobe，
不附带 FFmpeg，不安装后台服务、不上传电影。图形界面默认输出 AAC M4A；
内部 Engine 也保留 H.264 视频复制到 MP4 的能力，网页推荐使用 M4A。

## 从源码构建

Windows 10/11，使用系统 .NET Framework 4.x C# 编译器和 Forms 运行时。
最简单可双击本目录 `build.cmd`（先审查脚本内容），不需更改 PowerShell 执行策略。
在仓库根目录用 PowerShell 执行：

```powershell
powershell -NoProfile -File tools/audio-prep/build.ps1
```

输出 `tools/audio-prep/bin/AudioPrep.exe` 及 guide.html、许可/声明。
该目录不会进入 Git，也不含 ffmpeg.exe。若系统没有 .NET Framework 编译器，
安装受信任的 Microsoft .NET Framework Developer Pack，或使用相应 Windows 构建环境；
这里不是依赖 Node 运行的桌面包装器。
若系统执行策略阻止脚本，先阅读脚本并按自己的组织策略批准，不建议全局降低安全策略。

运行 AudioPrep.exe 后选择原片，在“设置 FFmpeg”选择 bin，选择需要的音轨及输出位置，
点“生成音轨”。完成后在网站加载原视频和 M4A。详见 [完整音频教程](../../docs/AUDIO.md)。

## 自定义与测试

可见工具名：src/Branding.cs；业务逻辑及参数引号转义：src/CinemaAudio.cs。
本项目改动记录见根目录 CHANGELOG.md。保留 LICENSE/NOTICE 并说明你的修改。

构建后运行 `AudioPrep.exe --argument-test` 验证 Windows 参数转义。
可选合成媒体测试：在仓库根目录运行
`powershell -NoProfile -File tools/audio-prep/test.ps1`，只生成本机测试画面及正弦波，
验证 AAC 输出、不修改输入和拒绝覆盖，不读取用户影片。

工具未签名，下载的二进制可能被 SmartScreen 提醒。不要教用户一律绕过安全拦截；
推荐审查源码、自行构建，并通过发布页 SHA-256 校验来源。构建不是安全审计的替代。

错误日志可能含本地路径，不要未经脱敏直接公开。原片保存路径只在本机使用。
