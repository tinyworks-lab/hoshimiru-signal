import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';

// Firebaseコンソールの「プロジェクトの設定」から取得した値に置き換えてください。
// これらの値は公開されて問題ない設定情報です（アクセス制御はSecurity Rules側で行います）。
const firebaseConfig = {
  apiKey: 'AIzaSyD0xvA5evZkXnkb5_4aTkM_q6qfoDqBt64',
  authDomain: 'hoshimiru-signal.firebaseapp.com',
  databaseURL: 'https://hoshimiru-signal-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'hoshimiru-signal',
  storageBucket: 'hoshimiru-signal.firebasestorage.app',
  messagingSenderId: '303149624463',
  appId: '1:303149624463:web:cc9e459bcb1a1edf7d54fa',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
