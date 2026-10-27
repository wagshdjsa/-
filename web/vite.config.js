import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  // 端口全部可通过环境变量覆盖，避免与本机其他项目抢占同一端口。
  //   WEB_PORT     前端 dev server 端口（默认 5173）
  //   SERVER_PORT  后端信令服务端口（默认 1234），需与 server 侧一致
  const env = loadEnv(mode, process.cwd(), '')
  const webPort = Number(env.WEB_PORT || process.env.WEB_PORT || 5173)
  const serverPort = Number(env.SERVER_PORT || process.env.SERVER_PORT || 1234)
  const serverHost = env.SERVER_HOST || process.env.SERVER_HOST || '127.0.0.1'
  const target = `http://${serverHost}:${serverPort}`

  return {
    plugins: [vue()],
    server: {
      port: webPort,
      // 端口被占用时直接报错退出，而不是静默换端口。
      // 静默换端口会让用户按默认地址访问到别的服务，排查起来极其困惑。
      strictPort: true,
      host: 'localhost',
      proxy: {
        '/api': { target, changeOrigin: true },
        '/ws': { target: target.replace('http', 'ws'), ws: true }
      }
    },
    preview: {
      port: webPort,
      strictPort: true
    }
  }
})
