import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// basicSsl()は開発サーバー(vite dev)だけに効く自己署名証明書プラグイン。
// vite buildの出力(本番ビルド/GitHub Pages配信物)には一切影響しない。
// スマホ実機でScreen Wake Lock API等のSecure Context限定機能を検証するために追加。
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
});
