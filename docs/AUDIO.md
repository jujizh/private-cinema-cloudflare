# 无声、MKV 与本地音轨准备

## 先排查，不要一律归因为版权

MKV 封装内可能有 H.264/HEVC、DTS/TrueHD/AAC 等不同组合。
无声也可能是静音、没勾选共享音频、选错音轨、浏览器/平台能力不同。
源标签页有声音而观众无声，优先排查标签页音频采集及观看端自动播放；
源标签页自己就无声，才重点检查音频解码、静音和原文件。
浏览器的风险提示不是穷尽支持列表，也不证明该文件一定无法播放。

## 推荐：只生成一条外置 AAC 音轨

工具源码与构建方法：[tools/audio-prep/README.md](../tools/audio-prep/README.md)。
Windows 图形工具可选原片、查看音轨/语言并选一条，输出 `.browser.m4a`。
默认 AAC、192 kbps、双声道；**只转音频，不复制或重压视频，不修改原片**。
复用缓存、取消、随机临时文件、输出验证及错误日志均在源码中。
它并不是把新音轨原地追加到巨大 MKV；容器重写不能保证安全地原地完成。

可从 [FFmpeg 官方入口](https://ffmpeg.org/download.html) 下载自己的 FFmpeg/ffprobe，
解压后在工具里“设置 FFmpeg”选择同时包含两个 EXE 的 bin 文件夹，或加入 PATH。
不必运行管理员服务；不要关闭杀毒软件或盲目信任陌生构建。
本项目不附带 FFmpeg，许可说明见 THIRD_PARTY_NOTICES.md。

## 网页中使用

1. 房间点 Open local video，从新源标签页选择原视频。
2. 源页点“加载本地音轨”，选择刚生成、同一集同一版本的 M4A。
3. 本地试听，音量使用“外置音量”；原 video 被静音，声音来自独立 audio 元素。
4. 回房间 Share local player，选择这个 Chrome 标签页并勾选音频。
5. 观看者按需要点击播放/取消静音以满足浏览器自动播放规则。
6. 用暂停、进度跳转验证音画与字幕。字幕不以音轨加载时间为零点。

音轨到末尾而视频未完会暂停并提示；时长差异可能是容器/封面/字幕轨，也可能是
剪辑版本不匹配，不能仅凭两秒差异定性成功/失败。以真实全片播放核对为准。
支持的音频不能修复不兼容的视频解码（例如特定浏览器不支持的 HEVC）。

## 不用图形工具的命令

查看流编号（以下均在本机运行）：

```sh
ffprobe -v error -show_streams -show_format -of json "movie.mkv"
ffmpeg -n -i "movie.mkv" -map 0:a:0 -vn -sn -dn -af aresample=async=1:first_pts=0 -c:a aac -b:a 192k -ac 2 -map_metadata -1 -map_chapters -1 -movflags +faststart "movie.browser.m4a"
```

`0:a:0` 是第一条音轨，可能不是你想听的语言；根据 ffprobe 更换选择。
`-n` 拒绝覆盖。不要把输入和输出路径设置为同一个文件。
需要独立兼容 MP4 且视频本身为 H.264 时，可仅复制视频再转音频：

```sh
ffmpeg -n -i "movie.mkv" -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k -ac 2 -sn -dn -map_metadata -1 -movflags +faststart "movie.browser.mp4"
```

MP4 会新增接近整部电影大小的磁盘文件；它不是内存占用。M4A 更省空间，
但依赖网页原视频与外置音轨同步。字幕/章节/其他音轨不会自动复制到这些输出。

## 准备时间和空间

192 kbps 音频约 86.4 MB/小时，2 小时约 172.8 MB，加少量封装开销。
所需时间取决于 CPU、原编码、磁盘和 FFmpeg，通常可以快于影片时长，
不承诺瞬时完成或沿用某台电脑的测量结果。正式工具转换完整音轨，完成后验证再发布输出。
不会提前下载在线播放网站的受保护音轨；没有本地原片时应使用自己有权获取的兼容媒体。

## 字幕提取不是本工具的已有 GUI 功能

已有 MKV 中的文本字幕可在本机用 FFmpeg 单独提取；例如
`ffmpeg -n -i "movie.mkv" -map 0:s:0 "movie.en.srt"`，仅适用于可转文本的字幕流。
PGS/VobSub 图形字幕需额外 OCR，ASS 样式转 SRT 会损失格式；工具并未集成 OCR。
先看流信息、确认语言与授权。用户自行安装的第三方字幕编辑/翻译软件也不被本项目许可覆盖。
