/**
 * 効果音(SE)用とBGM用のバスを分けておくことで、
 * 将来BGMを追加してもそれぞれの音量を独立に制御できるようにする。
 */
// 予感音の連続を防ぐクールダウン（この時間内は2回目以降の予感音を鳴らさない。視覚演出は別）。
const PREMONITION_SOUND_COOLDOWN_MS = 1800;
// 受信音（ポーン）の直後この時間は、予感音を鳴らさない（重なり回避）。
const RECEIVE_TONE_GUARD_MS = 600;

// 予感音のバリエーション。「短い(single)」と「B(twoPart、ザッ……ザザーーー…ブツッ)」の
// 2種類だけを用意し、毎回どちらかをランダムに選ぶ（機械的な繰り返し感の軽減）。
// どちらも素材は同じホワイトノイズで、フィルタは低域カット(highpass)と高域を丸める
// ゆるいlowpassだけ（bandpassのような強い加工・共振はしない）。末尾はどちらも自然な
// フェードアウトではなく、ごく短いlinearRampで急にゲインを落とす「ブツッ」で終える。
interface PremonitionSingleFlavor {
  key: 'short';
  kind: 'single';
  durationMin: number; // 全体の長さ(秒)
  durationMax: number;
  attackMin: number; // 立ち上がり時間(秒)
  attackMax: number;
  wobbleCountMin: number; // 本体でgainがゆるやかに揺らぐ回数（0でもよい＝ごく短いので必須ではない）
  wobbleCountMax: number;
  lowCutMin: number;
  lowCutMax: number;
  highCutMin: number;
  highCutMax: number;
  peakMin: number;
  peakMax: number;
}

interface PremonitionTwoPartFlavor {
  key: 'B';
  kind: 'twoPart';
  totalDurationMin: number; // 全体の長さ(秒)。part2Durationはここから逆算する。
  totalDurationMax: number;
  part1DurationMin: number; // 最初の「ザッ」の長さ(秒。立ち上がり込み)
  part1DurationMax: number;
  part1AttackMin: number; // 「ザッ」の立ち上がり時間(秒)
  part1AttackMax: number;
  gapDurationMin: number; // 「ザッ」のあとのごく短い間(秒)
  gapDurationMax: number;
  part2AttackMin: number; // 「ザザー」が遠くから入ってくるような立ち上がり時間(秒)
  part2AttackMax: number;
  wobbleCountMin: number; // 「ザザー」本体でgainがゆるやかに揺らぐ回数
  wobbleCountMax: number;
  lowCutMin: number;
  lowCutMax: number;
  highCutMin: number;
  highCutMax: number;
  part1PeakMin: number; // 「ザッ」の音量（少しだけ認識しやすく）
  part1PeakMax: number;
  part2PeakMin: number; // 「ザザー」の音量（part1より控えめ、遠くに消えていく感じ）
  part2PeakMax: number;
}

type PremonitionFlavor = PremonitionSingleFlavor | PremonitionTwoPartFlavor;

const PREMONITION_FLAVORS: PremonitionFlavor[] = [
  // short: 短い「ザッ」または短い「ザーッ」。Bと同じ音質・世界観のまま、明らかに短く軽い。
  {
    key: 'short',
    kind: 'single',
    durationMin: 0.2,
    durationMax: 0.4,
    attackMin: 0.02,
    attackMax: 0.035,
    wobbleCountMin: 0,
    wobbleCountMax: 1,
    lowCutMin: 450,
    lowCutMax: 650,
    highCutMin: 5500,
    highCutMax: 7000,
    peakMin: 0.07,
    peakMax: 0.1,
  },
  // B: 「ザッ……ザザーーー…」全体およそ1.45〜1.65秒。現在の仕様のまま変更しない。
  {
    key: 'B',
    kind: 'twoPart',
    totalDurationMin: 1.45,
    totalDurationMax: 1.65,
    part1DurationMin: 0.1,
    part1DurationMax: 0.2,
    part1AttackMin: 0.02,
    part1AttackMax: 0.035,
    gapDurationMin: 0.08,
    gapDurationMax: 0.2,
    part2AttackMin: 0.04,
    part2AttackMax: 0.07,
    wobbleCountMin: 3,
    wobbleCountMax: 5,
    lowCutMin: 450,
    lowCutMax: 650,
    highCutMin: 5500,
    highCutMax: 7000,
    part1PeakMin: 0.08,
    part1PeakMax: 0.12,
    part2PeakMin: 0.035,
    part2PeakMax: 0.05,
  },
];

// 予感音用ホワイトノイズ素材の長さ(秒)。Bパターンの最大長(約1.65秒)より
// 十分に余裕を持たせ、ランダムな再生開始位置をずらしても素材が尽きないようにする。
const PREMONITION_NOISE_BUFFER_SECONDS = 2.0;

// 末尾の「ブツッ」: 自然にフェードアウトさせるのではなく、最後のこの長さ(秒)だけ
// 急にgainを落とし、無線が突然切れたような終わり方を演出する。0へ瞬間移動させる
// わけではなく、この短いlinearRampの間だけで落とすことでクリック事故を避ける。両flavor共通。
const PREMONITION_CUT_DURATION_MIN = 0.02;
const PREMONITION_CUT_DURATION_MAX = 0.05;
// 「間」や「ブツッ」到達後に経由する、無音ではないごく低いレベル。
const PREMONITION_VALLEY_LEVEL = 0.0006;

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

  // 予感音用のホワイトノイズ素材。一度だけ合成して使い回す。
  // PREMONITION_NOISE_BUFFER_SECONDS ぶんの長さを持たせ、再生開始位置をランダムにずらしても
  // Bパターン（最大約1.65秒）まで余裕を持って足りるようにしている。
  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = Math.floor(ctx.sampleRate * PREMONITION_NOISE_BUFFER_SECONDS);
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
   * 「予感」（通りすがりの人が新しく接続した気配）のときに鳴らすホワイトノイズ。
   * 通知音ではなく「今、何か聞こえた？」程度。受信音（ポーン）とは明確に区別し、
   * 音量・持続時間ともにポーンより十分控えめに保つ。Web Audio でその場で合成する
   * （音源ファイル不要）。加工は低域カットと高域を丸めるゆるいlowpassだけで、bandpassのような
   * 強い色付けはせず素のノイズ感を残す。末尾は自然にフェードアウトさせず、ごく短いlinearRampで
   * 急にゲインを落として「ブツッ」と無線が切れたように終える。途中はクリック音のような
   * 鋭いピークの連打にはしない。
   *
   * 本番の呼び出し（引数なし）では、毎回 PREMONITION_FLAVORS の
   * short（単発、全体約0.2〜0.4秒の短い「ザッ／ザーッ」）と
   * B（2段構成、全体約1.45〜1.65秒の「ザッ……ザザーーー…ブツッ」）からランダムに1つを選ぶ
   * （常に同じ音に聞こえないようにするため）。
   * forcedFlavorKey にキーを渡すと、デバッグパネルからの動作確認用にその種類を強制的に鳴らせる
   * （その場合はガード・クールダウンの状態を消費しない＝本番の抑制タイミングに影響しない）。
   *
   * 次の場合は何もしない（エラー・ダイアログ・案内は一切出さない。デバッグ強制時も対象）:
   *   - AudioContext がまだ unlock されていない（＝ユーザー操作前）
   *   - AudioContext が running でない
   * 加えて本番の呼び出し（forcedFlavorKeyなし）でのみ、以下でも鳴らさない:
   *   - 直前に受信音（ポーン）が鳴った（重なり回避。ポーンが最優先）
   *   - クールダウン中（連続アクセスで鳴りっぱなしにしない。視覚の予感は別途出る）
   * ミュートは masterGain 経由で自動的に効く（seGain へ接続するため）。
   */
  playPremonitionNoise(forcedFlavorKey?: 'short' | 'B'): void {
    if (!this.ctx || !this.seGain) return;
    if (this.ctx.state !== 'running') return;

    const isDebugForced = forcedFlavorKey !== undefined;
    if (!isDebugForced) {
      const nowMs = performance.now();
      if (nowMs - this.lastReceiveToneAt < RECEIVE_TONE_GUARD_MS) return;
      if (nowMs - this.lastPremonitionAt < PREMONITION_SOUND_COOLDOWN_MS) return;
      this.lastPremonitionAt = nowMs;
    }

    const ctx = this.ctx;
    const t = ctx.currentTime;

    const flavor = isDebugForced
      ? PREMONITION_FLAVORS.find((f) => f.key === forcedFlavorKey)!
      : PREMONITION_FLAVORS[Math.floor(Math.random() * PREMONITION_FLAVORS.length)];

    if (flavor.kind === 'single') {
      this.playPremonitionSingle(ctx, t, flavor);
    } else {
      this.playPremonitionTwoPart(ctx, t, flavor);
    }
  }

  // short: 単発の短いノイズ（開く→[任意でごく短い揺らぎ]→末尾「ブツッ」）。
  private playPremonitionSingle(ctx: AudioContext, t: number, flavor: PremonitionSingleFlavor): void {
    const duration = flavor.durationMin + Math.random() * (flavor.durationMax - flavor.durationMin);
    const attack = flavor.attackMin + Math.random() * (flavor.attackMax - flavor.attackMin);
    const wobbleCount =
      flavor.wobbleCountMin + Math.floor(Math.random() * (flavor.wobbleCountMax - flavor.wobbleCountMin + 1));
    const peak = flavor.peakMin + Math.random() * (flavor.peakMax - flavor.peakMin);
    const lowCutHz = flavor.lowCutMin + Math.random() * (flavor.lowCutMax - flavor.lowCutMin);
    const highCutHz = flavor.highCutMin + Math.random() * (flavor.highCutMax - flavor.highCutMin);

    const attackTime = t + attack;
    const endTime = t + duration;
    const cutDuration =
      PREMONITION_CUT_DURATION_MIN + Math.random() * (PREMONITION_CUT_DURATION_MAX - PREMONITION_CUT_DURATION_MIN);
    const cutStartTime = endTime - cutDuration;
    const wobbleSpan = Math.max(cutStartTime - attackTime, 0.01);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, attackTime); // ノイズが「開く」

    if (wobbleCount > 0) {
      const wobbleStep = wobbleSpan / wobbleCount;
      let time = attackTime;
      for (let i = 0; i < wobbleCount; i += 1) {
        time += wobbleStep;
        const level = peak * (0.7 + Math.random() * 0.35); // ゆるやかな揺らぎ（谷は浅く保つ）
        env.gain.linearRampToValueAtTime(level, time);
      }
    } else {
      env.gain.linearRampToValueAtTime(peak, cutStartTime); // 揺らぎなし。カット直前まで保持。
    }
    // 「ブツッ」: 末尾cutDuration(20〜50ms)だけで谷レベルまで一気に落とす。
    env.gain.linearRampToValueAtTime(PREMONITION_VALLEY_LEVEL, endTime);

    this.startPremonitionSource(ctx, t, endTime, lowCutHz, highCutHz, env);
  }

  // B: 「ザッ（part1）→ごく短い間→ザザー（part2）→ブツッ」の2段構成。
  private playPremonitionTwoPart(ctx: AudioContext, t: number, flavor: PremonitionTwoPartFlavor): void {
    const totalDuration =
      flavor.totalDurationMin + Math.random() * (flavor.totalDurationMax - flavor.totalDurationMin);
    const part1Duration =
      flavor.part1DurationMin + Math.random() * (flavor.part1DurationMax - flavor.part1DurationMin);
    const part1Attack =
      flavor.part1AttackMin + Math.random() * (flavor.part1AttackMax - flavor.part1AttackMin);
    const gapDuration =
      flavor.gapDurationMin + Math.random() * (flavor.gapDurationMax - flavor.gapDurationMin);
    const part2Attack =
      flavor.part2AttackMin + Math.random() * (flavor.part2AttackMax - flavor.part2AttackMin);
    const wobbleCount =
      flavor.wobbleCountMin + Math.floor(Math.random() * (flavor.wobbleCountMax - flavor.wobbleCountMin + 1));
    const part1Peak = flavor.part1PeakMin + Math.random() * (flavor.part1PeakMax - flavor.part1PeakMin);
    const part2Peak = flavor.part2PeakMin + Math.random() * (flavor.part2PeakMax - flavor.part2PeakMin);
    const lowCutHz = flavor.lowCutMin + Math.random() * (flavor.lowCutMax - flavor.lowCutMin);
    const highCutHz = flavor.highCutMin + Math.random() * (flavor.highCutMax - flavor.highCutMin);

    // part2（ザザー）の長さは、全体の長さから「ザッ」と「間」を引いた残りとして決める
    // （「全体およそ何秒」という長さをそのまま実現するため）。
    const part2Duration = Math.max(totalDuration - part1Duration - gapDuration, 0.3);

    const part1AttackTime = t + part1Attack;
    const part1EndTime = t + part1Duration; // ここまでで「ザッ」を谷(ごく低いレベル)へ落とす
    const gapEndTime = part1EndTime + gapDuration; // 「間」の終わり＝「ザザー」の立ち上がり開始
    const part2AttackEndTime = gapEndTime + part2Attack;
    const endTime = part1EndTime + gapDuration + part2Duration; // 全体の終わり

    // part2の最後は自然にフェードアウトさせず、末尾のごく短い区間だけ急にgainを落として
    // 「ブツッ」と無線が切れたような終わり方にする。wobbleはそれより前（まだ聞こえる状態）で終える。
    const cutDuration =
      PREMONITION_CUT_DURATION_MIN + Math.random() * (PREMONITION_CUT_DURATION_MAX - PREMONITION_CUT_DURATION_MIN);
    const cutStartTime = endTime - cutDuration;
    const wobbleSpan = Math.max(cutStartTime - part2AttackEndTime, 0.01);
    // wobbleCount回でちょうどcutStartTimeに到達するようにする（＝カットの直前まで聞こえる状態を保ち、
    // 「ブツッ」の急減衰(cutDuration)がその後の指定どおりの長さで独立して起こるようにするため）。
    const wobbleStep = wobbleSpan / wobbleCount;

    // 1本のgainエンベロープで「ザッ（part1）→ごく短い間→ザザー（part2）」を滑らかに繋ぐ。
    // 谷(ごく低いレベル)を経由するだけで無音にはせず、全てlinearRampで繋ぐことで
    // クリック音のような鋭いピークの連打を避ける。
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(part1Peak, part1AttackTime); // 「ザッ」が開く
    env.gain.linearRampToValueAtTime(PREMONITION_VALLEY_LEVEL, part1EndTime); // 滑らかに落として間へ
    env.gain.setValueAtTime(PREMONITION_VALLEY_LEVEL, gapEndTime); // ごく短い間
    env.gain.linearRampToValueAtTime(part2Peak, part2AttackEndTime); // 「ザザー」が遠くから入ってくる
    let time = part2AttackEndTime;
    for (let i = 0; i < wobbleCount; i += 1) {
      time += wobbleStep;
      const level = part2Peak * (0.7 + Math.random() * 0.35); // ゆるやかな揺らぎ（谷は浅く保つ）
      env.gain.linearRampToValueAtTime(level, time);
    }
    // 「ブツッ」: 末尾cutDuration(20〜50ms)だけで谷レベルまで一気に落とす。
    env.gain.linearRampToValueAtTime(PREMONITION_VALLEY_LEVEL, endTime);

    this.startPremonitionSource(ctx, t, endTime, lowCutHz, highCutHz, env);
  }

  // 予感音の再生元(ノイズソース＋フィルタ)を組み立てて鳴らす。envは呼び出し側で構築済み。
  // 0への瞬間移動ではなく必ずlinearRamp等を経由させることでクリック事故を避けるのは
  // envの構築側（呼び出し元）の責務。
  private startPremonitionSource(
    ctx: AudioContext,
    t: number,
    endTime: number,
    lowCutHz: number,
    highCutHz: number,
    env: GainNode,
  ): void {
    if (!this.seGain) return;

    const source = ctx.createBufferSource();
    source.buffer = this.getNoiseBuffer(ctx);
    // 再生速度は変えない（ホワイトノイズそのものの質感を保つため）。
    // 毎回バッファ内の異なる位置から再生することで、同じ「録音」に聞こえないようにする。
    const maxOffset = Math.max(PREMONITION_NOISE_BUFFER_SECONDS - (endTime - t) - 0.05, 0);
    const offset = Math.random() * maxOffset;

    // 低域のボワつきを軽く落とす（低音感・重さを減らしつつ、ホワイトノイズ感は残す）。
    const lowCut = ctx.createBiquadFilter();
    lowCut.type = 'highpass';
    lowCut.frequency.value = lowCutHz;

    // 高域が刺さらない範囲で少し明るめに残す、ゆるいローパス（bandpassのような強い加工はしない）。
    const highCut = ctx.createBiquadFilter();
    highCut.type = 'lowpass';
    highCut.frequency.value = highCutHz;

    source.connect(lowCut);
    lowCut.connect(highCut);
    highCut.connect(env);
    env.connect(this.seGain);

    source.start(t, offset);
    source.stop(endTime + 0.03);

    this.activePremonitionEnv = env;
    source.onended = () => {
      if (this.activePremonitionEnv === env) this.activePremonitionEnv = null;
      try {
        source.disconnect();
        lowCut.disconnect();
        highCut.disconnect();
        env.disconnect();
      } catch {
        // 既に切断済みでも問題ない
      }
    };
  }
}
