# 2.3.9 音轨检查

本版在本地播放器读取 Matroska/MKV 元数据并提示 DTS、TrueHD、AC-3 等音轨的兼容性风险；不会因检测不到就断言无音轨。已实际识别用户片源 A_DTS，仅遇到风险时提示本地转换。其他容器暂不保证能识别编码。文件不上传，原片不修改。

网页不连接本地服务，也不运行转换。独立 Windows 工具和教程单独交付；需用户本机已有 FFmpeg 与 ffprobe。

部署完整包并核对 `/api/config` 的版本 `2.3.9`、release `2.3.11-caption-sync-20261029`。保留现有 Worker 名称、绑定、密钥和 Durable Object migrations；勿上传 node_modules、build-output 或测试媒体。
