// 開発用のデバッグパネル。?debug=1 のときだけ main.ts から動的 import される。
// 本番の presence / 送受信処理には一切触れず、疑似受信も実際の受信と同じ
// flashNewSignal() を呼ぶだけ（テスト専用の演出ロジックは持たない）。

export interface DebugPanelHandlers {
  /** 実際の受信と同じ flashNewSignal() を1回呼ぶ */
  simulateReceive: () => void;
  /** 疑似送信（自分を watcher 化）：Firebase書き込みなしでローカル状態だけ更新 */
  simulateSend: () => void;
  /** 「通りすがい」（接続だけの他者）の疑似増減。増えたら「予感」が出る */
  bumpConnected: (delta: number) => void;
  /** 疑似 watcher（送信済みの他者）の増減。人数表示にだけ効く */
  bumpWatcher: (delta: number) => void;
  /** カウント停止・疑似オフセット解除・線を初期状態へ */
  reset: () => void;
  /** 現在の内部状態を読み出す */
  getState: () => {
    receivedSignalCount: number;
    lineGrowthFactor: number;
    steadyStrength: number;
    envFrequency: number;
    spanScale: number;
    connected: number | null;
    watchers: number;
    selfSent: boolean;
  };
}

// 複数回の疑似受信を、指定間隔でflashNewSignalへ流し込む。
function burstReceive(handlers: DebugPanelHandlers, times: number, intervalMs: number): void {
  for (let i = 0; i < times; i += 1) {
    window.setTimeout(() => handlers.simulateReceive(), i * intervalMs);
  }
}

export function mountDebugPanel(handlers: DebugPanelHandlers): void {
  const panel = document.createElement('div');
  panel.setAttribute('data-debug-panel', '');
  Object.assign(panel.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '0',
    zIndex: '50',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 10px',
    background: 'rgba(6, 9, 16, 0.92)',
    borderTop: '1px solid #2a3150',
    font: '11px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif',
    color: '#9aa4bd',
    letterSpacing: '0.04em',
  } satisfies Partial<CSSStyleDeclaration>);

  const readout = document.createElement('span');
  Object.assign(readout.style, {
    marginLeft: 'auto',
    fontVariantNumeric: 'tabular-nums',
    color: '#7d8bb3',
  } satisfies Partial<CSSStyleDeclaration>);

  function makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    Object.assign(btn.style, {
      background: 'transparent',
      border: '1px solid #4a5578',
      color: '#e6e9f0',
      font: 'inherit',
      borderRadius: '999px',
      padding: '3px 10px',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);
    btn.addEventListener('click', onClick);
    return btn;
  }

  panel.append(
    makeButton('送信(watcher化)', () => handlers.simulateSend()),
    makeButton('信号を1件受信', () => handlers.simulateReceive()),
    makeButton('3件受信', () => burstReceive(handlers, 3, 600)),
    makeButton('10件受信', () => burstReceive(handlers, 10, 200)),
    makeButton('30件受信', () => burstReceive(handlers, 30, 90)),
    makeButton('通りすがい+1', () => handlers.bumpConnected(1)),
    makeButton('通りすがい-1', () => handlers.bumpConnected(-1)),
    makeButton('watcher+1', () => handlers.bumpWatcher(1)),
    makeButton('watcher-1', () => handlers.bumpWatcher(-1)),
    makeButton('リセット', () => handlers.reset()),
    readout,
  );

  function refreshReadout(): void {
    const state = handlers.getState();
    const connected = state.connected === null ? '—' : String(state.connected);
    readout.textContent =
      `connected: ${connected}　watchers: ${state.watchers}　selfSent: ${state.selfSent ? 'yes' : 'no'}` +
      `　sinceSend: ${state.receivedSignalCount}　growth: ${state.lineGrowthFactor.toFixed(3)}` +
      `　steady: ${state.steadyStrength.toFixed(3)}　env: ${state.envFrequency.toFixed(2)}` +
      `　span: ${state.spanScale.toFixed(2)}`;
  }

  refreshReadout();
  window.setInterval(refreshReadout, 200);

  document.body.appendChild(panel);
}
