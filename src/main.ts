import './style.css';
import { initAnalytics, trackEvent } from './analytics';
import { AudioManager } from './audio';
import type { HoshimiruWatcher, PresenceSnapshot } from './presence';
import { watchHoshimiruSignal } from './presence';
import { isSameSessionWindow, nextSessionBoundary } from './session-window';

const appEl = document.getElementById('app') as HTMLDivElement;
const button = document.getElementById('signal-button') as HTMLButtonElement;
const lineEl = document.getElementById('signal-line') as unknown as SVGPathElement;
const glowEl = document.getElementById('signal-glow') as unknown as SVGCircleElement;
const watchingLineEl = document.getElementById('readout-watching') as HTMLParagraphElement;
const watchingMainEl = document.getElementById('watching-main') as HTMLSpanElement;
const watchingSubEl = document.getElementById('watching-sub') as HTMLSpanElement;
const receivedLineEl = document.getElementById('readout-received') as HTMLParagraphElement;
const receivedBodyEl = document.getElementById('readout-received-body') as HTMLSpanElement;
const particleEl = document.getElementById('launch-particle') as HTMLDivElement;
const muteButton = document.getElementById('mute-button') as HTMLButtonElement;
const privacyLink = document.getElementById('privacy-link') as HTMLButtonElement;
const privacyModal = document.getElementById('privacy-modal') as HTMLDivElement;
const privacyModalBackdrop = document.getElementById('privacy-modal-backdrop') as HTMLDivElement;
const privacyModalClose = document.getElementById('privacy-modal-close') as HTMLButtonElement;

const audioManager = new AudioManager();
const LAUNCH_DURATION_MS = 1000;
// 送信演出が終わってから「空へ信号ヲ送信中」を維持し、その後「誰カノ信号ヲ待ッテイマス」へ切り替えるまでの時間。
const SENDING_HOLD_MS = 1500;
const NOISE_MIN_DELAY_MS = 4000;
const NOISE_MAX_DELAY_MS = 14000;
const NOISE_DURATION_MS = 600;
const WAVE_DURATION_MS = 1800;
const WAVE_TRAVEL_MARGIN = 30;
const LINE_LEFT = 6;
const LINE_RIGHT = 214;
const LINE_Y = 20;
const RESEND_INTERVAL_MS = 499000; // 8分19秒
// 待機中に信号を受信したとき、「ホシミル信号ヲ受信シマシタ」の一時表示を維持する時間。
// 受信音・波形・受信カウントには関与しない、表示だけの演出。
const RECEIVED_MESSAGE_MS = 8000;
// 最後にホシミル信号を送った時刻(Date.now()のミリ秒)。リロードで再送制限をリセットさせないために使う。
const LAST_SIGNAL_AT_KEY = 'hoshimiru_last_signal_at';

function readLastSignalAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_SIGNAL_AT_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLastSignalAt(timestamp: number): void {
  try {
    localStorage.setItem(LAST_SIGNAL_AT_KEY, String(timestamp));
  } catch {
    // localStorageが使えない環境では、従来どおりsetTimeoutのみで再送制限を行う。
  }
}

function clearLastSignalAt(): void {
  try {
    localStorage.removeItem(LAST_SIGNAL_AT_KEY);
  } catch {
    // 読めない/消せない環境では、区間判定側で無効値として扱う。
  }
}

// 「この空で受信したホシミル信号 N」の累計を、同じタブの閲覧セッション中だけ保持する。
// sessionStorage なので、同じタブのリロードでは残り、タブを閉じる／ブラウザ終了で自動的に消える。
// localStorage も Firebase も使わない。期限処理は行わない（消えるのは sessionStorage 任せ）。
const RECEIVED_TOTAL_KEY = 'hoshimiruReceivedTotal';

function readReceivedTotal(): number {
  try {
    const raw = sessionStorage.getItem(RECEIVED_TOTAL_KEY);
    if (raw === null) return 0;
    const value = Number(raw);
    // 数値として正常で 0 以上のときだけ採用。壊れた値・文字列・負数・NaN は 0 扱い。
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.floor(value);
  } catch {
    return 0;
  }
}

function writeReceivedTotal(total: number): void {
  try {
    sessionStorage.setItem(RECEIVED_TOTAL_KEY, String(Math.max(Math.floor(total), 0)));
  } catch {
    // sessionStorage が使えない環境では、メモリ上の累計だけで動作する。
  }
}

function clearReceivedTotal(): void {
  try {
    sessionStorage.removeItem(RECEIVED_TOTAL_KEY);
  } catch {
    // 消せない環境でも、読み出し側で無効値は 0 として扱う。
  }
}

// presence: いま接続しているだけの人も含む「自分以外」のuid数（「予感」に使う）。
let connectedOthers = 0;
// presence: そのうち信号を送った「自分以外」のuid数（人数表示に使う。自分ぶんは下で加算）。
let watchersOthers = 0;
// 一度でも presence コールバックが来たか。来るまでは「—人」を出す。
let hasPresenceData = false;
// debug モードからのみ増減させる疑似オフセット（本番では常に 0）。
let debugConnectedOffset = 0; // 通りすがり（予感・connected表示）
let debugWatcherOffset = 0; // 疑似watcher（人数表示）
// 自分が信号を送ってからの受信数を数えているか（＝自分がwatcherか）。送信するまでは false。
let isCountingSinceSend = false;
// この読み込みで一度でも送信したか（送信種別の計測用。6時間境界では戻さない）。
let hasEverSent = false;
let isReceiving = false;
let watcher: HoshimiruWatcher | null = null;
let lastPointerPosition: { x: number; y: number } | null = null;
let waveAnimationFrame: number | undefined;
// 「予感」（他者が新しく空を見始めた気配）の小さな揺れ用。受信波(waveAnimationFrame)とは別枠。
let premonitionFrame: number | undefined;
let resendTimer: number | undefined;
let sendingHoldTimer: number | undefined;
// 開いたまま6時間セッション境界(04/10/16/22時)を迎えたときに初回状態へ戻すためのタイマー。
let sessionBoundaryTimer: number | undefined;
// 「ホシミル信号ヲ受信シマシタ」の一時表示を戻すためのタイマー。
// 連続受信では毎回このタイマーを張り直し、最新の受信から8秒後に一度だけ戻す。
let receivedMessageTimer: number | undefined;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * 常に1本の線として見えるようpathを組み立てる。
 * centerXがnullなら完全な直線。centerXを指定すると、その位置を中心とした
 * 小さな折れ(relativeOffsets)を線の一部として差し込む。
 * 線の左右端(LINE_LEFT/LINE_RIGHT)より外側に出た点は取り除かれるため、
 * 中心が端に近いときは自然に「途中まで現れた/途中で消えた」形になる。
 */
function buildLinePath(
  centerX: number | null,
  amplitude: number,
  relativeOffsets: Array<{ dx: number; dyFactor: number }>,
): string {
  const points: Array<{ x: number; y: number }> = [{ x: LINE_LEFT, y: LINE_Y }];

  if (centerX !== null) {
    for (const offset of relativeOffsets) {
      const x = centerX + offset.dx;
      if (x <= LINE_LEFT || x >= LINE_RIGHT) continue;
      points.push({ x, y: LINE_Y + offset.dyFactor * amplitude });
    }
  }

  points.push({ x: LINE_RIGHT, y: LINE_Y });

  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function smoothstep(t: number): number {
  const clamped = Math.min(Math.max(t, 0), 1);
  return clamped * clamped * (3 - 2 * clamped);
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// 数字を差し替える前に .is-changing で opacity を下げ切るまで待つ時間。
// CSSのフェード(通常0.3s / reduced 0.09s)より短くてよい（見えなくなり始めれば十分）。
const NUMBER_FADE_MS = prefersReducedMotion ? 70 : 160;
// 受信時に数字がごく短く明るくなる時間。
const RECEIVED_PING_MS = 500;

// --- 1) 「今、空を見ている」／独り占め表示 --------------------------------------
let watchingSwapTimer: number | undefined;
// 直近に描画した状態のキー。同じなら再描画しない。
let currentWatchingKey = '';

// 信号を送った「自分以外」の人数（debug オフセット込み、0未満は0）。
function watchersOthersEffective(): number {
  return Math.max(watchersOthers + debugWatcherOffset, 0);
}

// 表示する「今、空を見ている」人数（= 送信済みの他者 + 自分が送信済みなら1）。
function watchingHeadcount(): number {
  return watchersOthersEffective() + (isCountingSinceSend ? 1 : 0);
}

// 1行目（人数 or 独り占め文）と2行目（独り占めの副文）を、必要なときだけ
// opacity フェードを挟んで差し替える。行の高さは常に2行分確保されるため縦位置は動かない。
//
//   pending    : presence未確定                     → 「今、空を見ている　—人」
//   solo-unsent: 自分未送信 かつ watcher 0（A）      → 「まだ誰もいません」
//   solo-sent  : 自分送信済み かつ 他者watcher 0（B） → 「今、この空を…あなただけ」＋副文
//   n:N        : それ以外（C／他者1人）             → 「今、空を見ている　N人」
function renderWatchingCount(): void {
  const others = watchersOthersEffective();
  const self = isCountingSinceSend ? 1 : 0;
  const total = others + self;

  let key: string;
  if (!hasPresenceData) key = 'pending';
  else if (total === 0) key = 'solo-unsent';
  else if (total === 1 && self === 1) key = 'solo-sent';
  else key = `n:${total}`;

  if (key === currentWatchingKey) return;
  const isFirst = currentWatchingKey === '';
  currentWatchingKey = key;

  const apply = (): void => {
    if (key === 'pending') {
      watchingMainEl.innerHTML = '今、空を見ている　<span class="readout-number">—</span>人';
      watchingSubEl.classList.remove('is-visible');
      watchingLineEl.classList.remove('is-solo');
    } else if (key === 'solo-unsent') {
      watchingMainEl.textContent = 'まだ誰もいません';
      watchingSubEl.classList.remove('is-visible');
      watchingLineEl.classList.add('is-solo');
    } else if (key === 'solo-sent') {
      watchingMainEl.textContent = '今、この空を見ているのはあなただけ';
      watchingSubEl.classList.add('is-visible');
      watchingLineEl.classList.add('is-solo');
    } else {
      watchingMainEl.innerHTML = `今、空を見ている　<span class="readout-number">${total}</span>人`;
      watchingSubEl.classList.remove('is-visible');
      watchingLineEl.classList.remove('is-solo');
    }
  };

  if (watchingSwapTimer !== undefined) window.clearTimeout(watchingSwapTimer);
  if (isFirst || prefersReducedMotion) {
    apply();
    return;
  }
  // フェードアウト → 見えない状態で差し替え → フェードイン
  watchingLineEl.classList.add('is-changing');
  watchingSwapTimer = window.setTimeout(() => {
    watchingSwapTimer = undefined;
    apply();
    watchingLineEl.classList.remove('is-changing');
  }, NUMBER_FADE_MS);
}

// --- 2) 「受信したホシミル信号 ○」（このページを開いてからの受信累計） -----------------
let receivedPingTimer: number | undefined;

// options.ping=true のとき、数字がごく短く明るくなる（受信の瞬間のみ）。
function renderReceivedSince(options: { ping?: boolean } = {}): void {
  // 表示条件:
  //  - 一度でも送信していれば表示（6時間境界で送信前状態へ戻っても hasEverSent は戻らない）。
  //  - または、この閲覧セッションの受信累計が 1 以上なら表示（リロードで sessionStorage から
  //    復元した場合を含む）。
  // どちらでもない（未送信かつ累計0）ときだけ、従来どおり不可視にする（高さは確保）。
  if (!hasEverSent && receivedTotalOnPage <= 0) {
    receivedLineEl.classList.remove('is-visible');
    return;
  }

  receivedLineEl.classList.add('is-visible');
  receivedBodyEl.textContent = String(Math.max(receivedTotalOnPage, 0));

  if (options.ping && !prefersReducedMotion) {
    receivedLineEl.classList.add('is-pinged');
    if (receivedPingTimer !== undefined) window.clearTimeout(receivedPingTimer);
    receivedPingTimer = window.setTimeout(() => {
      receivedPingTimer = undefined;
      receivedLineEl.classList.remove('is-pinged');
    }, RECEIVED_PING_MS);
  }
}

// presence のコールバック。自分以外の「接続数」と「送信済み数」を受け取る。
function handlePresence(snapshot: PresenceSnapshot): void {
  // 「予感」は"接続している他者数"が増えたときだけ（通りすがりの到着も含む）。
  // 初回取得・減少・据え置きでは出さない。2→5 のようにまとめて増えても1回だけ。
  const increased = hasPresenceData && snapshot.connectedOthers > connectedOthers;
  connectedOthers = snapshot.connectedOthers;
  watchersOthers = snapshot.watchersOthers;
  hasPresenceData = true;
  renderWatchingCount();
  if (increased) triggerPremonition();
}

// 新しいuidを検知したときだけの、本当の受信信号。
// 主波は cos窓で包んだ連続波。件数が増えるほど
//   ・山の数(envFreq)が増える  ・波全体の横幅(halfSpan)が広がる
//   ・結果として1山あたりの波長は逆に短くなる
// ＝「同じ波が震える」のではなく「複数の波が連なって通過する」ように見せる。
// fine はそこへ重ねる補助的なムラ（山の高さを不揃いにするだけ）。
// 実際に流す形は makeWaveShape() が受信ごとに組み立てる。
const WAVE_AMPLITUDE = 30; // 待機ノイズとは別に、本当の受信時だけさらに大きくする
const WAVE_EDGE_FADE_FRACTION = 0.12;
// 主波片側の基準の広がり(px)。件数に応じて spanScale 倍に広げる。
const WAVE_HALF_SPAN = 30;
// 主波を折れ線で描くサンプル点数の下限/上限。山が増えても1山あたり十分な点数を保つ。
const WAVE_SAMPLE_MIN = 44;
const WAVE_SAMPLE_MAX = 100;

// a〜b の範囲を 0〜1 に線形マッピング（範囲外はクランプ）。
// lineGrowthFactor は10件あたりでほぼ1に飽和するため、「10件以降」「20〜30件」といった
// 高件数側の段階的な変化は、飽和しないこの ramp() で件数から直接求める。
function ramp(value: number, from: number, to: number): number {
  return Math.min(Math.max((value - from) / (to - from), 0), 1);
}

// 【線の成長用】自分が信号を送ってから届いた信号数（isCountingSinceSend が true の間だけ増える）。
// 送信・再送・6時間セッション境界で 0 に戻る。波形・線の育ち具合(lineGrowthFactor)はこの値を基準にする。
// ※画面に出す「受信したホシミル信号 N」の表示には使わない（下の receivedTotalOnPage を使う）。
let receivedSignalCount = 0;

// 【表示用】このタブの閲覧セッション中の受信総数。sessionStorage に保存する（localStorage/Firebaseは使わない）。
// 送信・再送・6時間セッション境界・波形リセットでは 0 に戻さない。受信ごとに +1 して保存。
// 同じタブのリロードでは維持され、タブを閉じる／ブラウザ終了で 0 に戻る。
let receivedTotalOnPage = readReceivedTotal();

// 累積受信数 n → 0〜1 の「育ち具合」。指数飽和に ease-in を掛け、1〜3件は控えめ、
// 10件付近で十分育ち、20〜30件で頭打ちになるカーブにする。
// growth:  n=1:0.15 / n=2:0.34 / n=3:0.50 / n=5:0.73 / n=10:0.95 / n=20:≒1 / n=30:≒1
const GROWTH_TAU = 3; // 飽和の速さ。大きいほど序盤が緩やか
const GROWTH_EASE = 1.5; // 序盤を寝かせる ease-in の強さ（n=1 を弱いまま、n=3 を少し引き上げる）
function lineGrowthFactor(receivedCount: number): number {
  if (receivedCount <= 0) return 0;
  const saturating = 1 - Math.exp(-receivedCount / GROWTH_TAU);
  return saturating ** GROWTH_EASE;
}

// 平常時（受信していないとき）の線の強さ。育ちきってもこの値までに抑える。
// steady:  n=1:≈0.13 / n=3:≈0.45 / n=10:≈0.85 / n=30:≈0.90
const STEADY_STRENGTH_MAX = 0.9;
function steadyLineStrength(growth: number): number {
  return growth * STEADY_STRENGTH_MAX;
}

// 受信した瞬間の一時的なピーク強さ。累積の落ち着き先より必ず一段強くなる（両者は分離）。
function receivePeakStrength(growth: number): number {
  return Math.min(1, Math.max(0.6, steadyLineStrength(growth) + 0.25));
}

// 育つほど、波の振幅・余韻(継続時間)・線が落ち着くまでの時間を少しずつ強める。
// 1件は「痕跡」程度に弱く。高件数は「大きく」より「密度と広がり」で見せるため振幅の伸びは控えめ。
const WAVE_AMP_MIN = 0.45; // growth=0 での主波振幅（WAVE_AMPLITUDE比）
const WAVE_AMP_RANGE = 0.6; // growth=1 で +0.6 → 最大約1.05倍（高さより密度・広がりで見せる）
// 主波をわずかに上寄せ（線の上側＝余白のある方向へ）。多山化で下側に伸びて
// 下の人数表示へ近づきすぎるのを防ぐ。窓で包むため端は影響を受けない。
const WAVE_UPWARD_BIAS = 0.22;
const WAVE_DURATION_MIN = 0.9;
const WAVE_DURATION_RANGE = 0.5;
const LINE_SETTLE_BASE_S = 1; // 受信後、平常へ戻るトランジション時間 1s 〜 2.4s
const LINE_SETTLE_GROWTH_S = 1.4;

/**
 * 線の現在の強さ(--line-strength)を設定する。
 * instant=true のときは .is-pulsing を付け、速いトランジションで一気に立ち上げる。
 * instant=false のときは .is-pulsing を外し、--line-settle の長いトランジションで
 * ゆっくり落ち着かせる（受信後の余韻）。
 */
function applyLineStrength(
  strength: number,
  options: { instant?: boolean; settleSeconds?: number } = {},
): void {
  const { instant = false, settleSeconds } = options;
  if (settleSeconds !== undefined) {
    lineEl.style.setProperty('--line-settle', `${settleSeconds.toFixed(2)}s`);
  }
  lineEl.classList.toggle('is-pulsing', instant);
  lineEl.style.setProperty('--line-strength', strength.toFixed(3));
}

// 10件以降の「恒常的」な発光の変化。線本体（--line-strength）とは分離し、
// 周囲へ広がる光の範囲(--glow-spread)と、glowのごく淡い青み(--glow-blue)だけを動かす。
// 10件で変化開始、20〜30件付近で上限。線を極端に太くはしない。
function applyAccumulatedGlow(count: number): void {
  // 発光範囲の広がり: 10件で開始、30件で最大。
  lineEl.style.setProperty('--glow-spread', ramp(count, 10, 30).toFixed(3));
  // 外側haloの青み: 10件でほぼ白、15〜20件でわずかに、30件で明確な淡い青白へ。
  lineEl.style.setProperty('--glow-blue', ramp(count, 12, 30).toFixed(3));
}

interface WaveShape {
  offsets: Array<{ dx: number; dyFactor: number }>;
  amplitudeScale: number;
  travelMargin: number;
}

// 主波の「山の数」を決める周波数（cos の π 倍係数）。件数が増えるほど山が増える。
// n=1:≈1.2（大きな山1つ） / n=3:≈1.75（2つ程度） / n=10:≈3.8（3〜4個）
// n=20:≈5.7（4〜5個） / n=30:≈7.5（5〜6個）
function waveEnvFrequency(count: number, growth: number): number {
  return 1 + growth * 1.5 + ramp(count, 3, 30) * 5;
}

// 波全体の横幅の倍率（1件を基準）。件数が増えるほど広がる。
// n=3:≈1.15 / n=10:≈1.43 / n=20:≈1.68 / n=30:≈1.92
// envFrequency の方が速く増えるので、1山あたりの波長は逆に短くなる。
function waveSpanScale(count: number, growth: number): number {
  return 1 + growth * 0.3 + ramp(count, 4, 30) * 0.62;
}

/**
 * 1回の受信ごとに、その波だけのパラメータ（山の数・横幅・位相・ムラ）を決める。
 * 決めた形は波の再生中ずっと固定で、毎フレームの乱数は使わない（滑らかに動かすため）。
 *
 * main: cos窓で包んだ連続波。envFreq で山の数、spanScale で横幅が件数とともに増える。
 *   低件数＝狭い範囲に大きな山1つ。高件数＝横に広い範囲を複数の短い山が連なって通過。
 * fine: main より遅い非整数倍の周期で山の高さを不揃いにするだけの補助成分。
 *   「複数の信号が重なっている」ムラを出す。ザワつかせないよう振幅はごく小さい。
 * reduced-motion では fine を付けず、main だけを流す。
 */
function makeWaveShape(count: number): WaveShape {
  const growth = lineGrowthFactor(count);

  // 受信ごとに固定のランダム差（世界観を壊さない範囲）。
  const amplitudeScale = randomBetween(0.94, 1.06);
  const asym = randomBetween(0.9, 1.12); // 前後の非対称（位相ずれ相当）
  const mainPhase = randomBetween(-0.5, 0.5); // 山の位置を受信ごとに少しずらす
  const finePhase = randomBetween(0, Math.PI * 2);

  const envFreq = waveEnvFrequency(count, growth);
  const halfSpan = WAVE_HALF_SPAN * waveSpanScale(count, growth) * randomBetween(0.95, 1.06);

  // 補助のムラ。main より遅い周期（非整数倍）にして、うねりが重なって見えるようにする。
  const fineLevel = prefersReducedMotion ? 0 : ramp(count, 6, 30);
  const fineAmp = fineLevel * 0.12; // main（最大1）に対する比。小さく保つ。
  const fineFreq = envFreq * randomBetween(0.5, 0.72);

  // 山が増えても1山あたり十分な点数を確保する（44〜100点で可変）。
  const sampleCount = Math.min(
    Math.max(Math.round(20 + envFreq * 12), WAVE_SAMPLE_MIN),
    WAVE_SAMPLE_MAX,
  );

  const offsets: Array<{ dx: number; dyFactor: number }> = [];
  for (let i = 0; i <= sampleCount; i += 1) {
    const u = (i / sampleCount) * 2 - 1; // -1..1
    const windowValue = Math.cos((u * Math.PI) / 2) ** 2; // 中心1・端0の滑らかな窓
    const main = (-Math.cos(envFreq * Math.PI * u + mainPhase) - WAVE_UPWARD_BIAS) * windowValue;
    const fine = fineAmp * Math.sin(fineFreq * Math.PI * u + finePhase) * windowValue;
    const side = u >= 0 ? asym : 1 / asym;
    offsets.push({ dx: u * halfSpan * side, dyFactor: main + fine });
  }

  // 波全体の広がりに合わせ、波が線を通り抜けきる余白を確保する。
  const travelMargin = WAVE_TRAVEL_MARGIN + halfSpan;

  return { offsets, amplitudeScale, travelMargin };
}

interface WaveRenderParams {
  amplitude: number;
  durationMs: number;
  offsets: Array<{ dx: number; dyFactor: number }>;
  travelMargin: number;
}

function animateReceivedWave(params: WaveRenderParams, onComplete: () => void): void {
  const { amplitude, durationMs, offsets, travelMargin } = params;
  const startTime = performance.now();
  const travelStart = LINE_LEFT - travelMargin;
  const travelEnd = LINE_RIGHT + travelMargin;

  // 待機中の光点フラッシュが途中であれば打ち切り、発光は線全体側(is-pulsing)に一本化する。
  glowEl.classList.remove('is-flashing');

  function step(now: number): void {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    const centerX = travelStart + (travelEnd - travelStart) * easeInOutQuad(progress);

    // 開始・終了の前後12%だけ振幅をsmoothstepで滑らかにフェードし、
    // 端付近で頂点が離散的に出入りして見える(カクつく)のを防ぐ。
    let ampScale = 1;
    if (progress < WAVE_EDGE_FADE_FRACTION) {
      ampScale = smoothstep(progress / WAVE_EDGE_FADE_FRACTION);
    } else if (progress > 1 - WAVE_EDGE_FADE_FRACTION) {
      ampScale = smoothstep((1 - progress) / WAVE_EDGE_FADE_FRACTION);
    }

    // 信号の現在位置だけ、線の一部としてこの形を差し込む（波形を横移動させているのではなく、
    // 毎フレーム「今どこが反応しているか」を計算し直して1本のpathを再構築している）。
    lineEl.setAttribute('d', buildLinePath(centerX, amplitude * ampScale, offsets));

    if (progress < 1) {
      waveAnimationFrame = requestAnimationFrame(step);
    } else {
      lineEl.setAttribute('d', buildLinePath(null, 0, []));
      waveAnimationFrame = undefined;
      onComplete();
    }
  }

  if (waveAnimationFrame !== undefined) {
    cancelAnimationFrame(waveAnimationFrame);
  }
  waveAnimationFrame = requestAnimationFrame(step);
}

function flashNewSignal(): void {
  // 表示用の累計は、送信の有無にかかわらず受信ごとに +1（この閲覧セッション中ずっと積算）。
  receivedTotalOnPage += 1;
  writeReceivedTotal(receivedTotalOnPage);

  // 線の成長用のカウントは従来どおり「自分が送ってから」の受信だけを数える（波形の仕様は不変）。
  if (isCountingSinceSend) {
    receivedSignalCount += 1;
  }
  // 数字（累計値）の更新と受信の瞬間の軽い明滅。表示行は送信前は不可視のまま。
  renderReceivedSince({ ping: true });

  const growth = lineGrowthFactor(receivedSignalCount);

  isReceiving = true;

  // 受信の瞬間は、累積の落ち着き先より強く一気に脈動させる（速いトランジション）。
  applyLineStrength(receivePeakStrength(growth), { instant: true });

  // 受信ごとに、その波だけの形（山の数・横幅・位相・ムラ）を決める。
  const shape = makeWaveShape(receivedSignalCount);
  // 育つほど波の振幅を強く、継続時間（余韻）を長くする。1件は痕跡程度。受信ごとの微差も掛ける。
  const amplitude =
    WAVE_AMPLITUDE * (WAVE_AMP_MIN + growth * WAVE_AMP_RANGE) * shape.amplitudeScale;
  const durationMs = WAVE_DURATION_MS * (WAVE_DURATION_MIN + growth * WAVE_DURATION_RANGE);

  animateReceivedWave(
    {
      amplitude,
      durationMs,
      offsets: shape.offsets,
      travelMargin: shape.travelMargin,
    },
    () => {
      isReceiving = false;
      // 累積受信数に応じた平常時の強さへ、余韻を残しながらゆっくり落ち着く。
      // 育つほど戻りが遅くなる＝余韻が長くなる。
      applyLineStrength(steadyLineStrength(growth), {
        instant: false,
        settleSeconds: LINE_SETTLE_BASE_S + growth * LINE_SETTLE_GROWTH_S,
      });
      // 10件以降の発光範囲・青みも、同じゆっくりしたトランジションで恒常的に育てる。
      applyAccumulatedGlow(receivedSignalCount);
    },
  );
}

// 「送ってから届いた信号数」（線の成長用カウント）だけを 0 に戻し、育った線をゆっくり
// 平常の淡さへ落ち着かせる。画面表示の「受信したホシミル信号 N」は receivedTotalOnPage を
// 使うため、ここでは 0 に戻らない（再送・セッション境界でも累計は維持される）。
function resetReceivedSignals(): void {
  receivedSignalCount = 0;
  if (!isReceiving) {
    applyLineStrength(0, { instant: false, settleSeconds: 2 });
    applyAccumulatedGlow(0);
  }
  renderReceivedSince();
}

// --- 受信時の一時表示（表示だけ。通信・受信判定・音・波形には触れない） -----------------
// 待機中(「誰カノ信号ヲ待ッテイマス」表示中)に信号を受信した瞬間だけ、その領域を
// 「ホシミル信号ヲ受信シマシタ」へ静かに切り替える。CSS 側は #app[data-state="waiting"]
// のときだけ .is-received を効かせるため、待機中以外では付与しても見た目は変わらない。
function clearReceivedMessage(): void {
  if (receivedMessageTimer !== undefined) {
    window.clearTimeout(receivedMessageTimer);
    receivedMessageTimer = undefined;
  }
  appEl.classList.remove('is-received');
}

function showReceivedMessage(): void {
  // 待機中でなければ一時表示は出さない（受信音・波形・カウントは呼び出し側で従来どおり実行済み）。
  if (appEl.dataset.state !== 'waiting') return;

  appEl.classList.add('is-received');
  // 連続受信では毎回張り直し、古いタイマーが先に表示を消さないようにする（最新の受信から8秒）。
  if (receivedMessageTimer !== undefined) window.clearTimeout(receivedMessageTimer);
  receivedMessageTimer = window.setTimeout(() => {
    receivedMessageTimer = undefined;
    appEl.classList.remove('is-received');
  }, RECEIVED_MESSAGE_MS);
}

// --- 「予感」: 他者が新しく空を見始めた気配 -------------------------------------
// presence の他者数が増えたときだけ、線のどこか一部分が一瞬だけ不安定になる。
// 「通信が一瞬乱れた」「遠くの気配が線をかすめた」程度の静かな違和感。
//   ・細かな微振動（低周波の揺らぎ + 短周期の小さな揺れ の合成、位相は時間で滑らかに進める）
//   ・掠れ（stroke-dasharray を短時間だけ開いて閉じる。数個の小さな隙間だけ）
//   ・ごく軽い明滅（1〜2回、opacity をほんの少し落とす）
//   ・横方向の漂い（ざわついた領域そのものが 20〜40px だけ横へ流れて消える）
// 音・光点なし。受信数・線の累積成長(--line-strength)には一切触れない。
// 波ではないので大きな山は作らない。受信中は出さない（受信波が線を所有する）。
const PREMONITION_DURATION_MS = 2200;
const PREMONITION_DURATION_REDUCED_MS = 1300;
const PREMONITION_DRIFT_MIN = 20; // 横へ漂う距離(px)。画面を横断させない
const PREMONITION_DRIFT_MAX = 40;
const PREMONITION_DRIFT_REDUCED_MAX = 5; // reduced-motion では 5px 以下

// 予感で付けた一時的なスタイルを元へ戻す。d は呼び出し側で扱う。
function clearPremonitionStyles(): void {
  lineEl.style.opacity = '';
  lineEl.style.removeProperty('stroke-dasharray');
  lineEl.style.removeProperty('stroke-dashoffset');
}

// 他者数が増えたときに1回だけ呼ばれる。受信波(waveAnimationFrame)には触れない。
function triggerPremonition(): void {
  // 連続で増えても常に1回だけ。進行中があれば打ち切って作り直す。
  if (premonitionFrame !== undefined) {
    cancelAnimationFrame(premonitionFrame);
    premonitionFrame = undefined;
  }
  clearPremonitionStyles();

  // 受信演出中は予感を出さない（受信が線を所有する）。
  if (isReceiving) return;

  // 視覚の微振動が始まるのとほぼ同時に、ごく短い微弱ノイズ音を鳴らす。
  // 未unlock / cooldown中 / 受信音の直後 なら AudioManager 側で静かに抑制される。
  audioManager.playPremonitionNoise();

  const reduced = prefersReducedMotion;
  const durationMs = reduced ? PREMONITION_DURATION_REDUCED_MS : PREMONITION_DURATION_MS;

  // この予感1回ぶんのパラメータ（毎フレームの乱数は使わない）。
  const startCenterX = randomBetween(80, 140); // 線のどこか一部分（漂いの起点）
  const regionWidth = reduced ? 0 : randomBetween(44, 80); // その周辺だけが震える
  const halfWidth = regionWidth / 2;
  const vibAmplitude = reduced ? 0 : randomBetween(2, 4); // 2〜4px

  // 漂い: 開始時に距離と向きを1度だけ決める。左右どちらかへ 20〜40px（reduced は 5px 以下）。
  const driftMagnitude = reduced
    ? randomBetween(0, PREMONITION_DRIFT_REDUCED_MAX)
    : randomBetween(PREMONITION_DRIFT_MIN, PREMONITION_DRIFT_MAX);
  const driftDistance = driftMagnitude * (Math.random() < 0.5 ? -1 : 1);

  const lowFreq = (Math.PI * 2) / randomBetween(26, 46); // ゆっくりした揺らぎ
  const highFreq = (Math.PI * 2) / randomBetween(6, 11); // 短周期の小さな揺れ
  const lowPhase = randomBetween(0, Math.PI * 2);
  const highPhase = randomBetween(0, Math.PI * 2);
  const lowDrift = randomBetween(3, 5) * (Math.random() < 0.5 ? -1 : 1); // 位相を時間で進める＝震え
  const highDrift = randomBetween(9, 15) * (Math.random() < 0.5 ? -1 : 1);
  const mix = randomBetween(0.52, 0.68); // 低周波と短周期の混合比

  const sampleCount = regionWidth > 0 ? Math.max(24, Math.round(regionWidth / 1.6)) : 0;

  const frayWindow = reduced ? 0.22 : 0.34; // 演出の前半のうち、この割合だけ掠れる
  const frayMaxGap = reduced ? 1.0 : 1.9; // 隙間の最大幅(px)。小さく保つ

  // 領域が線からはみ出さないよう、中心の可動域を制限する。
  const centerMin = LINE_LEFT + halfWidth + 4;
  const centerMax = LINE_RIGHT - halfWidth - 4;

  const startTime = performance.now();

  const gauss = (p: number, center: number, width: number): number =>
    Math.exp(-(((p - center) / width) ** 2));
  // 漂いの ease: 最初から少し動き、中盤で流れ、最後は減速して止まる（easeOutSine）。
  const driftEase = (t: number): number => Math.sin((t * Math.PI) / 2);

  function step(now: number): void {
    // 受信波が始まったら即座に終了。d は触らず、付けた一時スタイルだけ戻して受信へ譲る。
    if (isReceiving) {
      clearPremonitionStyles();
      premonitionFrame = undefined;
      return;
    }

    const p = Math.min((now - startTime) / durationMs, 1);
    const tSec = (now - startTime) / 1000;

    // 漂い: ざわついた領域そのものの中心。微振動も掠れもこの位置に追従する。
    const currentCenterX = Math.min(
      Math.max(startCenterX + driftDistance * driftEase(p), centerMin),
      centerMax,
    );

    // --- 微振動 ---（reduced では regionWidth=0 なので直線のまま）
    if (sampleCount > 0) {
      // 立ち上がり速く(〜p=0.13)、その後ゆっくり減衰(〜p=1)。
      const vibEnv =
        smoothstep(p / 0.13) * (1 - smoothstep(Math.max(0, (p - 0.2) / 0.8)));
      const offsets: Array<{ dx: number; dyFactor: number }> = [];
      for (let i = 0; i <= sampleCount; i += 1) {
        const u = (i / sampleCount) * 2 - 1; // -1..1
        const dx = u * halfWidth;
        const win = Math.cos((u * Math.PI) / 2) ** 2; // 区間の端で0＝線に滑らかに接続
        const low = Math.sin(lowFreq * dx + lowPhase + tSec * lowDrift);
        const high = Math.sin(highFreq * dx + highPhase + tSec * highDrift);
        offsets.push({ dx, dyFactor: (mix * low + (1 - mix) * high) * win * vibEnv });
      }
      lineEl.setAttribute('d', buildLinePath(currentCenterX, vibAmplitude, offsets));
    } else {
      lineEl.setAttribute('d', buildLinePath(null, 0, []));
    }

    // --- 掠れ ---（前半だけ、隙間が0→最大→0へ滑らかに開閉する。位置は漂いに追従）
    // dasharray は [実線,隙間,実線,隙間,...] の繰り返し。奇数個にして必ず実線で終わらせ、
    // 末尾を線長より十分長い実線にすることで「区間の3つの小さな隙間」以外は完全な実線を保つ。
    const frayEnv = Math.sin(Math.min(p / frayWindow, 1) * Math.PI);
    const gap = frayMaxGap * Math.max(frayEnv, 0);
    if (gap > 0.04) {
      const g = gap.toFixed(2);
      // 線の始点(LINE_LEFT)からの距離。線はほぼ水平なので x 距離で近似。
      const frayStart = Math.max(0, currentCenterX - halfWidth * 0.8 - LINE_LEFT);
      lineEl.style.setProperty(
        'stroke-dasharray',
        `${frayStart.toFixed(1)} ${g} 4 ${g} 4 ${g} 400`,
      );
    } else {
      lineEl.style.removeProperty('stroke-dasharray');
    }

    // --- ごく軽い明滅 ---（1〜2回。opacity をほんの少しだけ落とす）
    const dip =
      (reduced ? 0.09 : 0.2) * gauss(p, 0.34, 0.1) +
      (reduced ? 0.06 : 0.13) * gauss(p, 0.62, 0.09);
    lineEl.style.opacity = String(Math.max(0, 1 - dip));

    if (p < 1) {
      premonitionFrame = requestAnimationFrame(step);
    } else {
      // 必ず元の path / opacity / dash 状態へ戻す。
      lineEl.setAttribute('d', buildLinePath(null, 0, []));
      clearPremonitionStyles();
      premonitionFrame = undefined;
    }
  }

  premonitionFrame = requestAnimationFrame(step);
}

// 待機中、数秒〜十数秒おきにごく小さく発生させる「微弱な電波を拾っている」感覚の表現。
// 本当の受信演出中(isReceiving)は発生させない。人数や受信とは無関係で、音も鳴らさない。
const NOISE_OFFSETS: Array<{ dx: number; dyFactor: number }> = [
  { dx: -6, dyFactor: -1 },
  { dx: 0, dyFactor: 0.6 },
  { dx: 6, dyFactor: -0.3 },
];

// 線がほんの少し上下に揺れるだけの、最も控えめな反応。
function triggerIdleWiggle(): void {
  const centerX = randomBetween(60, 160);
  const peakAmplitude = randomBetween(2, 4);
  const startTime = performance.now();

  function step(now: number): void {
    if (isReceiving) {
      lineEl.setAttribute('d', buildLinePath(null, 0, []));
      return;
    }
    if (premonitionFrame !== undefined) {
      // 予感が線を描いている間は譲る（微弱な揺れ同士が競合しないように）。
      return;
    }

    const elapsed = now - startTime;
    const progress = Math.min(elapsed / NOISE_DURATION_MS, 1);
    const envelope = Math.sin(Math.PI * progress); // 0→1→0の緩やかな出入り
    const amplitude = peakAmplitude * envelope;

    lineEl.setAttribute('d', buildLinePath(centerX, amplitude, NOISE_OFFSETS));

    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      lineEl.setAttribute('d', buildLinePath(null, 0, []));
    }
  }

  requestAnimationFrame(step);
}

// 線のどこかが一瞬だけわずかに明るくなる/小さな光点が現れて消える反応。
// どちらも同じ光点要素の大きさ・強さ・長さだけを変えて表現する。
function triggerIdleGlow(): void {
  const isSpark = Math.random() < 0.5;
  const x = randomBetween(20, 200);
  const radius = isSpark ? randomBetween(1.1, 1.6) : randomBetween(2.8, 4);
  const peakOpacity = isSpark ? randomBetween(0.7, 0.9) : randomBetween(0.3, 0.45);
  const duration = isSpark ? 350 : 700;

  glowEl.setAttribute('cx', x.toFixed(1));
  glowEl.setAttribute('cy', String(LINE_Y));
  glowEl.setAttribute('r', radius.toFixed(1));
  glowEl.style.setProperty('--glow-peak', peakOpacity.toFixed(2));
  glowEl.style.animationDuration = `${duration}ms`;

  glowEl.classList.remove('is-flashing');
  void glowEl.getBoundingClientRect(); // アニメーションを再始動させるための強制リフロー
  glowEl.classList.add('is-flashing');
}

function triggerIdleReaction(): void {
  if (isReceiving) return;
  if (Math.random() < 0.55) {
    triggerIdleWiggle();
  } else {
    triggerIdleGlow();
  }
}

function scheduleIdleNoise(): void {
  const delay = randomBetween(NOISE_MIN_DELAY_MS, NOISE_MAX_DELAY_MS);
  window.setTimeout(() => {
    triggerIdleReaction();
    scheduleIdleNoise();
  }, delay);
}

function getLaunchOrigin(): { x: number; y: number } {
  if (lastPointerPosition) {
    return lastPointerPosition;
  }
  const rect = button.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function triggerLaunchParticle(origin: { x: number; y: number }): void {
  particleEl.style.left = `${origin.x}px`;
  particleEl.style.top = `${origin.y}px`;

  particleEl.classList.remove('is-active');
  void particleEl.getBoundingClientRect(); // アニメーションを再始動させるための強制リフロー
  particleEl.classList.add('is-active');
}

// 最初の送信から499秒(8分19秒)後に、同じ領域で「モウイチド信号ヲ送ル」ボタンへ切り替える。
// presenceへの再参加は行わない。「送れるかどうか」は受信の可否とは完全に独立している。
function scheduleResend(delayMs: number = RESEND_INTERVAL_MS): void {
  if (resendTimer !== undefined) {
    window.clearTimeout(resendTimer);
  }
  resendTimer = window.setTimeout(() => {
    resendTimer = undefined;
    button.textContent = 'モウイチド信号ヲ送ル';
    button.disabled = false;
    appEl.dataset.state = 'idle';
  }, Math.max(delayMs, 0));
}

// ページ読み込み時に、localStorageの最終送信時刻から送信可能状態を復元する。
// isCountingSinceSend が true になった場合、そのユーザーはまだ空を見ている（送信済み）扱い。
// init() で presence へも sent:true として登録する（新しい/signalsイベントは送らない）。
function restoreSignalState(): void {
  const lastSignalAt = readLastSignalAt();
  if (lastSignalAt === null) {
    // 最終送信記録なし。通常どおり「信号ヲ送ル」を表示する。
    return;
  }

  const now = Date.now();

  // 最後に送信した時刻と現在時刻が別の6時間セッション区間なら、前回の送信記録を無効化し、
  // UI上は完全に初回状態(「信号ヲ送ル」)として扱う。経過時間(8分19秒)は見ない。
  if (!isSameSessionWindow(lastSignalAt, now)) {
    clearLastSignalAt();
    return;
  }

  const elapsed = now - lastSignalAt;

  if (elapsed >= RESEND_INTERVAL_MS) {
    // 499000ms以上経過。「モウイチド信号ヲ送ル」を表示する（送信済み扱いには戻さない）。
    button.textContent = 'モウイチド信号ヲ送ル';
    appEl.dataset.state = 'idle';
    return;
  }

  // 499000ms未満。ボタンは出さず「誰カノ信号ヲ待ッテイマス」を表示し、残り時間だけ待つ。
  // このユーザーは既に送信済み扱い＝watcher。受信数のカウントも（0から）再開する。
  isCountingSinceSend = true;
  hasEverSent = true;
  button.disabled = true;
  appEl.dataset.state = 'waiting';
  const remainingMs = Math.min(RESEND_INTERVAL_MS - elapsed, RESEND_INTERVAL_MS);
  scheduleResend(remainingMs);
}

// 6時間セッション境界を越えたときに、送信可能状態「だけ」を初回(「信号ヲ送ル」)へ戻す。
// ここではリロードもpresence退出もせず、/signalsへの送信・送信音/受信音・
// 送信アニメーション・受信波形も一切発生させない。空を見ている人はpresenceに残る。
function resetToFirstSignalState(): void {
  clearLastSignalAt();

  if (resendTimer !== undefined) {
    window.clearTimeout(resendTimer);
    resendTimer = undefined;
  }
  if (sendingHoldTimer !== undefined) {
    window.clearTimeout(sendingHoldTimer);
    sendingHoldTimer = undefined;
  }
  clearReceivedMessage();

  button.textContent = '信号ヲ送ル';
  button.disabled = false;
  appEl.dataset.state = 'idle';

  // 送信前の状態へ戻す。受信数のカウントを止めて「あなたが受信したホシミル信号」行を隠し、
  // 育った線もゆっくり平常の淡さへ落ち着かせる。
  // presence 上でも sent:false へ戻す（もう一度送信すれば再び watcher に含まれる）。
  isCountingSinceSend = false;
  watcher?.markUnsent();
  resetReceivedSignals();
  renderWatchingCount();
}

// 現在時刻から次のセッション境界(04/10/16/22時)までを計算してsetTimeoutする。
// 高頻度なsetIntervalは使わない。境界を迎えたら初回状態へ戻し、次の境界へ再設定する。
function scheduleSessionBoundaryReset(): void {
  if (sessionBoundaryTimer !== undefined) {
    window.clearTimeout(sessionBoundaryTimer);
  }
  const delay = nextSessionBoundary(Date.now()) - Date.now();
  sessionBoundaryTimer = window.setTimeout(() => {
    sessionBoundaryTimer = undefined;
    resetToFirstSignalState();
    scheduleSessionBoundaryReset();
  }, Math.max(delay, 0));
}

button.addEventListener('pointerdown', (event) => {
  lastPointerPosition = { x: event.clientX, y: event.clientY };
});

button.addEventListener('click', () => {
  if (button.disabled || !watcher) return;
  button.disabled = true;

  const isFirstSend = !hasEverSent;
  hasEverSent = true;

  // 自分が送った瞬間に「あなたが受信したホシミル信号」を 0 から数え直す（＝自分が watcher になる）。
  // 再送でも毎回ここでリセットされ、線の成長も 0 からやり直す。
  isCountingSinceSend = true;
  resetReceivedSignals();
  renderWatchingCount(); // 自分が watcher に加わったので人数表示を即時更新

  // 1. AudioContextをユーザー操作で有効化
  audioManager.unlock();

  // 送信音と、指先から光が離れる送信アニメーションをほぼ同時に開始する
  audioManager.playSend();
  const origin = getLaunchOrigin();
  lastPointerPosition = null;
  triggerLaunchParticle(origin);

  // 2. presence 上で自分の接続を sent:true にする（接続自体は読み込み時に登録済み）
  watcher.markSent();

  // 3. 新しいホシミル信号イベントを/signalsへ書き込む(初回・再送どちらでも毎回)
  watcher.sendSignal();
  // 信号送信が実行された瞬間に、最終送信時刻をlocalStorageへ保存する(初回・再送とも)。
  writeLastSignalAt(Date.now());
  trackEvent('signal_sent', { send_type: isFirstSend ? 'first' : 'resend' });

  // 4. 499秒後にまた送れるようにする
  scheduleResend();

  // 5. ボタンと同じ領域の表示を切り替える。初回・再送とも同じ遷移:
  //    idle → active(「空へ信号ヲ送信中」。送信演出中から表示) →
  //    送信演出(LAUNCH_DURATION_MS)が終わってさらに1〜2秒維持 →
  //    waiting(「誰カノ信号ヲ待ッテイマス」へ静かにクロスフェード)。
  //    そこから約8分19秒後、scheduleResendがidleへ戻して「モウイチド信号ヲ送ル」を出す。
  // 自分が送るときは、直前の受信一時表示が残っていても消す（active→waiting遷移で復活させない）。
  clearReceivedMessage();
  appEl.dataset.state = 'active';
  if (sendingHoldTimer !== undefined) window.clearTimeout(sendingHoldTimer);
  sendingHoldTimer = window.setTimeout(() => {
    sendingHoldTimer = undefined;
    if (appEl.dataset.state === 'active') {
      appEl.dataset.state = 'waiting';
    }
  }, LAUNCH_DURATION_MS + SENDING_HOLD_MS);
});

muteButton.addEventListener('click', () => {
  const muted = audioManager.toggleMute();
  muteButton.textContent = muted ? '音 OFF' : '音 ON';
  muteButton.setAttribute('aria-pressed', String(muted));
  trackEvent('mute_changed', { muted });
});

function openPrivacyModal(): void {
  privacyModal.hidden = false;
}

function closePrivacyModal(): void {
  privacyModal.hidden = true;
}

privacyLink.addEventListener('click', openPrivacyModal);
privacyModalClose.addEventListener('click', closePrivacyModal);
privacyModalBackdrop.addEventListener('click', closePrivacyModal);

async function init(): Promise<void> {
  try {
    // ページ読み込み時に匿名認証し、presence（接続数／送信済み数）と /signals を監視する。
    watcher = await watchHoshimiruSignal(
      { onPresenceChange: handlePresence },
      {
        onSignalReceived: () => {
          // ミュート中でも、信号そのものを受信した事実は計測する。
          trackEvent('signal_received');
          audioManager.playPon();
          flashNewSignal();
          // 待機中なら、この領域を約8秒間「ホシミル信号ヲ受信シマシタ」へ切り替える（表示のみ）。
          showReceivedMessage();
        },
      },
    );

    // 全員がまず接続として presence に登録される（通りすがり = sent:false）。
    // 他ユーザー側ではこの接続増加が「予感」として現れる。
    watcher.join();

    // 499秒以内のリロードで送信済み状態を復元した場合、presence 上も sent:true にする。
    // ここでは sendSignal を呼ばないため、他ユーザーへ新しいホシミル信号は通知されない。
    if (isCountingSinceSend) {
      watcher.markSent();
    }

    // 「誰カノ信号ヲ待ッテイマス」で待機中はボタンを出さない。残り時間経過後にscheduleResendが有効化する。
    if (appEl.dataset.state !== 'waiting') {
      button.disabled = false;
    }
  } catch (error) {
    console.error(error);
  }
}

restoreSignalState();

// 状態表示の初期描画（「—人」、および sessionStorage から復元した受信累計。
// 未送信かつ累計0のときは「この空で受信したホシミル信号」行は出さない）。
renderWatchingCount();
renderReceivedSince();

initAnalytics();
void init();
scheduleIdleNoise();
scheduleSessionBoundaryReset();

// URLに ?debug=1 が付いているときだけ、開発用のデバッグパネルを読み込む。
// 通常アクセスではこのチャンク自体が読み込まれず、presence/送受信にも一切触れない。
if (new URLSearchParams(window.location.search).get('debug') === '1') {
  void import('./debug-panel').then(({ mountDebugPanel }) => {
    mountDebugPanel({
      // 疑似受信も、実際の受信と同じ音＋ flashNewSignal() を呼ぶ。
      // （debug操作はユーザー操作なので、音の確認用に AudioContext を有効化しておく）
      simulateReceive: () => {
        audioManager.unlock();
        audioManager.playPon();
        flashNewSignal();
        showReceivedMessage();
      },
      // 疑似送信（自分を watcher 化）：Firebase書き込みは行わず、ローカルの状態だけ更新する。
      simulateSend: () => {
        audioManager.unlock();
        isCountingSinceSend = true;
        hasEverSent = true;
        resetReceivedSignals();
        renderWatchingCount();
      },
      // 「通りすがい」（接続だけの他者）の疑似増減。増えたら本番と同じ「予感」を出す。
      // Firebase は書き換えず、connected 表示と予感の確認用オフセットとして扱う。
      bumpConnected: (delta: number) => {
        audioManager.unlock();
        const before = Math.max(connectedOthers + debugConnectedOffset, 0);
        debugConnectedOffset += delta;
        if (Math.max(connectedOthers + debugConnectedOffset, 0) > before) triggerPremonition();
      },
      // 予感音の「短い」「長い」を視覚演出なしで直接鳴らす（本番のクールダウン状態には触れない）。
      testPremonitionSound: (kind: 'short' | 'B') => {
        audioManager.unlock();
        audioManager.playPremonitionNoise(kind);
      },
      // 疑似 watcher（送信済みの他者）の増減。人数表示にだけ効く（予感は出さない）。
      bumpWatcher: (delta: number) => {
        debugWatcherOffset += delta;
        renderWatchingCount();
      },
      // 6時間セッション境界の初期化だけを実行。受信累計(receivedTotalOnPage)は維持されるはず。
      simulateSessionReset: () => {
        resetToFirstSignalState();
      },
      reset: () => {
        isCountingSinceSend = false;
        hasEverSent = false;
        debugConnectedOffset = 0;
        debugWatcherOffset = 0;
        // debug のリセットだけは、確認用に閲覧セッションの受信累計も 0 に戻す
        // （本番の再送・6時間境界・リロードでは戻さない）。
        receivedTotalOnPage = 0;
        clearReceivedTotal();
        resetReceivedSignals();
        renderReceivedSince();
        renderWatchingCount();
      },
      getState: () => {
        const growth = lineGrowthFactor(receivedSignalCount);
        return {
          receivedSignalCount,
          receivedTotalOnPage,
          lineGrowthFactor: growth,
          steadyStrength: steadyLineStrength(growth),
          envFrequency: waveEnvFrequency(receivedSignalCount, growth),
          spanScale: waveSpanScale(receivedSignalCount, growth),
          // connected: 接続中の全員（他者 + 自分）。watchers: 送信済みの全員（他者 + 自分）。
          connected: hasPresenceData
            ? Math.max(connectedOthers + debugConnectedOffset, 0) + 1
            : null,
          watchers: watchersOthersEffective() + (isCountingSinceSend ? 1 : 0),
          selfSent: isCountingSinceSend,
        };
      },
    });
  });
}
