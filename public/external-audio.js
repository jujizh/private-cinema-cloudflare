// Local sidecar audio. No server upload and no extra screen-capture pipeline.
export class ExternalAudio {
  constructor(video, audio, notify, url = URL) {
    this.video = video; this.audio = audio; this.notify = notify; this.url = url;
    this.active = false; this.held = false; this.resume = false; this.generation = 0;
    video.addEventListener('play', () => this.play());
    video.addEventListener('playing', () => this.play());
    video.addEventListener('pause', () => { if (!this.held) { this.resume = false; if (this.active) this.notify('外置音轨已随视频暂停。'); } audio.pause(); });
    video.addEventListener('ended', () => { this.resume = false; audio.pause(); });
    video.addEventListener('seeking', () => { if (this.active) { audio.pause(); this.align(); } });
    video.addEventListener('seeked', () => { if (this.active) { this.align(); if (!video.paused) this.play(); } });
    video.addEventListener('waiting', () => { if (this.active) audio.pause(); });
    video.addEventListener('ratechange', () => { if (this.active) audio.playbackRate = video.playbackRate; });
    video.addEventListener('volumechange', () => { if (this.active && !video.muted) video.muted = true; });
    audio.addEventListener('waiting', () => {
      if (!this.active || video.paused) return;
      this.held = true; this.resume = true; video.pause(); this.notify('外置音轨正在缓冲，已暂停画面等待。');
    });
    audio.addEventListener('canplay', () => {
      if (!this.active || !this.held) return;
      const resume = this.resume; this.held = false; this.resume = false;
      this.notify('外置音轨已就绪。');
      if (resume) video.play().catch(() => this.fail('请在播放器点击播放。'));
    });
    audio.addEventListener('error', () => { if (this.active) this.fail('外置音轨无法解码，请使用本地工具生成的 AAC .m4a。'); });
    audio.addEventListener('ended', () => {
      if (this.active && video.duration - video.currentTime > 0.5) this.fail('外置音轨已结束，画面已暂停。请确认音轨与这集视频匹配。');
    });
    this.timer = setInterval(() => this.correct(), 250);
  }
  load(file) {
    this.clear(); this.video.pause(); this.previousMuted = this.video.muted;
    this.active = true; this.video.muted = true; this.name = file.name;
    this.objectUrl = this.url.createObjectURL(file); this.audio.src = this.objectUrl; this.audio.load();
    this.notify(`已加载外置音轨：${file.name}。音量请使用“外置音量”；请先核对本地声音。`);
    const generation = this.generation;
    this.audio.addEventListener('loadedmetadata', () => {
      if (!this.active || generation !== this.generation) return;
      this.align();
      if (Number.isFinite(this.video.duration) && Math.abs(this.video.duration - this.audio.duration) > 2)
        this.notify('视频与外置音轨时长相差超过 2 秒，请确认是否为同一集/同一版本。');
    }, { once: true });
  }
  align() {
    if (!this.active || !Number.isFinite(this.audio.duration)) return;
    const target = this.video.currentTime;
    if (target > this.audio.duration + 0.3) { this.fail('所选位置超过音轨长度，请检查音轨版本。'); return; }
    if (Math.abs(this.audio.currentTime - target) > 0.025) this.audio.currentTime = Math.min(target, this.audio.duration);
    this.audio.playbackRate = this.video.playbackRate;
  }
  async play() {
    if (!this.active || this.video.paused || this.video.seeking || this.held) return;
    this.align(); if (this.video.paused) return; const generation = this.generation;
    try { await this.audio.play(); }
    catch (error) { if (this.active && generation === this.generation && error.name !== 'AbortError') this.fail('浏览器未允许音频播放，请在此源标签页点击播放后重试。'); }
  }
  correct() {
    if (!this.active || this.held || this.video.paused || this.video.seeking || this.audio.readyState < 2) return;
    const drift = this.audio.currentTime - this.video.currentTime;
    if (Math.abs(drift) > 0.2) this.align();
    else this.audio.playbackRate = Math.max(0.25, Math.min(4, this.video.playbackRate * (Math.abs(drift) > 0.04 ? (drift > 0 ? 0.97 : 1.03) : 1)));
    if (this.audio.paused) this.play();
  }
  fail(message) { this.held = false; this.resume = false; this.video.pause(); this.audio.pause(); this.notify(message); }
  clear() {
    this.generation++; this.held = false; this.resume = false;
    const wasActive = this.active; this.active = false;
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    if (this.objectUrl) this.url.revokeObjectURL(this.objectUrl);
    this.objectUrl = ''; this.name = '';
    if (wasActive) this.video.muted = Boolean(this.previousMuted);
  }
  destroy() { this.clear(); clearInterval(this.timer); }
}
