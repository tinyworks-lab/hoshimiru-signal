// 信号送信後の受信待機中に画面がスリープしにくくなるようにする、Screen Wake Lock APIの
// 薄いラッパー。非対応ブラウザ・取得失敗時は例外を投げず静かにフォールバックし、
// 既存の送受信・presence・音・UI等には一切影響しない（呼び出し側はenable/disableを
// 呼ぶだけでよい）。
//
// iOS Safari向けの既知の制約: WebKitはvisibilitychange等（ユーザー操作を伴わない文脈）
// からのnavigator.wakeLock.request()を拒否することがある（例外はNotAllowedError）。
// そのため、タブ復帰直後の自動再取得が失敗した場合だけ、次の実際のタップ(pointerdown)を
// 待ってから1回だけ再取得を試みるフォールバックを持つ。常時リスナーを張りっぱなしには
// せず、失敗したときだけ一時的に1つだけ armし、発火または不要になった時点で必ず外す。

export interface WakeLockController {
  /** 受信待機状態になったときに呼ぶ。対応していれば取得を試みる（非同期・失敗しても例外を投げない）。 */
  enable: () => void;
  /** 受信待機状態でなくなったときに呼ぶ。保持していれば解放する。 */
  disable: () => void;
  /** ?debug=1 診断用。現在の状態を返す。副作用なし。 */
  getDebugState: () => { supported: boolean; active: boolean; lastFailureReason: string | null };
}

// タブ復帰直後の自動再取得が失敗したときだけ、次のこのイベントで再試行する。
const GESTURE_RETRY_EVENT = 'pointerdown';

/** ページに1つだけ作って使う想定。main.tsからenable()/disable()を呼ぶだけでよい。 */
export function createWakeLockController(): WakeLockController {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  // 「受信待機状態のつもりか」を表す意図フラグ。実際にロックを保持できているかどうか
  // (sentinel)とは別に持つことで、取得に失敗していても後から（visibilitychange等で）
  // 再試行できるようにする。
  let wantsWakeLock = false;
  let sentinel: WakeLockSentinel | null = null;
  // request()が進行中に重ねてrequestしない（連続request防止）ためのフラグ。
  let isRequesting = false;
  // 直近のrequest失敗理由（?debug=1のパネル表示専用。ロジックには使わない）。
  let lastFailureReason: string | null = null;
  // 「ユーザー操作なしでの再取得が拒否された」場合にだけ立てる、1回限りの保留中リスナー。
  let pendingGestureRetry: (() => void) | null = null;

  function clearPendingGestureRetry(): void {
    if (!pendingGestureRetry) return;
    document.removeEventListener(GESTURE_RETRY_EVENT, pendingGestureRetry);
    pendingGestureRetry = null;
  }

  // 直前のrequest()がユーザー操作の文脈でなかったために拒否された可能性があるときだけ呼ぶ。
  // 既に保留中のリスナーがあれば増やさず、次に実際にユーザーが画面へ触れた瞬間1回だけ
  // requestWakeLock()を再試行する（常時監視はしない＝リスナーの張りっぱなしを避ける）。
  function armGestureRetry(): void {
    if (pendingGestureRetry || !wantsWakeLock) return;
    const handler = (): void => {
      clearPendingGestureRetry();
      void requestWakeLock();
    };
    pendingGestureRetry = handler;
    document.addEventListener(GESTURE_RETRY_EVENT, handler, { once: true, passive: true });
  }

  async function requestWakeLock(): Promise<void> {
    if (!supported || sentinel || isRequesting || !wantsWakeLock) return;
    isRequesting = true;
    try {
      const acquired = await navigator.wakeLock.request('screen');
      isRequesting = false;
      lastFailureReason = null;
      clearPendingGestureRetry();
      // 取得完了までの間にdisable()されていたら、保持し続けずすぐ手放す。
      if (!wantsWakeLock) {
        void acquired.release();
        return;
      }
      sentinel = acquired;
      // タブが非表示になった場合などブラウザ側で自動解放されることがある。
      // その際はこちらの参照もクリアし、visible に戻ったときの再取得判定に使う。
      sentinel.addEventListener('release', () => {
        if (sentinel === acquired) sentinel = null;
      });
    } catch (error) {
      // 非対応・許可なし・取得失敗はすべてアプリ全体には波及させない。
      isRequesting = false;
      lastFailureReason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // iOS Safari等、ユーザー操作を伴わない文脈（visibilitychange等）からの再取得は
      // 拒否されることがある。まだ受信待機状態が続いているなら、次の実際のタップで
      // 改めて1回だけ試す（無条件の連続requestやポーリングはしない）。
      if (wantsWakeLock) armGestureRetry();
    }
  }

  function enable(): void {
    wantsWakeLock = true;
    void requestWakeLock();
  }

  function disable(): void {
    wantsWakeLock = false;
    clearPendingGestureRetry();
    if (sentinel) {
      const current = sentinel;
      sentinel = null;
      void current.release();
    }
  }

  if (supported) {
    // タブが非表示→表示に戻ったとき、まだ受信待機中(wantsWakeLock)かつ
    // ロックを保持できていなければ、再取得を試みる。
    // requestWakeLock自体がsentinel/isRequesting/wantsWakeLockで多重実行を防ぐため、
    // visibilitychangeが何度発火しても連続requestや無限ループにはならない。
    const tryReacquire = (): void => {
      if (document.visibilityState === 'visible' && wantsWakeLock && !sentinel) {
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', tryReacquire);
    // 一部のブラウザ環境ではvisibilitychangeだけでは復帰を検知しづらい場合があるための保険。
    // tryReacquire自体は上と同じ多重実行防止ガードを通るため、二重発火しても害はない。
    window.addEventListener('focus', tryReacquire);
    window.addEventListener('pageshow', tryReacquire);
  }

  return {
    enable,
    disable,
    getDebugState: () => ({ supported, active: sentinel !== null, lastFailureReason }),
  };
}
