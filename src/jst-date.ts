// 「今日確認されたホシミル信号」の集計日を、利用者の端末のタイムゾーンに依存せず
// 日本時間(Asia/Tokyo)基準で一意に決めるための日付処理。
// 日本にはサマータイムが無く、UTC+9で固定のため、Intl等を使わず単純な加減算で求められる。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 指定時刻(UTC epoch ms)が属する、日本時間でのカレンダー日付キー("YYYY-MM-DD")を返す。 */
export function jstDateKey(timestampMs: number): string {
  const jst = new Date(timestampMs + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 指定時刻より後にくる、直近の日本時間0:00(UTC epoch ms)を返す。
 * 開いたままのページで、日付が変わった瞬間に集計対象日を切り替えるための setTimeout に使う。
 */
export function nextJstMidnight(timestampMs: number): number {
  const jst = new Date(timestampMs + JST_OFFSET_MS);
  const nextMidnightInShiftedFrame = Date.UTC(
    jst.getUTCFullYear(),
    jst.getUTCMonth(),
    jst.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return nextMidnightInShiftedFrame - JST_OFFSET_MS;
}
