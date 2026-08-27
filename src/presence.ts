import { signInAnonymously } from 'firebase/auth';
import { get, onChildAdded, onDisconnect, onValue, push, ref, remove, serverTimestamp, set } from 'firebase/database';
import { auth, db } from './firebase';

// presenceに参加している間、この間隔で自分の接続のlastSeenをサーバー時刻に更新する。
const HEARTBEAT_INTERVAL_MS = 30000;
// lastSeenがサーバー現在時刻からこれ以上古い接続は「異常に残ったゴースト」とみなし、人数から除外する。
const PRESENCE_INACTIVE_MS = 90000;

export interface PresenceCallbacks {
  /** 自分以外でpresenceに存在するuidの数が変化するたびに呼ばれる */
  onCountChange: (count: number) => void;
}

export interface SignalCallbacks {
  /** 自分以外のuidから新しいホシミル信号(/signals)が届いたときに呼ばれる */
  onSignalReceived: () => void;
}

export interface HoshimiruWatcher {
  /**
   * 最初に「信号ヲ送ル」が押されたときに呼ぶ。自分の接続をpresenceへ書き込み、参加者になる。
   * 2回目以降は何もせず、実際に参加した場合はtrue、既に参加済みで何もしなかった場合はfalseを返す。
   */
  join: () => boolean;
  /** 「信号ヲ送ル」/「モウイチド信号ヲ送ル」を押すたびに呼ぶ。/signalsへ新しいイベントを1件書き込む。 */
  sendSignal: () => void;
}

// 送信者自身が、書き込んだ自分のsignalイベントを一定時間後に削除する。
// 履歴として残す必要がないため、これだけで/signalsが際限なく溜まり続けるのを防げる。
const SIGNAL_CLEANUP_DELAY_MS = 20000;

/**
 * ページ読み込み時に呼ぶ。匿名認証を行い、
 * - presence（現在人数の把握だけに使う）
 * - signals（「本当にホシミル信号が送られた」という瞬間的なイベントだけに使う）
 * の両方の監視を開始する。この時点では自分はpresenceにもsignalsにも書き込まない。
 */
export async function watchHoshimiruSignal(
  presenceCallbacks: PresenceCallbacks,
  signalCallbacks: SignalCallbacks,
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

  // --- presence: 「今このページで空を見ている人」の現在人数だけを把握する ---
  const presenceRef = ref(db, 'presence');
  onValue(presenceRef, (snapshot) => {
    const raw = (snapshot.val() ?? {}) as Record<string, Record<string, unknown> | null>;
    let count = 0;
    for (const [uid, connections] of Object.entries(raw)) {
      if (uid === myUid) continue; // 自分自身は受信人数から除外
      if (!connections || typeof connections !== 'object') continue;
      // 同一uid配下に90秒以内の接続が1つでもあれば1人。すべて古ければ数えない（複数タブは1人のまま）。
      if (Object.values(connections).some(isConnectionActive)) count += 1;
    }
    presenceCallbacks.onCountChange(count);
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

  let hasJoinedPresence = false;
  let myConnectionRef: ReturnType<typeof push> | null = null;
  let heartbeatTimer: number | undefined;

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

  function join(): boolean {
    if (hasJoinedPresence) return false;
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
          // 値は {lastSeen: サーバー時刻}。端末の時計には依存しない。
          set(connectionRef, { lastSeen: serverTimestamp() });
          cleanupMyStaleConnections(connectionRef.key);
        });
    });

    // heartbeat: 参加中は一定間隔でlastSeenをサーバー時刻へ更新し続ける。
    // onDisconnectで消えなかったゴーストは、更新が止まって90秒経てば人数から外れる。
    if (heartbeatTimer === undefined) {
      heartbeatTimer = window.setInterval(() => {
        if (myConnectionRef) {
          set(myConnectionRef, { lastSeen: serverTimestamp() }).catch(() => {});
        }
      }, HEARTBEAT_INTERVAL_MS);
    }

    return true;
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
  }

  return { join, sendSignal };
}
