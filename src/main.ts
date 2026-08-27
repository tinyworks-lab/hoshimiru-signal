import './style.css';
import { initAnalytics, trackEvent } from './analytics';
import { AudioManager } from './audio';
import type { HoshimiruWatcher } from './presence';
import { watchHoshimiruSignal } from './presence';
import { isSameSessionWindow, nextSessionBoundary } from './session-window';

const appEl = document.getElementById('app') as HTMLDivElement;
const button = document.getElementById('signal-button') as HTMLButtonElement;
const lineEl = document.getElementById('signal-line') as unknown as SVGPathElement;
const glowEl = document.getElementById('signal-glow') as unknown as SVGCircleElement;
const countEl = document.getElementById('count-display') as HTMLParagraphElement;
const countTextEl = document.getElementById('count-text') as HTMLSpanElement;
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

let latestCount = 0;
let hasSentSignal = false;
let isReceiving = false;
let watcher: HoshimiruWatcher | null = null;
let lastPointerPosition: { x: number; y: number } | null = null;
let waveAnimationFrame: number | undefined;
let resendTimer: number | undefined;
let sendingHoldTimer: number | undefined;
// 開いたまま6時間セッション境界(04/10/16/22時)を迎えたときに初回状態へ戻すためのタイマー。
let sessionBoundaryTimer: number | undefined;

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
// 文字列を差し替える前に、.count-swapping で opacity を下げ切るまで待つ時間。
// CSSのフェードアウト(通常0.15s / reduced 0.08s)より少しだけ長くとる。
const COUNT_FADE_OUT_MS = prefersReducedMotion ? 90 : 170;

let countSwapTimer: number | undefined;
// 現在.count-textに表示している文字列(HTML)。同じ内容での無駄な再フェードを防ぐ。
let currentCountHtml = '';

/**
 * 人数表示のテキストを、親(.count)のopacityによるクロスフェードで切り替える。
 * フェードアウト → 見えない状態で文字列と呼吸クラスを更新 → フェードイン、の順。
 * 文字列が変わる瞬間がユーザーから見えないようにして、1フレームだけ古い体裁が残る現象を防ぐ。
 */
function setCountDisplay(html: string, live: boolean): void {
  if (html === currentCountHtml) {
    // 文字列は同じで呼吸の有無だけ変わる場合。
    countTextEl.classList.toggle('is-live', live);
    return;
  }

  const isInitial = currentCountHtml === '';
  currentCountHtml = html;

  if (countSwapTimer !== undefined) {
    window.clearTimeout(countSwapTimer);
    countSwapTimer = undefined;
  }

  if (isInitial) {
    // 初回表示はフェードなしで即時に出す（空文字からの切り替えを見せる必要はない）。
    countTextEl.innerHTML = html;
    countTextEl.classList.toggle('is-live', live);
    return;
  }

  // 1. 現在の表示をフェードアウト
  countEl.classList.add('is-swapping');
  countSwapTimer = window.setTimeout(() => {
    countSwapTimer = undefined;
    // 2. 見えない状態で文字列と呼吸アニメーションを更新
    countTextEl.innerHTML = html;
    countTextEl.classList.toggle('is-live', live);
    // 3. フェードイン
    countEl.classList.remove('is-swapping');
  }, COUNT_FADE_OUT_MS);
}

function applyCountText(count: number): void {
  if (count === 0) {
    // 自分がまだ送っていない0人と、送信済みで本当に自分だけ(独り占め)の0人を区別する。
    const html = hasSentSignal
      ? 'ホシミル信号ハアリマセン<br />夜空ヲ独リ占メシテイマス'
      : 'ホシミル信号ハアリマセン';
    // 0人表示はリアルタイムな人数ではないため、呼吸アニメーションは付けない。
    setCountDisplay(html, false);
  } else {
    // N人受信のときだけ、ゆっくりした呼吸アニメーションを有効にする。
    setCountDisplay(`ホシミル信号　${count}人受信`, true);
  }
}

function renderCount(count: number): void {
  latestCount = count;
  if (isReceiving) return; // 受信演出の表示中は上書きしない
  applyCountText(count);
}

// 新しいuidを検知したときだけの、本当の受信信号。
// 中心の鋭い主ピークから外側へ向かって、中程度→小さな振れへと滑らかに減衰しながら
// 前後に広がる「とがった」形を、線の左端付近から右端へ一度だけ伝播させる。
const WAVE_OFFSETS: Array<{ dx: number; dyFactor: number }> = [
  { dx: -28, dyFactor: 0 },
  { dx: -20, dyFactor: -0.08 },
  { dx: -14, dyFactor: 0.06 },
  { dx: -9, dyFactor: -0.22 },
  { dx: -4, dyFactor: 0.12 },
  { dx: -1.5, dyFactor: -0.55 },
  { dx: 0, dyFactor: -1 },
  { dx: 2, dyFactor: 0.7 },
  { dx: 6, dyFactor: -0.3 },
  { dx: 11, dyFactor: 0.15 },
  { dx: 18, dyFactor: -0.08 },
  { dx: 28, dyFactor: 0 },
];
const WAVE_AMPLITUDE = 30; // 待機ノイズとは別に、本当の受信時だけさらに大きくする
const WAVE_EDGE_FADE_FRACTION = 0.12;

function animateReceivedWave(onComplete: () => void): void {
  const startTime = performance.now();
  const travelStart = LINE_LEFT - WAVE_TRAVEL_MARGIN;
  const travelEnd = LINE_RIGHT + WAVE_TRAVEL_MARGIN;

  // 待機中の光点フラッシュが途中であれば打ち切り、発光は線全体側(is-pulsing)に一本化する。
  glowEl.classList.remove('is-flashing');

  function step(now: number): void {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / WAVE_DURATION_MS, 1);
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
    lineEl.setAttribute('d', buildLinePath(centerX, WAVE_AMPLITUDE * ampScale, WAVE_OFFSETS));

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
  // 「ホシミル信号ヲ受信」への切り替えもクロスフェードで行う。呼吸(is-live)はfalseで外れる。
  setCountDisplay('ホシミル信号ヲ受信', false);
  isReceiving = true;
  lineEl.classList.add('is-pulsing'); // 受信の瞬間、線全体をすっと明るくする

  animateReceivedWave(() => {
    isReceiving = false;
    lineEl.classList.remove('is-pulsing'); // 約1秒かけて通常の淡さへ戻る(CSS側のtransitionで実現)
    // 「ホシミル信号ヲ受信」→「ホシミル信号　N人受信」へも同じクロスフェードで戻す。
    applyCountText(latestCount);
  });
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
// 戻り値のneedsPresenceRejoinがtrueなら、そのユーザーはまだ空を見ている扱いとして
// presenceへ再参加させる（新しい/signalsイベントは送らない）。
function restoreSignalState(): { needsPresenceRejoin: boolean } {
  const lastSignalAt = readLastSignalAt();
  if (lastSignalAt === null) {
    // 最終送信記録なし。通常どおり「信号ヲ送ル」を表示する。
    return { needsPresenceRejoin: false };
  }

  const now = Date.now();

  // 最後に送信した時刻と現在時刻が別の6時間セッション区間なら、前回の送信記録を無効化し、
  // UI上は完全に初回状態(「信号ヲ送ル」)として扱う。経過時間(8分19秒)は見ない。
  if (!isSameSessionWindow(lastSignalAt, now)) {
    clearLastSignalAt();
    return { needsPresenceRejoin: false };
  }

  const elapsed = now - lastSignalAt;

  if (elapsed >= RESEND_INTERVAL_MS) {
    // 499000ms以上経過。「モウイチド信号ヲ送ル」を表示する。
    button.textContent = 'モウイチド信号ヲ送ル';
    appEl.dataset.state = 'idle';
    return { needsPresenceRejoin: false };
  }

  // 499000ms未満。ボタンは出さず「誰カノ信号ヲ待ッテイマス」を表示し、残り時間だけ待つ。
  hasSentSignal = true;
  button.disabled = true;
  appEl.dataset.state = 'waiting';
  const remainingMs = Math.min(RESEND_INTERVAL_MS - elapsed, RESEND_INTERVAL_MS);
  scheduleResend(remainingMs);
  return { needsPresenceRejoin: true };
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

  hasSentSignal = false;
  button.textContent = '信号ヲ送ル';
  button.disabled = false;
  appEl.dataset.state = 'idle';

  // 「夜空ヲ独リ占メシテイマス」など初回状態と異なる文言を、受信演出中でなければ戻す。
  if (!isReceiving) applyCountText(latestCount);
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
  hasSentSignal = true;
  if (!isReceiving) applyCountText(latestCount);

  // 1. AudioContextをユーザー操作で有効化
  audioManager.unlock();

  // 送信音と、指先から光が離れる送信アニメーションをほぼ同時に開始する
  audioManager.playSend();
  const origin = getLaunchOrigin();
  lastPointerPosition = null;
  triggerLaunchParticle(origin);

  // 2. 自分の接続をpresenceへ参加させる(初回のみ実際に書き込まれる。再送では何もしない)
  const isFirstSend = watcher.join();

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
    // ページ読み込み時に匿名認証し、自分はまだ送信者にならずに現在人数だけを監視する。
    // 受信演出は/signalsの新規イベントだけをトリガーにし、presenceの人数とは切り離す。
    watcher = await watchHoshimiruSignal(
      { onCountChange: renderCount },
      {
        onSignalReceived: () => {
          // ミュート中でも、信号そのものを受信した事実は計測する。
          trackEvent('signal_received');
          audioManager.playPon();
          flashNewSignal();
        },
      },
    );

    if (restoredState.needsPresenceRejoin) {
      // 499秒以内にリロードしたユーザーは今も空を見ている扱い。presenceへ復帰だけさせる。
      // ここではsendSignalを呼ばないため、他のユーザーへ新しいホシミル信号は通知されない。
      watcher.join();
    }

    // 「誰カノ信号ヲ待ッテイマス」で待機中はボタンを出さない。残り時間経過後にscheduleResendが有効化する。
    if (appEl.dataset.state !== 'waiting') {
      button.disabled = false;
    }
  } catch (error) {
    console.error(error);
  }
}

const restoredState = restoreSignalState();

initAnalytics();
void init();
scheduleIdleNoise();
scheduleSessionBoundaryReset();
