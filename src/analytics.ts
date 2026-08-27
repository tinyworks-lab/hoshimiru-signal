declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

// Google Analytics 4の測定ID。ここ1か所だけ設定すれば有効化される。
// .env(ローカル開発)や、GitHub Actionsのビルド時環境変数としてVITE_GA_MEASUREMENT_IDを
// 設定してください。未設定の場合、Analytics関連の処理はすべて何もせず終了する。
const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;

type EventParams = Record<string, string | number | boolean>;

let isScriptLoaded = false;

function loadGtagScript(measurementId: string): void {
  if (isScriptLoaded) return;
  isScriptLoaded = true;

  // GA4公式のgtag.jsスニペットとまったく同じ初期化手順。
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  // 標準スニペットどおり arguments オブジェクトをそのまま push する。
  // 配列に展開して push すると gtag.js がコマンドとして認識せず、collectが発生しない。
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };

  window.gtag('js', new Date());
  // 個人を特定する情報(uid・signalId・氏名・メール・位置情報など)は一切渡さない。
  // config実行時にpage_viewが自動送信される(send_page_viewのデフォルトはtrue)。
  window.gtag('config', measurementId);
}

/** ページ読み込み時に一度だけ呼ぶ。測定IDが未設定なら何もしない(エラーにもならない)。 */
export function initAnalytics(): void {
  if (!MEASUREMENT_ID) return;
  loadGtagScript(MEASUREMENT_ID);
}

/**
 * サービス改善用の行動データだけを送るイベント計測。
 * 測定IDが未設定、またはスクリプト読み込み前の場合は静かに何もしない。
 */
export function trackEvent(name: string, params?: EventParams): void {
  if (!MEASUREMENT_ID || typeof window.gtag !== 'function') return;
  window.gtag('event', name, params ?? {});
}
