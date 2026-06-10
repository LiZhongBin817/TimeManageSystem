/**
 * HTTP 服务入口：组装中间件、路由、调度器、数据库启动和全局错误处理。
 */
import cors from 'cors';
import dns from 'dns';
import './env';
import express, { NextFunction, Request, Response } from 'express';
import { failStaleRunningSyncJobs, initDatabase } from './db';
import { router } from './routes';
import { startDingTalkSyncScheduler } from './services/dingtalkSyncScheduler';
import { startNotificationScheduler } from './services/notificationScheduler';

const app = express();
const port = Number(process.env.PORT || 4000);

dns.setDefaultResultOrder('ipv4first');

// 启动诊断用于提前发现 OAuth 回调域名和前端域名不一致的问题。
function warnRuntimeConfig() {
  const publicBase = process.env.PUBLIC_BASE_URL || process.env.SERVER_PUBLIC_BASE_URL || '';
  const frontendBase = process.env.FRONTEND_BASE_URL || '';
  const publicIsLocalhost = /localhost|127\.0\.0\.1/.test(publicBase);
  const frontendIsLocalhost = /localhost|127\.0\.0\.1/.test(frontendBase);
  if (publicBase && frontendBase && publicIsLocalhost !== frontendIsLocalhost) {
    console.warn(`[startup-check] PUBLIC_BASE_URL (${publicBase}) and FRONTEND_BASE_URL (${frontendBase}) look inconsistent. DingTalk OAuth callbacks may return to the wrong host.`);
  }
  if (publicIsLocalhost && process.env.NODE_ENV === 'production') {
    console.warn(`[startup-check] PUBLIC_BASE_URL is ${publicBase}. Production DingTalk OAuth usually needs a reachable server URL, not localhost.`);
  }
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/api', router);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// 把下游服务或平台错误统一整理成前端可处理的 JSON 结构。
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const anyError = err as any;
  const status = anyError.response?.status || 500;
  const upstreamMessage = anyError.response?.data?.message;
  const upstreamCode = anyError.response?.data?.code;
  res.status(status >= 400 && status < 600 ? status : 500).json({
    message: upstreamMessage || err.message || '服务异常',
    code: upstreamCode
  });
});

initDatabase()
  .then(() => {
    failStaleRunningSyncJobs(30);
    warnRuntimeConfig();
    startDingTalkSyncScheduler();
    startNotificationScheduler();
    const server = app.listen(port, () => {
      console.log(`API server listening on http://localhost:${port}`);
    });
    server.on('error', (error: any) => {
      if (error?.code === 'EADDRINUSE') {
        console.error(`[startup-check] Port ${port} is already in use. Stop the old node process or set PORT to another value before restarting.`);
      }
      throw error;
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
