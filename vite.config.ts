import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required so the browser grants camera/microphone access via
// getUserMedia. Plain HTTP only allows media devices on localhost.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
