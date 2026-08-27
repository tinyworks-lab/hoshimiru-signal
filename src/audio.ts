/**
 * 効果音(SE)用とBGM用のバスを分けておくことで、
 * 将来BGMを追加してもそれぞれの音量を独立に制御できるようにする。
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private seGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private muted = false;

  /** ユーザー操作（ボタンクリック）のハンドラ内で呼ぶこと。 */
  unlock(): void {
    if (this.ctx) return;

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
    this.playPianoTone(932.33, 0.2, 0.5); // A#5 / B♭5
  }

  /** 「信号ヲ送ル」を押した瞬間の送信音。G#5・受信音と同じロングトーン＋リバーブだが、音量は少し控えめ。 */
  playSend(): void {
    this.playPianoTone(830.61, 0.17, 0.42); // G#5 / A♭5
  }
}
