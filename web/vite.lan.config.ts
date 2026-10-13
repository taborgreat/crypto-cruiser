// Update 21: the LAN dev server over https with a self-signed certificate. Phantom (extension and mobile) only
// answers on a secure origin, so http://10.0.0.x:5173 freezes its connect; https://10.0.0.x:5173 works after the
// browser's one-time certificate warning. `npm run dev:lan:https`. The API and the websocket are proxied as before.
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';

export default mergeConfig(base, defineConfig({
  plugins: [basicSsl()],
  server: { host: true },
}));
