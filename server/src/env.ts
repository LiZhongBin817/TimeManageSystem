import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env')
];

const envPath = candidates.find((item) => fs.existsSync(item));
dotenv.config(envPath ? { path: envPath } : undefined);
