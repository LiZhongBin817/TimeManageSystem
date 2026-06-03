import cors from 'cors';
import './env';
import express, { NextFunction, Request, Response } from 'express';
import { initDatabase } from './db';
import { router } from './routes';

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/api', router);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

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
    app.listen(port, () => {
      console.log(`API server listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
