// 「初回送信状態」を6時間ごとに初期化するためのセッション区間ロジック。
//
// ローカル時間で毎日 04:00 / 10:00 / 16:00 / 22:00 の4回、新しい区間へ切り替わる。
//   04:00以上〜10:00未満
//   10:00以上〜16:00未満
//   16:00以上〜22:00未満
//   22:00以上〜翌04:00未満（日付をまたぐ）
//
// 「同じ日か」ではなく「同じ6時間区間か」で判定する。判定は各時刻について
// 「直前のリセット境界時刻」を求め、それが一致するかどうかで行う。

// セッションが切り替わるローカル時刻(時)。昇順。
export const SESSION_RESET_HOURS = [4, 10, 16, 22] as const;

/**
 * 指定時刻が属する6時間セッション区間の「開始境界時刻」(直前のリセット境界)を
 * ローカル時間のミリ秒で返す。
 *
 * 00:00〜03:59 は前日の 22:00 が開始境界になる（22:00〜翌04:00 の区間が日付をまたぐため）。
 */
export function sessionWindowStart(timestamp: number): number {
  const d = new Date(timestamp);
  const hour = d.getHours();

  let boundaryHour: number;
  let dayOffset = 0;

  if (hour >= 22) {
    boundaryHour = 22;
  } else if (hour >= 16) {
    boundaryHour = 16;
  } else if (hour >= 10) {
    boundaryHour = 10;
  } else if (hour >= 4) {
    boundaryHour = 4;
  } else {
    // 00:00〜03:59 は前日 22:00 の区間に属する。
    boundaryHour = 22;
    dayOffset = -1;
  }

  const start = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + dayOffset,
    boundaryHour,
    0,
    0,
    0,
  );
  return start.getTime();
}

/**
 * 2つの時刻が同じ6時間セッション区間に属するかどうか。
 * 直前のリセット境界時刻が一致すれば同一区間。
 */
export function isSameSessionWindow(a: number, b: number): boolean {
  return sessionWindowStart(a) === sessionWindowStart(b);
}

/**
 * 指定時刻より後にくる、最初のセッション境界時刻(ミリ秒)を返す。
 * ちょうど境界時刻を指定した場合は、その次の境界を返す。
 * 開いたままのページで、次の境界まで setTimeout する際に使う。
 */
export function nextSessionBoundary(timestamp: number): number {
  const d = new Date(timestamp);
  const hour = d.getHours();

  let nextHour: number;
  let dayOffset = 0;

  if (hour < 4) {
    nextHour = 4;
  } else if (hour < 10) {
    nextHour = 10;
  } else if (hour < 16) {
    nextHour = 16;
  } else if (hour < 22) {
    nextHour = 22;
  } else {
    // 22:00〜23:59 の次の境界は翌日 04:00。
    nextHour = 4;
    dayOffset = 1;
  }

  const next = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + dayOffset,
    nextHour,
    0,
    0,
    0,
  );
  return next.getTime();
}
