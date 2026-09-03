import { signInAnonymously } from 'firebase/auth';
import {
  get,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
} from 'firebase/database';
import { auth, db } from './firebase';
import { jstDateKey, nextJstMidnight } from './jst-date';

// presenceに参加している間、この間隔で自分の接続のlastSeenをサーバー時刻に更新する。
const HEARTBEAT_INTERVAL_MS = 30000;
// lastSeenがサーバー現在時刻からこれ以上古い接続は「異常に残ったゴースト」とみなし、人数から除外する。
const PRESENCE_INACTIVE_MS = 90000;

/** presence 集計結果。いずれも「自分以外」の人数。自分ぶんは表示側でローカル状態から加算する。 */
export interface PresenceSnapshot {
  /** 現在ページに接続しているだけの人も含む、自分以外のuid数（「予感」に使う）。 */
  connectedOthers: number;
  /** そのうち、実際に信号を送った（sent=true の接続を持つ）自分以外のuid数（人数表示に使う）。 */
  watchersOthers: number;
}

export interface PresenceCallbacks {
  /** presence（接続数 / 送信済み数）が変化するたびに呼ばれる。 */
  onPresenceChange: (snapshot: PresenceSnapshot) => void;
}

export interface SignalCallbacks {
  /** 自分以外のuidから新しいホシミル信号(/signals)が届いたときに呼ばれる */
  onSignalReceived: () => void;
}

export interface DailySignalCallbacks {
  /**
   * 「今日(日本時間)ホシミル信号を送ったユニークUID数」が変わるたびに呼ばれる
   * （日付が変わって集計対象日を切り替えたときも呼ばれる）。
   */
  onDailySignalCountChange: (count: number) => void;
}

export interface HoshimiruWatcher {
  /**
   * ページ接続時に一度だけ呼ぶ。自分の接続を presence へ sent:false（通りすがい）として登録する。
   * 2回目以降は何もしない。
   */
  join: () => void;
  /** 「信号ヲ送ル」を押したとき／復元で送信済み扱いのときに呼ぶ。自分の接続を sent:true にする。 */
  markSent: () => void;
  /** 6時間セッション境界で送信前状態へ戻すときに呼ぶ。自分の接続を sent:false へ戻す。 */
  markUnsent: () => void;
  /** 「信号ヲ送ル」/「モウイチド信号ヲ送ル」を押すたびに呼ぶ。/signalsへ新しいイベントを1件書き込む。 */
  sendSignal: () => void;
}

// 送信者自身が、書き込んだ自分のsignalイベントを一定時間後に削除する。
// 履歴として残す必要がないため、これだけで/signalsが際限なく溜まり続けるのを防げる。
const SIGNAL_CLEANUP_DELAY_MS = 20000;

/**
 * ページ読み込み時に呼ぶ。匿名認証を行い、
 * - presence（接続数と、そのうち信号を送った人数の把握に使う）
 * - signals（「本当にホシミル信号が送られた」という瞬間的なイベントだけに使う）
 * - dailySignals（「今日(日本時間)ホシミル信号を送ったユニークUID数」の把握に使う）
 * の監視を開始する。この時点では自分はpresenceにもsignalsにもdailySignalsにも書き込まない。
 */
export async function watchHoshimiruSignal(
  presenceCallbacks: PresenceCallbacks,
  signalCallbacks: SignalCallbacks,
  dailySignalCallbacks: DailySignalCallbacks,
): Promise<HoshimiruWatcher> {
  const credential = await signInAnonymously(auth);
  const myUid = credential.user.uid;

  // 端末の時計に依存せずサーバー現在時刻を推定するためのオフセット（サーバー時刻 = Date.now() + offset）。
  let serverTimeOffset = 0;
  onValue(ref(db, '.info/serverTimeOffset'), (snapshot) => {
    const value = snapshot.val();
    if (typeof value === 'number') serverTimeOffset = value;
  });
  const serverNow = (): number => Date.now() + serverTimeOffset;

  // 1つの接続がまだアクティブか（lastSeenがサーバー現在時刻から90秒以内か）を判定する。
  // 旧形式（値がtrueのみでlastSeenを持たない接続）はlastSeen不明のためinactive扱いにする。
  function isConnectionActive(connectionValue: unknown): boolean {
    if (!connectionValue || typeof connectionValue !== 'object') return false;
    const lastSeen = (connectionValue as { lastSeen?: unknown }).lastSeen;
    if (typeof lastSeen !== 'number') return false;
    return serverNow() - lastSeen < PRESENCE_INACTIVE_MS;
  }

  // その接続が「信号を送った人」の接続か（sent === true か）。
  function isSentConnection(connectionValue: unknown): boolean {
    return (
      !!connectionValue &&
      typeof connectionValue === 'object' &&
      (connectionValue as { sent?: unknown }).sent === true
    );
  }

  // --- presence: 「今このページに接続している人」と「そのうち信号を送った人」を数える ---
  const presenceRef = ref(db, 'presence');
  onValue(presenceRef, (snapshot) => {
    const raw = (snapshot.val() ?? {}) as Record<string, Record<string, unknown> | null>;
    let connectedOthers = 0;
    let watchersOthers = 0;
    for (const [uid, connections] of Object.entries(raw)) {
      if (uid === myUid) continue; // 自分自身は集計から除外（表示側でローカル状態から加算）
      if (!connections || typeof connections !== 'object') continue;
      const activeConnections = Object.values(connections).filter(isConnectionActive);
      if (activeConnections.length === 0) continue; // 90秒以内の接続が1つも無ければ数えない
      connectedOthers += 1;
      if (activeConnections.some(isSentConnection)) watchersOthers += 1;
    }
    presenceCallbacks.onPresenceChange({ connectedOthers, watchersOthers });
  });

  // --- signals: 「誰かが今、ホシミル信号を送った」という瞬間的なイベントだけを監視する ---
  // ページ読み込み時点で既に存在していたイベントは無視し、この後新しく追加されたものだけに反応する。
  const signalsRef = ref(db, 'signals');
  const existingSignalKeys = new Set<string>();

  get(signalsRef)
    .then((snapshot) => {
      snapshot.forEach((child) => {
        existingSignalKeys.add(child.key ?? '');
        return false;
      });

      onChildAdded(signalsRef, (child) => {
        const key = child.key ?? '';
        if (existingSignalKeys.has(key)) {
          // 読み込み時点で既に存在していたイベント。初回の通知だけ無視する。
          existingSignalKeys.delete(key);
          return;
        }

        const value = child.val() as { uid?: string } | null;
        if (!value || value.uid === myUid) return; // 自分自身の信号では受信演出を出さない

        signalCallbacks.onSignalReceived();
      });
    })
    .catch((error) => {
      console.error(error);
    });

  // --- dailySignals: 「今日(日本時間)ホシミル信号を送ったユニークUID数」を数える ---
  // dailySignals/{YYYY-MM-DD(JST)}/{uid} = true という単純な集合として持つ。
  // 送信のたびに自分のuidキーへtrueを書く「べき等な」set()だけで済ませ、
  // 個数は子キー数（＝ユニークUID数）をそのまま使う。専用のカウンタを別途持たないため、
  // 「読んでから+1して書き戻す」ような競合状態が原理的に発生しない
  // （再送信・複数タブからの同時送信のいずれも、同じuidキーへの同じ値の上書きにしかならない）。
  let dailySignalsUnsubscribe: (() => void) | undefined;

  function subscribeDailySignals(): void {
    if (dailySignalsUnsubscribe) dailySignalsUnsubscribe();
    const dateKey = jstDateKey(Date.now());
    dailySignalsUnsubscribe = onValue(ref(db, `dailySignals/${dateKey}`), (snapshot) => {
      const raw = snapshot.val() as Record<string, unknown> | null;
      dailySignalCallbacks.onDailySignalCountChange(raw ? Object.keys(raw).length : 0);
    });
  }

  // 開いたまま日本時間の日付が変わったら、購読先を新しい日付のノードへ切り替える。
  function scheduleDailySignalsRollover(): void {
    const delay = Math.max(nextJstMidnight(Date.now()) - Date.now(), 0);
    window.setTimeout(() => {
      subscribeDailySignals();
      scheduleDailySignalsRollover();
    }, delay);
  }

  subscribeDailySignals();
  scheduleDailySignalsRollover();

  let hasJoinedPresence = false;
  let myConnectionRef: ReturnType<typeof push> | null = null;
  let heartbeatTimer: number | undefined;
  // 自分の接続の sent 状態（true=信号送信済み）。heartbeat / 再接続時の書き込みで維持する。
  let mySent = false;

  // 自分のuid配下だけを走査し、今の接続以外で古くなった（またはlastSeenを持たない）
  // ゴースト接続を削除する。他人のuid配下には一切触れない（Security Rules上も書けない）。
  function cleanupMyStaleConnections(currentKey: string | null): void {
    get(ref(db, `presence/${myUid}`))
      .then((snapshot) => {
        snapshot.forEach((child) => {
          if (child.key && child.key !== currentKey && !isConnectionActive(child.val())) {
            remove(child.ref);
          }
          return false;
        });
      })
      .catch((error) => {
        console.error(error);
      });
  }

  function join(): void {
    if (hasJoinedPresence) return;
    hasJoinedPresence = true;

    // 接続状態を監視し、(再)接続のたびに自分の接続を presence/{uid}/{connectionId} として登録する。
    // 同じuidのまま複数タブを開いても、タブごとに別のconnectionIdが発行される。
    const connectedRef = ref(db, '.info/connected');
    onValue(connectedRef, (snapshot) => {
      if (snapshot.val() !== true) return;

      const connectionRef = push(ref(db, `presence/${myUid}`));
      myConnectionRef = connectionRef;
      // 切断（タブを閉じる・リロード・回線切断など）を検知したらサーバー側が自動的に削除する。
      onDisconnect(connectionRef)
        .remove()
        .then(() => {
          // 値は {lastSeen: サーバー時刻, sent: 送信済みか}。端末の時計には依存しない。
          set(connectionRef, { lastSeen: serverTimestamp(), sent: mySent });
          cleanupMyStaleConnections(connectionRef.key);
        });
    });

    // heartbeat: 参加中は一定間隔でlastSeenをサーバー時刻へ更新し続ける（sent状態は維持）。
    // onDisconnectで消えなかったゴーストは、更新が止まって90秒経てば人数から外れる。
    if (heartbeatTimer === undefined) {
      heartbeatTimer = window.setInterval(() => {
        if (myConnectionRef) {
          set(myConnectionRef, { lastSeen: serverTimestamp(), sent: mySent }).catch(() => {});
        }
      }, HEARTBEAT_INTERVAL_MS);
    }
  }

  function markSent(): void {
    mySent = true;
    if (myConnectionRef) {
      update(myConnectionRef, { sent: true, lastSeen: serverTimestamp() }).catch(() => {});
    }
  }

  function markUnsent(): void {
    mySent = false;
    if (myConnectionRef) {
      update(myConnectionRef, { sent: false, lastSeen: serverTimestamp() }).catch(() => {});
    }
  }

  function sendSignal(): void {
    const signalRef = push(signalsRef);

    // 書き込む前にonDisconnectを登録しておくことで、書き込み直後にタブが
    // 閉じられた場合でもサーバー側が自分のsignalを片付けてくれる。
    onDisconnect(signalRef).remove();

    set(signalRef, { uid: myUid, timestamp: serverTimestamp() });

    // 通常は、履歴として残す必要がないので約20秒後に自分で片付ける。
    window.setTimeout(() => {
      remove(signalRef);
    }, SIGNAL_CLEANUP_DELAY_MS);

    // 「今日確認されたホシミル信号」用。同じuid・同じ日付キーへのtrue上書きになるだけなので、
    // 初回送信・8分19秒後の再送信のどちらで呼ばれてもユニークUID数は増えない（べき等）。
    set(ref(db, `dailySignals/${jstDateKey(Date.now())}/${myUid}`), true).catch((error) => {
      console.error(error);
    });
  }

  return { join, markSent, markUnsent, sendSignal };
}
