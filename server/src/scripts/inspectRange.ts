/**
 * 调试脚本：检查钉钉工作表范围，用于排查行和表头映射。
 */
import '../env';
import { dingTalkClient } from '../dingtalk/client';

const moduleKey = process.argv[2] || 'province-system';
const rowNumber = Number(process.argv[3] || 19);

async function main() {
  const result = await dingTalkClient.inspectRow(moduleKey, rowNumber);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.response?.data || error.message);
  process.exit(1);
});
