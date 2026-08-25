import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const viteEnv = loadEnv(mode, process.cwd(), 'VITE_');
  const appEnv = loadEnv(mode, process.cwd(), 'APP_');
  const apiProxyTarget =
    viteEnv.VITE_API_PROXY_TARGET ||
    `http://127.0.0.1:${appEnv.APP_API_PORT || '3001'}`;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': apiProxyTarget,
        '/healthz': apiProxyTarget
      }
    }
  };
});
