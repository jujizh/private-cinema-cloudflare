// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Open-source snapshot prepared 2026-10-29; see CHANGELOG.md.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CinemaAudio {
  public sealed class Track {
    public int Index, Channels; public string Codec, Language, Profile; public bool IsDefault;
    public override string ToString() { return string.Format("音轨 {0}  |  {1}  |  {2} 声道  |  {3}{4}", Index, Codec, Channels, Language, IsDefault ? "（默认）" : ""); }
  }
  public sealed class Media {
    public string Path, VideoCodec; public int VideoIndex, Width, Height; public double Duration; public List<Track> Audio = new List<Track>();
  }
  public sealed class Outcome { public string Output; public double Seconds; public bool Reused; }
  public static class Engine {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    public static string Quote(string value) {
      var b = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') b.Append('\\', slashes * 2 + 1).Append('"');
        else b.Append('\\', slashes).Append(c);
        slashes = 0;
      }
      return b.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static ProcessStartInfo StartInfo(string exe, IEnumerable<string> args) {
      return new ProcessStartInfo(exe, string.Join(" ", args.Select(Quote))) { UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
    }
    public static string FindTool(string name, string folder) {
      var candidates = new List<string>();
      if (!string.IsNullOrEmpty(folder)) candidates.Add(System.IO.Path.Combine(folder, name));
      candidates.Add(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, name));
      candidates.Add(System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Links", name));
      foreach (string item in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
        try { candidates.Add(System.IO.Path.Combine(item.Trim().Trim('"'), name)); } catch { }
      }
      return candidates.FirstOrDefault(File.Exists);
    }
    static Dictionary<string, object> Dict(object item) { return item as Dictionary<string, object> ?? new Dictionary<string, object>(); }
    static string Text(Dictionary<string, object> item, string key, string fallback = "") { object value; return item.TryGetValue(key, out value) ? System.Convert.ToString(value, CultureInfo.InvariantCulture) : fallback; }
    static int Number(Dictionary<string, object> item, string key) { int value; return int.TryParse(Text(item, key), out value) ? value : 0; }
    public static Media Probe(string tool, string file) {
      if (string.IsNullOrEmpty(tool)) throw new InvalidOperationException("未找到 ffprobe.exe。请把 FFmpeg 的 bin 文件夹加入 PATH，或使用“设置 FFmpeg”。");
      using (var p = Process.Start(StartInfo(tool, new[] { "-v", "error", "-show_streams", "-show_format", "-of", "json", file }))) {
        Task<string> stdout = p.StandardOutput.ReadToEndAsync(), stderr = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(30000)) { p.Kill(); throw new IOException("读取媒体信息超时，请检查磁盘或文件。"); }
        string body = stdout.GetAwaiter().GetResult(), error = stderr.GetAwaiter().GetResult();
        if (p.ExitCode != 0) throw new IOException("无法读取文件：" + error.Substring(0, Math.Min(error.Length, 600)));
        var root = Json.DeserializeObject(body) as Dictionary<string, object>;
        if (root == null || !root.ContainsKey("streams")) throw new IOException("媒体信息不完整。");
        var media = new Media { Path = System.IO.Path.GetFullPath(file) };
        double duration; double.TryParse(Text(Dict(root["format"]), "duration"), NumberStyles.Float, CultureInfo.InvariantCulture, out duration); media.Duration = duration;
        foreach (object raw in (object[])root["streams"]) {
          var stream = Dict(raw); var tags = Dict(stream.ContainsKey("tags") ? stream["tags"] : null);
          var disposition = Dict(stream.ContainsKey("disposition") ? stream["disposition"] : null);
          if (Text(stream, "codec_type") == "video" && Number(disposition, "attached_pic") != 1 && media.VideoCodec == null) {
            media.VideoIndex = Number(stream, "index"); media.VideoCodec = Text(stream, "codec_name"); media.Width = Number(stream, "width"); media.Height = Number(stream, "height");
          }
          if (Text(stream, "codec_type") == "audio") media.Audio.Add(new Track { Index = Number(stream, "index"), Codec = Text(stream, "codec_name"),
            Profile = Text(stream, "profile"), Channels = Number(stream, "channels"), Language = Text(tags, "language", "und"), IsDefault = Number(disposition, "default") == 1 });
        }
        return media;
      }
    }
    static string Fingerprint(Media media, Track audio) {
      var info = new FileInfo(media.Path);
      string text = media.Path.ToUpperInvariant() + "|" + info.Length + "|" + info.LastWriteTimeUtc.Ticks + "|" + audio.Index + "|copy-video-aac192-stereo-v1";
      using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "");
    }
    static bool CanReuse(string output, string key) {
      try {
        var record = Dict(Json.DeserializeObject(File.ReadAllText(output + ".cinema-audio.json", Encoding.UTF8)));
        var info = new FileInfo(output);
        return info.Exists && Text(record, "key") == key && Text(record, "size") == info.Length.ToString(CultureInfo.InvariantCulture)
          && Text(record, "modified") == info.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture);
      } catch { return false; }
    }
    public static async Task<Outcome> Convert(Media media, Track audio, string output, string ffmpeg, string ffprobe,
        Action<double, string> progress, Action<Process> started, Func<bool> cancelled, int testSeconds = 0) {
      if (string.IsNullOrEmpty(ffmpeg)) throw new InvalidOperationException("未找到 ffmpeg.exe，请先设置 FFmpeg。");
      bool audioOnly = output.EndsWith(".m4a", StringComparison.OrdinalIgnoreCase);
      if (!audioOnly && media.VideoCodec != "h264") throw new InvalidOperationException("MP4 模式只处理 H.264 视频。");
      output = System.IO.Path.GetFullPath(output);
      if (string.Equals(output, media.Path, StringComparison.OrdinalIgnoreCase)) throw new IOException("输出路径不能是原片。");
      if (!audioOnly && !output.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase)) throw new IOException("请使用 .m4a 或 .mp4 扩展名。");
      if (!Directory.Exists(System.IO.Path.GetDirectoryName(output))) throw new IOException("输出文件夹不存在。");
      string key = Fingerprint(media, audio) + (audioOnly ? "-audio-only-v1" : "-mp4");
      if (File.Exists(output)) {
        if (testSeconds == 0 && CanReuse(output, key)) return new Outcome { Output = output, Seconds = 0, Reused = true };
        throw new IOException("输出文件已存在且不能确认是同一份缓存，请更换输出文件名。不会覆盖现有文件。");
      }
      if (File.Exists(output + ".cinema-audio.json")) throw new IOException("同名缓存记录已存在，请更换输出文件名。");
      var sourceInfo = new FileInfo(media.Path); long sourceSize = sourceInfo.Length, sourceTime = sourceInfo.LastWriteTimeUtc.Ticks;
      var drive = new DriveInfo(System.IO.Path.GetPathRoot(output));
      long needed = audioOnly ? (long)(Math.Max(1, media.Duration) * 24000) + 128L * 1024 * 1024 : sourceSize + 256L * 1024 * 1024;
      if (drive.AvailableFreeSpace < needed) throw new IOException("输出磁盘可用空间不足。视频不重压，新文件仍可能需要数 GB 空间。");
      string temp = output + ".partial-" + Guid.NewGuid().ToString("N") + (audioOnly ? ".m4a" : ".mp4");
      var watch = Stopwatch.StartNew();
      var args = new List<string> { "-hide_banner", "-nostdin", "-n", "-loglevel", "warning", "-threads", "2", "-i", media.Path };
      if (testSeconds > 0) { args.Add("-t"); args.Add(testSeconds.ToString(CultureInfo.InvariantCulture)); }
      if (!audioOnly) args.AddRange(new[] { "-map", "0:" + media.VideoIndex, "-c:v", "copy" });
      else args.AddRange(new[] { "-vn", "-af", "aresample=async=1:first_pts=0" });
      args.AddRange(new[] { "-map", "0:" + audio.Index, "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-threads", "2",
        "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", temp });
      var errors = new Queue<string>(); object gate = new object(); double duration = testSeconds > 0 ? testSeconds : media.Duration;
      try {
        using (var p = new Process { StartInfo = StartInfo(ffmpeg, args) }) {
          p.OutputDataReceived += (s, e) => {
            if (e.Data == null) return;
            if (e.Data.StartsWith("out_time_us=")) {
              double us; if (double.TryParse(e.Data.Substring(12), NumberStyles.Float, CultureInfo.InvariantCulture, out us)) {
                double percent = duration > 0 ? Math.Min(99, Math.Max(0, us / 1000000 / duration * 100)) : 0;
                progress(percent, percent >= 99 ? "正在整理 MP4 索引并验证，请稍候…" : "正在读取原片并转换所选音频…");
              }
            }
          };
          p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (gate) { errors.Enqueue(e.Data.Substring(0, Math.Min(e.Data.Length, 1000))); while (errors.Count > 12) errors.Dequeue(); } };
          p.Start(); started(p);
          try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
          p.BeginOutputReadLine(); p.BeginErrorReadLine();
          await Task.Run(() => p.WaitForExit());
          if (cancelled()) throw new OperationCanceledException("已取消。");
          if (p.ExitCode != 0) { lock (gate) throw new IOException("转换失败：\r\n" + string.Join("\r\n", errors)); }
        }
        progress(99, "正在验证输出音轨、画面和时长…");
        Media result = await Task.Run(() => Probe(ffprobe, temp));
        double expectedDuration = testSeconds > 0 ? Math.Min(testSeconds, media.Duration) : media.Duration;
        string details = string.Format(CultureInfo.InvariantCulture, "视频={0} {1}x{2}; 音轨数={3}; 音频={4}; 声道={5}; 输入容器时长={6:0.000}; 输出时长={7:0.000}", result.VideoCodec ?? "无", result.Width, result.Height, result.Audio.Count, result.Audio.Count > 0 ? result.Audio[0].Codec : "无", result.Audio.Count > 0 ? result.Audio[0].Channels : 0, expectedDuration, result.Duration);
        if ((!audioOnly && (result.VideoCodec != "h264" || result.Width != media.Width || result.Height != media.Height)) || result.Audio.Count != 1 || result.Audio[0].Codec != "aac" || result.Audio[0].Channels != 2 || result.Duration <= 0 || (expectedDuration > 30 && Math.Abs(result.Duration - expectedDuration) > Math.Max(5, expectedDuration * 0.02))) throw new IOException("输出验证未通过：" + details);
        File.WriteAllText(output + ".verification.log", details + "\r\n容器时长可能包含字幕和封面，不再以其与音轨长度差超过两秒就直接拒绝。请核对实际音画同步。", Encoding.UTF8);
        if (cancelled()) throw new OperationCanceledException("已取消。");
        var current = new FileInfo(media.Path);
        if (current.Length != sourceSize || current.LastWriteTimeUtc.Ticks != sourceTime) throw new IOException("转换期间原片发生变化，请重新选择文件。");
        File.Move(temp, output);
        var written = new FileInfo(output);
        try { if (testSeconds == 0) File.WriteAllText(output + ".cinema-audio.json", Json.Serialize(new { key = key, size = written.Length.ToString(CultureInfo.InvariantCulture), modified = written.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) }), Encoding.UTF8); }
        catch { progress(100, "转换成功，但缓存记录未保存；请保留兼容版文件。"); }
        watch.Stop(); return new Outcome { Output = output, Seconds = watch.Elapsed.TotalSeconds };
      } catch (Exception error) {
        try { File.WriteAllText(output + ".error.log", error.ToString() + "\r\n" + string.Join("\r\n", errors), Encoding.UTF8); } catch { }
        throw;
      } finally {
        // Only this operation's random partial output is removed, never input.
        if (File.Exists(temp)) try { File.Delete(temp); } catch { }
      }
    }
  }

  public sealed class MainForm : Form {
    readonly Color Surface = Color.FromArgb(25, 28, 34), Muted = Color.FromArgb(166, 176, 190), Accent = Color.FromArgb(191, 160, 239);
    TextBox input, output; ComboBox tracks; Label info, status, time, tools; ProgressBar progress;
    Button choose, start, cancel, reveal, settings; Media media; string toolFolder = "", prepared;
    Process running; bool busy, cancellation; Stopwatch watch; System.Windows.Forms.Timer timer;
    readonly string config = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CinemaAudio", "settings.json");
    public MainForm() {
      Text = Branding.ProductTitle + " " + Branding.Version; ClientSize = new Size(860, 640); MinimumSize = new Size(780, 650); StartPosition = FormStartPosition.CenterScreen;
      BackColor = Color.FromArgb(16, 18, 24); ForeColor = Color.FromArgb(238, 240, 246); Font = new Font("Segoe UI", 10); AutoScaleMode = AutoScaleMode.Dpi;
      var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(28), ColumnCount = 1, RowCount = 13 };
      Controls.Add(layout);
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 35));
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 54)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 26)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
      layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
      layout.Controls.Add(new Label { Text = Branding.ProductTitle, AutoSize = true, Font = new Font("Segoe UI", 22, FontStyle.Bold) }, 0, 0);
      layout.Controls.Add(new Label { Text = "仅导出 AAC 音轨 · 不复制视频 · 全程在本机处理", AutoSize = true, ForeColor = Muted }, 0, 1);
      layout.Controls.Add(Caption("原片（只导出音轨，不复制视频）"), 0, 2);
      var fileRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Margin = Padding.Empty };
      fileRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); fileRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 125));
      input = Box(true); choose = Action("选择原片…"); fileRow.Controls.Add(input); fileRow.Controls.Add(choose); layout.Controls.Add(fileRow, 0, 3);
      info = new Label { Dock = DockStyle.Fill, Text = "请选择本地 MKV / MP4；工具只生成新文件，不会修改原片。", ForeColor = Muted, Padding = new Padding(0, 8, 0, 0) }; layout.Controls.Add(info, 0, 4);
      layout.Controls.Add(Caption("保留哪条音轨"), 0, 5);
      tracks = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, BackColor = Surface, ForeColor = ForeColor, AccessibleName = "选择音轨" }; layout.Controls.Add(tracks, 0, 6);
      layout.Controls.Add(Caption("输出音轨 M4A（配合网站原视频播放，不上传）"), 0, 7);
      output = Box(false); output.AccessibleName = "输出文件路径"; layout.Controls.Add(output, 0, 8);
      var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 12, 0, 0), WrapContents = false };
      start = Action("生成音轨", 145); start.BackColor = Accent; start.ForeColor = Color.FromArgb(22, 17, 30);
      cancel = Action("取消", 85); reveal = Action("打开输出文件夹", 155); settings = Action("设置 FFmpeg", 135);
      start.Enabled = false; cancel.Enabled = false; reveal.Enabled = false;
      actions.Controls.AddRange(new Control[] { start, cancel, reveal, settings }); layout.Controls.Add(actions, 0, 9);
      progress = new ProgressBar { Dock = DockStyle.Fill, Maximum = 1000, Style = ProgressBarStyle.Continuous }; layout.Controls.Add(progress, 0, 10);
      status = new Label { Dock = DockStyle.Fill, AutoEllipsis = true, Text = "等待选择文件" }; layout.Controls.Add(status, 0, 11);
      var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false };
      time = new Label { AutoSize = true, ForeColor = Muted, Text = "音频会转为双声道 AAC 192 kbps；内嵌字幕和封面不复制。" };
      tools = new Label { AutoSize = true, ForeColor = Muted };
      var help = new LinkLabel { Text = "打开使用教程", AutoSize = true, LinkColor = Accent, ActiveLinkColor = Color.White };
      footer.Controls.AddRange(new Control[] { time, tools, help }); layout.Controls.Add(footer, 0, 12);
      choose.Click += async (s, e) => { using (var dialog = new OpenFileDialog { Title = "选择需要准备音频的原片", Filter = "电影文件|*.mkv;*.mp4;*.m4v|所有文件|*.*" }) if (dialog.ShowDialog(this) == DialogResult.OK) await LoadMedia(dialog.FileName); };
      settings.Click += (s, e) => { using (var dialog = new FolderBrowserDialog { Description = "选择同时包含 ffmpeg.exe 和 ffprobe.exe 的 bin 文件夹" }) if (dialog.ShowDialog(this) == DialogResult.OK) {
        if (!File.Exists(System.IO.Path.Combine(dialog.SelectedPath, "ffmpeg.exe")) || !File.Exists(System.IO.Path.Combine(dialog.SelectedPath, "ffprobe.exe"))) { MessageBox.Show(this, "这个文件夹需要同时包含 ffmpeg.exe 和 ffprobe.exe。"); return; }
        toolFolder = dialog.SelectedPath; Directory.CreateDirectory(System.IO.Path.GetDirectoryName(config)); File.WriteAllText(config, new JavaScriptSerializer().Serialize(new { folder = toolFolder }), Encoding.UTF8); RefreshTools();
      } };
      start.Click += async (s, e) => await Prepare();
      cancel.Click += (s, e) => Cancel();
      reveal.Click += (s, e) => { if (!string.IsNullOrEmpty(prepared) && File.Exists(prepared)) Process.Start("explorer.exe", "/select," + Engine.Quote(prepared)); };
      help.LinkClicked += (s, e) => { string guide = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "guide.html"); if (File.Exists(guide)) Process.Start(guide); else MessageBox.Show(this, "请将 guide.html 与程序放在同一个文件夹。"); };
      FormClosing += (s, e) => {
        if (busy) { e.Cancel = true; if (MessageBox.Show(this, "任务还在进行。要取消吗？原片不会受影响。", "取消任务", MessageBoxButtons.YesNo) == DialogResult.Yes) Cancel(); }
      };
      timer = new System.Windows.Forms.Timer { Interval = 500 }; timer.Tick += (s, e) => { if (busy && watch != null) time.Text = "已用时 " + watch.Elapsed.ToString(@"mm\:ss") + "；视频未重新编码。整理文件索引时进度可能暂留 99%。"; }; timer.Start();
      try { if (File.Exists(config)) toolFolder = Convert.ToString(((Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(File.ReadAllText(config)))["folder"]); } catch { }
      RefreshTools();
    }
    Label Caption(string text) { return new Label { Text = text, Dock = DockStyle.Fill, ForeColor = Muted }; }
    TextBox Box(bool readOnly) { return new TextBox { Dock = DockStyle.Fill, ReadOnly = readOnly, BackColor = Surface, ForeColor = ForeColor, BorderStyle = BorderStyle.FixedSingle }; }
    Button Action(string text, int width = 115) { return new Button { Text = text, Width = width, Height = 36, FlatStyle = FlatStyle.Flat, BackColor = Surface, ForeColor = ForeColor, Margin = new Padding(0, 0, 9, 0), UseVisualStyleBackColor = false }; }
    void RefreshTools() { tools.Text = Engine.FindTool("ffmpeg.exe", toolFolder) != null && Engine.FindTool("ffprobe.exe", toolFolder) != null ? "FFmpeg / ffprobe：已找到。无需管理员权限或后台服务。" : "未找到 FFmpeg，请点击“设置 FFmpeg”，详见教程。"; }
    void Busy(bool value) { busy = value; choose.Enabled = settings.Enabled = tracks.Enabled = output.Enabled = !value; cancel.Enabled = value && running != null; start.Enabled = !value && media != null && tracks.Items.Count > 0; }
    void Post(Action callback) { if (!IsDisposed && IsHandleCreated) try { BeginInvoke(callback); } catch { } }
    async Task LoadMedia(string path) {
      media = null; tracks.Items.Clear(); prepared = null; reveal.Enabled = false; input.Text = path; status.Text = "正在读取音轨信息…"; Busy(true);
      try {
        Media found = await Task.Run(() => Engine.Probe(Engine.FindTool("ffprobe.exe", toolFolder), path));
        media = found; foreach (Track track in media.Audio) tracks.Items.Add(track);
        if (tracks.Items.Count > 0) tracks.SelectedIndex = Math.Max(0, media.Audio.FindIndex(track => track.IsDefault));
        output.Text = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(path), System.IO.Path.GetFileNameWithoutExtension(path) + ".browser.m4a");
        info.Text = string.Format("{0} × {1} · {2} · {3:0.0} 分钟 · {4} 条音轨\r\n只保留所选音轨；视频不重压，原文件不改动。", media.Width, media.Height, media.VideoCodec, media.Duration / 60, media.Audio.Count);
        status.Text = media.Audio.Count == 0 ? "没有可选音轨；转换不能生成原本不存在的声音。" : "可以准备兼容版。只输出音轨，47 分钟通常约 65 MB。";
      } catch (Exception error) { status.Text = "检查失败"; MessageBox.Show(this, error.Message, "无法检查文件"); }
      finally { Busy(false); }
    }
    void Cancel() { cancellation = true; cancel.Enabled = false; status.Text = "正在取消并清理本次临时文件…"; if (running != null) try { if (!running.HasExited) running.Kill(); } catch { } }
    async Task Prepare() {
      if (media == null || !(tracks.SelectedItem is Track)) return;
      cancellation = false; prepared = null; reveal.Enabled = false; watch = Stopwatch.StartNew(); progress.Value = 0; Busy(true);
      try {
        var result = await Engine.Convert(media, (Track)tracks.SelectedItem, output.Text, Engine.FindTool("ffmpeg.exe", toolFolder), Engine.FindTool("ffprobe.exe", toolFolder),
          (percent, message) => Post(() => { progress.Value = Math.Max(0, Math.Min(1000, (int)(percent * 10))); status.Text = message; }),
          process => Post(() => { running = process; cancel.Enabled = true; }), () => cancellation);
        prepared = result.Output; progress.Value = 1000; reveal.Enabled = true;
        status.Text = result.Reused ? "已复用同一原片、同一音轨的兼容版，无需再次转换。" : "完成：AAC 立体声音轨已生成，原视频没有复制或修改。";
        time.Text = result.Reused ? "此次没有重新转换。请在网站先选原片，再加载这个 M4A 音轨。" : string.Format("本次用时 {0:0.0} 秒。请在网站加载原片及 M4A，核对声音后共享标签页音频。", result.Seconds);
      } catch (OperationCanceledException) { status.Text = "已取消，原片未修改。若存在 partial 临时文件，可手动删除。"; }
      catch (Exception error) { status.Text = "未生成正式兼容版"; MessageBox.Show(this, error.Message, "准备失败"); }
      finally { if (watch != null) watch.Stop(); running = null; Busy(false); }
    }
  }

  static class Program {
    [STAThread] static int Main(string[] args) {
      if (args.Length >= 3 && args[0] == "--smoke-test") {
        try {
          string ffmpeg = Engine.FindTool("ffmpeg.exe", null), ffprobe = Engine.FindTool("ffprobe.exe", null);
          Media media = Engine.Probe(ffprobe, args[1]);
          var result = Engine.Convert(media, media.Audio[0], args[2], ffmpeg, ffprobe, (p, m) => {}, p => {}, () => false, args.Length > 3 ? int.Parse(args[3]) : 0).GetAwaiter().GetResult();
          File.WriteAllText(args[2] + ".test-result.json", new JavaScriptSerializer().Serialize(result), Encoding.UTF8); return 0;
        } catch (Exception error) { File.WriteAllText(args[2] + ".test-error.txt", error.ToString(), Encoding.UTF8); return 1; }
      }
      if (args.Length == 1 && args[0] == "--argument-test") {
        return Engine.Quote("a b\\") == "\"a b\\\\\"" && Engine.Quote("a\"b") == "\"a\\\"b\"" ? 0 : 2;
      }
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new MainForm()); return 0;
    }
  }
}
