import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { target: 'chrome105' },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4311', '/media': 'http://127.0.0.1:4311' },
  },
});
