/**
 * 诊断脚本：检查钉钉凭据是否能访问已配置的工作簿数据。
 */
import '../env';
import { dingTalkClient } from '../dingtalk/client';

async function main() {
  if (!dingTalkClient.isConfigured) {
    console.log('钉钉配置不完整，请检查 DINGTALK_APP_KEY / DINGTALK_APP_SECRET / DINGTALK_WORKBOOK_ID / DINGTALK_OPERATOR_ID。');
    return;
  }

  const sheets = await dingTalkClient.listWorksheets();
  console.log(`连接成功，共读取到 ${sheets.length} 个工作表：`);
  for (const sheet of sheets) {
    console.log(`- ${sheet.name} (${sheet.sheetId})`);
  }
}

main().catch((error) => {
  console.error('钉钉连接失败：', error.message);
  if (error.response) {
    console.error('HTTP 状态：', error.response.status);
    console.error('响应内容：', JSON.stringify(error.response.data, null, 2));
  }
  process.exit(1);
});
