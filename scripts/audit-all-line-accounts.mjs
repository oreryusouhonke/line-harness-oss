import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = path.join(root, 'apps', 'worker');

function query(sql) {
  const out = execFileSync(process.execPath, [
    path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'd1', 'execute', 'line-crm', '--env', 'production', '--remote', '--json', '--command', sql,
  ], { cwd: workerDir, encoding: 'utf8', windowsHide: true });
  return JSON.parse(out)[0]?.results || [];
}

async function line(token, pathName, accepted = [200]) {
  const response = await fetch(`https://api.line.me${pathName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!accepted.includes(response.status)) return { status: response.status, body };
  return { status: response.status, body };
}

const accounts = query(`SELECT id,name,channel_id,is_active,channel_access_token FROM line_accounts ORDER BY display_order,name`);
const report = [];
for (const account of accounts) {
  const bot = await line(account.channel_access_token, '/v2/bot/info');
  const webhook = await line(account.channel_access_token, '/v2/bot/channel/webhook/endpoint');
  const current = await line(account.channel_access_token, '/v2/bot/user/all/richmenu', [200, 404]);
  const richMenuId = current.status === 200 ? current.body.richMenuId || null : null;
  const menu = richMenuId
    ? await line(account.channel_access_token, `/v2/bot/richmenu/${richMenuId}`)
    : { status: 404, body: {} };
  const designActions = (menu.body.areas || []).map(x => x.action).filter(action => {
    const serialized = JSON.stringify(action);
    return /デザイン|RM_START|477vwrmt/.test(serialized);
  });
  report.push({
    name: account.name,
    channelId: account.channel_id,
    activeInHarness: account.is_active === 1,
    botApi: bot.status,
    basicId: bot.body.basicId || null,
    webhookApi: webhook.status,
    webhookActive: webhook.body.active ?? null,
    webhookEndpoint: webhook.body.endpoint || null,
    defaultRichMenuId: richMenuId,
    richMenuApi: menu.status,
    designActions,
  });
}

console.log(JSON.stringify(report, null, 2));
