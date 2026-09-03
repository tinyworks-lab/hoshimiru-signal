/**
 * 効果音(SE)用とBGM用のバスを分けておくことで、
 * 将来BGMを追加してもそれぞれの音量を独立に制御できるようにする。
 */
// 予感音の連続を防ぐクールダウン（この時間内は2回目以降の予感音を鳴らさない。視覚演出は別）。
const PREMONITION_SOUND_COOLDOWN_MS = 1800;
// 受信音（ポーン）の直後この時間は、予感音を鳴らさない（重なり回避）。
const RECEIVE_TONE_GUARD_MS = 600;

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private seGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private muted = false;

  // 予感音（ごく短い微弱ノイズ）用。ノイズ素材は使い回す。
  private noiseBuffer: AudioBuffer | null = null;
  private activePremonitionEnv: GainNode | null = null;
  private lastPremonitionAt = 0;
  private lastReceiveToneAt = 0;

  /** ユーザー操作（ボタンクリック）のハンドラ内で呼ぶこと。 */
  unlock(): void {
    if (this.ctx) {
      // 長い待機（再送信までの8分19秒など）でブラウザが省電力のためAudioContextを
      // 自動的にsuspendしていることがある。ユーザー操作のタイミングで再開しておかないと、
      // 以降の受信音・送信音が(エラーなく)無音のまま鳴らなくなる。
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }

    this.ctx = new AudioContext();

    const masterGain = this.ctx.createGain();
    masterGain.gain.value = this.muted ? 0 : 1;
    masterGain.connect(this.ctx.destination);
    this.masterGain = masterGain;

    this.seGain = this.ctx.createGain();
    this.seGain.gain.value = 0.3; // 控えめな音量
    this.seGain.connect(masterGain);

    // v0.1ではBGMは未実装。将来ここにループ音源を接続する。
    // BGMもmasterGain経由なので、下のsetMuted()がそのままBGMにも効く。
    this.bgmGain = this.ctx.createGain();
    this.bgmGain.gain.value = 0;
    this.bgmGain.connect(masterGain);

    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this.createReverbImpulse(this.ctx, 3.6, 2.2);
  }

  /**
   * 送信音・受信音（将来のBGMも含む）をまとめてON/OFFするマスターミュート。
   * unlock()が呼ばれる前に呼んでも状態だけ保持し、unlock()時に反映される。
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.value = muted ? 0 : 1;
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** ホワイトノイズを指数的に減衰させただけの、簡易なリバーブ用インパルス応答を合成する。 */
  private createReverbImpulse(ctx: AudioContext, durationSeconds: number, decay: number): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSeconds);
    const impulse = ctx.createBuffer(2, length, sampleRate);

    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }

    return impulse;
  }

  /**
   * 「ピアノの鍵盤を1回だけ静かに叩いた」ことを思わせる単音を鳴らす。
   * 基音＋倍音を別々の音量・減衰速度で重ねることで打鍵の輪郭を作り、
   * 共有のConvolverNodeでドライ音にリバーブの余韻を混ぜる。
   * playPon()(受信・A#5)とplaySend()(送信・G#5)はどちらもこの処理を
   * 音程とdry/wetの音量バランスだけ変えて呼び出している。
   *
   * 将来、実際のピアノ単音サンプルに置き換える場合は、この関数の中身を
   * AudioBufferSourceNode の再生に差し替え、dryGain/convolverへの接続は
   * そのまま流用できる。
   */
  private playPianoTone(fundamentalHz: number, dryLevel: number, wetLevel: number): void {
    if (!this.ctx || !this.seGain || !this.convolver) return;
    // 予感音が鳴っている最中に受信/送信音が入ったら、予感音をすぐ絞る（ポーンが最優先）。
    this.duckPremonitionNoise();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 高次倍音のきつさを丸めるためのローパスフィルタ。基音・2倍音はほぼ素通しし、
    // 3・4倍音の刺さりだけを抑える。
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 3200;
    lowpass.Q.value = 0.7;

    const dryGain = ctx.createGain();
    dryGain.gain.value = dryLevel;

    const wetGain = ctx.createGain();
    wetGain.gain.value = wetLevel; // リバーブ成分を多めにし、余韻が空間に残る感覚を出す

    // 基音を中心に、倍音は次数が上がるほど弱く・短くしてピアノらしい輪郭を作る。
    const harmonics: Array<{ multiplier: number; peak: number; decay: number }> = [
      { multiplier: 1, peak: 0.5, decay: 1.5 },
      { multiplier: 2, peak: 0.16, decay: 1.0 },
      { multiplier: 3, peak: 0.06, decay: 0.6 },
      { multiplier: 4, peak: 0.02, decay: 0.4 },
    ];

    for (const harmonic of harmonics) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(fundamentalHz * harmonic.multiplier, now);

      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(harmonic.peak, now + 0.008); // 明瞭で短いアタック
      envelope.gain.exponentialRampToValueAtTime(0.0005, now + harmonic.decay);

      osc.connect(envelope);
      envelope.connect(lowpass);

      osc.start(now);
      osc.stop(now + harmonic.decay + 0.1);
    }

    lowpass.connect(dryGain);
    lowpass.connect(this.convolver);

    this.convolver.connect(wetGain);
    dryGain.connect(this.seGain);
    wetGain.connect(this.seGain);
  }

  /** 新しいuidから届いた「本当のホシミル信号」を受信したときの音。A#5・ロングトーン＋長いリバーブ。 */
  playPon(): void {
    this.lastReceiveToneAt = performance.now();
    this.playPianoTone(932.33, 0.2, 0.5); // A#5 / B♭5
  }

  /** 「信号ヲ送ル」を押した瞬間の送信音。G#5・受信音と同じロングトーン＋リバーブだが、音量は少し控えめ。 */
  playSend(): void {
    this.playPianoTone(830.61, 0.17, 0.42); // G#5 / A♭5
  }

  // 予感音用のホワイトノイズ素材（0.4秒）。一度だけ合成して使い回す。
  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = Math.floor(ctx.sampleRate * 0.4);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  // 鳴っている予感音があれば、ごく短時間で 0 へ絞る。
  private duckPremonitionNoise(): void {
    if (!this.ctx || !this.activePremonitionEnv) return;
    const t = this.ctx.currentTime;
    try {
      this.activePremonitionEnv.gain.cancelScheduledValues(t);
      this.activePremonitionEnv.gain.setTargetAtTime(0, t, 0.008);
    } catch {
      // 一部ブラウザで cancelScheduledValues が失敗しても致命的ではない
    }
    this.activePremonitionEnv = null;
  }

  /**
   * 「予感」（通りすがりの人が新しく接続した気配）のときに鳴らす、短く小さな乾いた二段ノイズ（ザザッ）。
   * 通知音ではなく「今、何か聞こえた？」程度。Web Audio でその場で合成する（音源ファイル不要）。
   *
   * 次の場合は何もしない（エラー・ダイアログ・案内は一切出さない）:
   *   - AudioContext がまだ unlock されていない（＝ユーザー操作前）
   *   - AudioContext が running でない
   *   - 直前に受信音（ポーン）が鳴った（重なり回避。ポーンが最優先）
   *   - クールダウン中（連続アクセスで鳴りっぱなしにしない。視覚の予感は別途出る）
   * ミュートは masterGain 経由で自動的に効く（seGain へ接続するため）。
   */
  playPremonitionNoise(): void {
    if (!this.ctx || !this.seGain) return;
    if (this.ctx.state !== 'running') return;

    const nowMs = performance.now();
    if (nowMs - this.lastReceiveToneAt < RECEIVE_TONE_GUARD_MS) return;
    if (nowMs - this.lastPremonitionAt < PREMONITION_SOUND_COOLDOWN_MS) return;
    this.lastPremonitionAt = nowMs;

    const ctx = this.ctx;
    const t = ctx.currentTime;

    // 予感ごとに、開始時だけ少しずつ変える（毎回同じSEに聞こえないように）。
    // ただしキャラクターは常に「ザザッ」系＝bandpass寄り・二段のノイズ。
    const bright = Math.random() < 0.28; // true のときだけ少し明るめ（highpass）
    const centerHz = bright ? 1300 + Math.random() * 1000 : 950 + Math.random() * 1900;
    const q = bright ? 0.7 : 1.6 + Math.random() * 2.4; // 高くしすぎない（ザラついた帯域感）
    const peak1 = 0.13 + Math.random() * 0.07; // 1つ目のピーク（0.13〜0.20。ポーンよりは小さいが気づける）
    const peak2 = peak1 * (0.6 + Math.random() * 0.2); // 2つ目は少し弱い
    const dipRatio = 0.3 + Math.random() * 0.12; // 2つのピークの谷（無音にはしない＝連続して聞こえる）

    const attack = 0.004 + Math.random() * 0.003; // 4〜7ms
    const gap = 0.022 + Math.random() * 0.028; // 2つのピーク間隔 22〜50ms
    const tail = 0.065 + Math.random() * 0.05; // 2つ目のあとの減衰 65〜115ms
    const peak1Time = t + attack;
    const dipTime = peak1Time + gap * 0.6;
    const peak2Time = peak1Time + gap;
    const endTime = peak2Time + tail; // 合計およそ 90〜185ms

    const source = ctx.createBufferSource();
    source.buffer = this.getNoiseBuffer(ctx);
    source.playbackRate.value = 0.75 + Math.random() * 0.55; // ノイズの粒立ちを少し変える

    // 低域を確実に落とす（「ドン」「ボッ」を避ける）。
    const lowCut = ctx.createBiquadFilter();
    lowCut.type = 'highpass';
    lowCut.frequency.value = 700;

    // 主フィルタ。bandpass = ザラついた「ザザッ」、highpass = 少し明るめ。
    const shaper = ctx.createBiquadFilter();
    shaper.type = bright ? 'highpass' : 'bandpass';
    shaper.frequency.value = centerHz;
    shaper.Q.value = q;

    // gain エンベロープに2つの小さなピークを作る＝「ザザッ」の二段感。
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak1, peak1Time); // 1つ目
    env.gain.exponentialRampToValueAtTime(peak1 * dipRatio, dipTime); // 谷（無音にしない）
    env.gain.linearRampToValueAtTime(peak2, peak2Time); // 2つ目（少し弱い）
    env.gain.exponentialRampToValueAtTime(0.0004, endTime); // その後すぐ減衰

    source.connect(lowCut);
    lowCut.connect(shaper);
    shaper.connect(env);
    env.connect(this.seGain);

    source.start(t);
    source.stop(endTime + 0.03);

    this.activePremonitionEnv = env;
    source.onended = () => {
      if (this.activePremonitionEnv === env) this.activePremonitionEnv = null;
      try {
        source.disconnect();
        lowCut.disconnect();
        shaper.disconnect();
        env.disconnect();
      } catch {
        // 既に切断済みでも問題ない
      }
    };
  }
}
