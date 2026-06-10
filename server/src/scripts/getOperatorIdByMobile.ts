/**
 * 工具脚本：通过手机号解析钉钉 operator userId，并可写入 .env。
 */
import axios from 'axios';
import '../env';
import fs from 'fs';
import path from 'path';

const mobile = process.argv[2] || process.env.DINGTALK_OPERATOR_MOBILE;
const shouldWrite = process.argv.includes('--write');

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

async function getLegacyAccessToken() {
  const appKey = requireEnv('DINGTALK_APP_KEY');
  const appSecret = requireEnv('DINGTALK_APP_SECRET');
  const { data } = await axios.get('https://oapi.dingtalk.com/gettoken', {
    params: { appkey: appKey, appsecret: appSecret },
    timeout: 12000
  });

  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`access_token 获取失败：${data.errmsg || JSON.stringify(data)}`);
  }
  return data.access_token as string;
}

function writeOperatorId(userId: string) {
  const envPath = fs.existsSync(path.resolve(process.cwd(), '..', '.env'))
    ? path.resolve(process.cwd(), '..', '.env')
    : path.resolve(process.cwd(), '.env');
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const next = content.match(/^DINGTALK_OPERATOR_ID=/m)
    ? content.replace(/^DINGTALK_OPERATOR_ID=.*$/m, `DINGTALK_OPERATOR_ID=${userId}`)
    : `${content.trimEnd()}\nDINGTALK_OPERATOR_ID=${userId}\n`;
  fs.writeFileSync(envPath, next);
}

async function main() {
  if (!mobile) {
    console.log('用法：npm run get:operator --workspace server -- <手机号> [--write]');
    return;
  }

  const accessToken = await getLegacyAccessToken();
  const { data } = await axios.post(
    'https://oapi.dingtalk.com/topapi/v2/user/getbymobile',
    { mobile },
    { params: { access_token: accessToken }, timeout: 12000 }
  );

  const userId = data?.result?.userid;
  if (data.errcode !== 0 || !userId) {
    throw new Error(`UserId 查询失败：${data.errmsg || JSON.stringify(data)}`);
  }

  const detailResponse = await axios.post(
    'https://oapi.dingtalk.com/topapi/v2/user/get',
    { userid: userId, language: 'zh_CN' },
    { params: { access_token: accessToken }, timeout: 12000 }
  );
  const unionId = detailResponse.data?.result?.unionid;
  if (detailResponse.data.errcode !== 0 || !unionId) {
    throw new Error(`UnionId 查询失败：${detailResponse.data.errmsg || JSON.stringify(detailResponse.data)}`);
  }

  if (shouldWrite) {
    writeOperatorId(unionId);
    console.log(`查询成功，UserId=${userId}，已写入 DINGTALK_OPERATOR_ID=${unionId}`);
  } else {
    console.log(`查询成功，UserId=${userId}，UnionId=${unionId}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
