import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = path.join(root, 'apps', 'worker');
const imagePath = path.join(
  root,
  'artifacts',
  'rich-menu',
  '2026-07-23',
  'oreryu-rich-menu-5items-v2.png',
);
const groupId = 'oreryu-rich5-20260723';
const pageId = 'oreryu-rich5-page-1';
const designTrigger = 'AIでデザイン作成をします。※返信に少し時間が掛かる場合があります。';
const execute = process.argv.includes('--execute');
const verifyOnly = process.argv.includes('--verify');

function wrangler(sql) {
  const executable = process.execPath;
  const wranglerBin = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const output = execFileSync(
    executable,
    [wranglerBin, 'd1', 'execute', 'line-crm', '--env', 'production', '--remote', '--json', '--command', sql],
    { cwd: workerDir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(output);
  if (!parsed.every((item) => item.success)) throw new Error('D1 query failed');
  return parsed;
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

if (execute) {
  wrangler(`
    UPDATE rich_menu_areas
    SET action_type = 'message',
        action_data = ${sqlText(JSON.stringify({ text: designTrigger }))}
    WHERE id = 'oreryu-rich5-area-2' AND page_id = ${sqlText(pageId)};
  `);
}

async function lineRequest(token, url, init = {}, accepted = [200]) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (!accepted.includes(response.status)) {
    const text = await response.text();
    throw new Error(`LINE API ${response.status}: ${text.slice(0, 300)}`);
  }
  return response;
}

const query = `
  SELECT
    g.id AS group_id, g.name AS group_name, g.chat_bar_text, g.size, g.status,
    g.account_id, p.id AS page_id, p.name AS page_name, p.order_index,
    p.line_richmenu_id, a.channel_access_token
  FROM rich_menu_groups g
  JOIN rich_menu_pages p ON p.group_id = g.id
  JOIN line_accounts a ON a.id = g.account_id
  WHERE g.id = ${sqlText(groupId)} AND p.id = ${sqlText(pageId)};
  SELECT
    bounds_x, bounds_y, bounds_width, bounds_height, action_type, action_data
  FROM rich_menu_areas
  WHERE page_id = ${sqlText(pageId)}
  ORDER BY bounds_y, bounds_x;
`;
const result = wrangler(query);
const page = result[0]?.results?.[0];
const areas = result[1]?.results || [];
if (!page) throw new Error('Rich menu draft not found');
if (areas.length !== 5) throw new Error(`Expected 5 areas, received ${areas.length}`);

const image = await fs.readFile(imagePath);
const dimensions = page.size === 'compact'
  ? { width: 2500, height: 843 }
  : { width: 2500, height: 1686 };
const payload = {
  size: dimensions,
  selected: false,
  name: `${groupId.slice(0, 8)} - ${page.page_name}`,
  chatBarText: page.chat_bar_text || 'メニュー',
  areas: areas.map((area) => ({
    bounds: {
      x: area.bounds_x,
      y: area.bounds_y,
      width: area.bounds_width,
      height: area.bounds_height,
    },
    action: {
      type: area.action_type,
      ...JSON.parse(area.action_data),
    },
  })),
};

if (verifyOnly) {
  if (!page.line_richmenu_id) throw new Error('Published rich menu ID is missing');
  const current = await lineRequest(
    page.channel_access_token,
    'https://api.line.me/v2/bot/user/all/richmenu',
    {},
  );
  const currentId = (await current.json()).richMenuId || null;
  await lineRequest(
    page.channel_access_token,
    `https://api.line.me/v2/bot/richmenu/${page.line_richmenu_id}`,
    {},
  );
  console.log(JSON.stringify({
    status: page.status,
    groupId,
    richMenuExists: true,
    isCurrentDefault: currentId === page.line_richmenu_id,
    designTrigger: JSON.parse(areas[1].action_data).text,
  }, null, 2));
  process.exit(currentId === page.line_richmenu_id ? 0 : 1);
}

if (!execute) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    groupId,
    pageId,
    accountId: page.account_id,
    status: page.status,
    imageBytes: image.byteLength,
    areaCount: payload.areas.length,
    actions: payload.areas.map((area) => area.action.type),
  }, null, 2));
  process.exit(0);
}

const token = page.channel_access_token;
let oldDefaultId = null;
let newRichMenuId = null;
let defaultChanged = false;
try {
  const current = await lineRequest(
    token,
    'https://api.line.me/v2/bot/user/all/richmenu',
    {},
    [200, 404],
  );
  if (current.status === 200) oldDefaultId = (await current.json()).richMenuId || null;

  const created = await lineRequest(
    token,
    'https://api.line.me/v2/bot/richmenu',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  newRichMenuId = (await created.json()).richMenuId;
  if (!newRichMenuId) throw new Error('LINE did not return a richMenuId');

  await lineRequest(
    token,
    `https://api-data.line.me/v2/bot/richmenu/${newRichMenuId}/content`,
    {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: image,
    },
  );

  const aliasId = `lhx-${groupId.slice(0, 8)}-${page.order_index}`;
  await lineRequest(
    token,
    `https://api.line.me/v2/bot/richmenu/alias/${aliasId}`,
    { method: 'DELETE' },
    [200, 404],
  );
  await lineRequest(
    token,
    'https://api.line.me/v2/bot/richmenu/alias',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId: newRichMenuId }),
    },
  );

  await lineRequest(
    token,
    `https://api.line.me/v2/bot/user/all/richmenu/${newRichMenuId}`,
    { method: 'POST' },
  );
  defaultChanged = true;

  wrangler(`
    UPDATE rich_menu_groups
    SET is_default_for_all = CASE WHEN id = ${sqlText(groupId)} THEN 1 ELSE 0 END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
    WHERE account_id = ${sqlText(page.account_id)};
    UPDATE rich_menu_groups
    SET status = 'published',
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
    WHERE id = ${sqlText(groupId)};
    UPDATE rich_menu_pages
    SET line_richmenu_id = ${sqlText(newRichMenuId)},
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
    WHERE id = ${sqlText(pageId)};
  `);

  console.log(JSON.stringify({
    status: 'published',
    groupId,
    pageId,
    richMenuId: newRichMenuId,
    defaultChanged: true,
  }, null, 2));
} catch (error) {
  if (defaultChanged && oldDefaultId) {
    try {
      await lineRequest(
        token,
        `https://api.line.me/v2/bot/user/all/richmenu/${oldDefaultId}`,
        { method: 'POST' },
      );
    } catch {
      // Keep the original failure as the primary error.
    }
  }
  if (newRichMenuId) {
    try {
      await lineRequest(
        token,
        `https://api.line.me/v2/bot/richmenu/${newRichMenuId}`,
        { method: 'DELETE' },
        [200, 404],
      );
    } catch {
      // Keep the original failure as the primary error.
    }
  }
  throw error;
}
