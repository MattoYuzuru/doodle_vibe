import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base "./" — чтобы собранное приложение открывалось с любого адреса (туннель, подпапка сервера).
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  // Старые файлы сборки не удаляем: у клиента (Telegram) может быть закэширован прежний index.html, который просит их по имени.
  build: { emptyOutDir: false },
  server: {
    // /api/* проксируем на server.mjs (дедлайны из Moodle), когда подключим реальные данные.
    proxy: { "/api": "http://127.0.0.1:8787" },
    allowedHosts: true,
  },
  // Предпросмотр открывается через туннель (trycloudflare.com), поэтому проверку имени хоста отключаем.
  // /api/* уходит на server.mjs; xfwd добавляет X-Forwarded-For, чтобы сервер отличал внешние запросы от локальных.
  preview: { allowedHosts: true, proxy: { "/api": { target: "http://127.0.0.1:8787", xfwd: true } } },
});
