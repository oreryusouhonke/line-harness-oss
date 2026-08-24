import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const TARGET_CHAT_BAR_TEXT = '←ここから入力できます';
const mode = process.argv[2] ?? 'dry-run';
const rollbackDirArg = process.argv.find((arg) => arg.startsWith('--backup='));
const root = resolve(import.meta.dirname, '..');
const artifactsRoot = join(root, 'artifacts', 'rich-menu-chat-bar');
const timestamp = new Date().toISOString().replaceAll(':', '-');
const runDir = rollbackDirArg ? resolve(rollbackDirArg.slice(9)) : join(artifactsRoot, timestamp);

if (!['dry-run', 'apply', 'rollback'].includes(mode)) {
  throw new Error('usage: node scripts/unify-rich-menu-chat-bar.mjs dry-run|apply|rollback [--backup=DIR]');
}
if (TARGET_CHAT_BAR_TEXT.length > 14) throw new Error('target chatBarText exceeds LINE limit');

function d1(sql) {
  const wranglerCli = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const stdout = execFileSync(process.execPath, [wranglerCli,
    'd1', 'execute', 'line-harness',
    '--remote', '--env', 'production', '--json', '--command', sql,
  ], { cwd: join(root, 'apps', 'worker'), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  return parsed.flatMap((entry) => entry.results ?? []);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function line(token, path, init = {}) {
  const response = await fetch(`https://api.line.me${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`LINE ${init.method ?? 'GET'} ${path}: ${response.status} ${body}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('json') ? response.json() : new Uint8Array(await response.arrayBuffer());
}

async function optionalLine(token, path) {
  try { return await line(token, path); } catch (error) { if (error.status === 404) return null; throw error; }
}

async function getRichMenuImage(token, richMenuId) {
  const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`LINE image download ${richMenuId}: ${response.status} ${await response.text()}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'image/png',
  };
}

async function uploadRichMenuImage(token, richMenuId, bytes, contentType) {
  const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType }, body: bytes,
  });
  if (!response.ok) throw new Error(`LINE image upload ${richMenuId}: ${response.status} ${await response.text()}`);
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function inventory() {
  const accounts = d1(`
    SELECT id, name, channel_access_token AS token, is_active
    FROM line_accounts ORDER BY name
  `);
  const dbGroups = d1(`
    SELECT g.id, g.account_id, g.name, g.chat_bar_text, g.status,
           COUNT(p.id) AS page_count
    FROM rich_menu_groups g
    LEFT JOIN rich_menu_pages p ON p.group_id = g.id
    GROUP BY g.id ORDER BY g.account_id, g.name
  `);
  const output = { generatedAt: new Date().toISOString(), target: TARGET_CHAT_BAR_TEXT, sites: 1, accounts: [], dbGroups };

  for (const account of accounts) {
    try {
      const [list, currentDefault, aliases] = await Promise.all([
        line(account.token, '/v2/bot/richmenu/list'),
        optionalLine(account.token, '/v2/bot/user/all/richmenu'),
        line(account.token, '/v2/bot/richmenu/alias/list'),
      ]);
      const menus = list.richmenus ?? [];
      const inspectedMenus = [];
      for (const menu of menus) {
        const changeRequired = menu.chatBarText !== TARGET_CHAT_BAR_TEXT;
        let validationStatus = 'not-needed';
        let validationError = null;
        if (changeRequired) {
          try {
            await line(account.token, '/v2/bot/richmenu/validate', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...menu, richMenuId: undefined, chatBarText: TARGET_CHAT_BAR_TEXT }),
            });
            await getRichMenuImage(account.token, menu.richMenuId);
            validationStatus = 'ready';
          } catch (error) {
            validationStatus = 'error';
            validationError = error.message;
          }
        }
        inspectedMenus.push({ ...menu, changeRequired, validationStatus, validationError });
      }
      output.accounts.push({
        id: account.id, name: account.name, active: Boolean(account.is_active),
        status: 'ok', currentDefault: currentDefault?.richMenuId ?? null,
        aliases: aliases.aliases ?? [],
        menus: inspectedMenus,
      });
    } catch (error) {
      output.accounts.push({ id: account.id, name: account.name, active: Boolean(account.is_active), status: 'error', error: error.message, menus: [] });
    }
  }
  return { output, accounts };
}

function publicInventory(inventory) {
  return {
    ...inventory,
    accounts: inventory.accounts.map(({ id, name, active, status, error, currentDefault, menus }) => ({
      id, name, active, status, error, currentDefault,
      menus: menus.map(({ richMenuId, name: menuName, chatBarText, changeRequired, validationStatus, validationError }) => ({ richMenuId, name: menuName, chatBarText, changeRequired, validationStatus, validationError })),
    })),
  };
}

async function getAssignedUsers(account, oldRichMenuId) {
  const users = d1(`
    SELECT COALESCE(line_platform_user_id, line_user_id) AS line_user_id
    FROM friends WHERE line_account_id = ${sqlString(account.id)} AND is_following = 1
  `);
  const checks = await mapLimit(users, 12, async ({ line_user_id }) => {
    try {
      const current = await optionalLine(account.token, `/v2/bot/user/${encodeURIComponent(line_user_id)}/richmenu`);
      return current?.richMenuId === oldRichMenuId ? line_user_id : null;
    } catch { return null; }
  });
  return checks.filter(Boolean);
}

async function bulkLink(account, richMenuId, userIds) {
  for (let i = 0; i < userIds.length; i += 500) {
    await line(account.token, '/v2/bot/richmenu/bulk/link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ richMenuId, userIds: userIds.slice(i, i + 500) }),
    });
  }
}

async function replaceMenu(account, accountInventory, menu, backupDir) {
  const oldId = menu.richMenuId;
  const aliases = accountInventory.aliases.filter((alias) => alias.richMenuId === oldId);
  const isDefault = accountInventory.currentDefault === oldId;
  const assignedUsers = await getAssignedUsers(account, oldId);
  const image = await getRichMenuImage(account.token, oldId);
  const payload = { size: menu.size, selected: menu.selected, name: menu.name, chatBarText: TARGET_CHAT_BAR_TEXT, areas: menu.areas };
  await line(account.token, '/v2/bot/richmenu/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const imageFile = `${account.id}-${oldId}.bin`;
  writeFileSync(join(backupDir, imageFile), image.bytes);
  const record = { accountId: account.id, accountName: account.name, oldId, newId: null, oldMenu: menu, imageFile, imageContentType: image.contentType, aliases, isDefault, assignedUsers };
  writeFileSync(join(backupDir, `${account.id}-${oldId}.json`), JSON.stringify(record, null, 2));

  const created = await line(account.token, '/v2/bot/richmenu', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  record.newId = created.richMenuId;
  writeFileSync(join(backupDir, `${account.id}-${oldId}.json`), JSON.stringify(record, null, 2));
  try {
    await uploadRichMenuImage(account.token, record.newId, image.bytes, image.contentType);
    for (const alias of aliases) {
      await line(account.token, `/v2/bot/richmenu/alias/${alias.richMenuAliasId}`, { method: 'DELETE' });
      await line(account.token, '/v2/bot/richmenu/alias', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuAliasId: alias.richMenuAliasId, richMenuId: record.newId }),
      });
    }
    if (isDefault) await line(account.token, `/v2/bot/user/all/richmenu/${record.newId}`, { method: 'POST' });
    await bulkLink(account, record.newId, assignedUsers);
    d1(`
      UPDATE rich_menu_pages SET line_richmenu_id=${sqlString(record.newId)} WHERE line_richmenu_id=${sqlString(oldId)};
      UPDATE rich_menu_groups SET chat_bar_text=${sqlString(TARGET_CHAT_BAR_TEXT)}, updated_at=strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') WHERE account_id=${sqlString(account.id)};
    `);
    await line(account.token, `/v2/bot/richmenu/${oldId}`, { method: 'DELETE' });
    return { status: 'success', oldId, newId: record.newId, assignedUsers: assignedUsers.length };
  } catch (error) {
    return { status: 'error', oldId, newId: record.newId, error: error.message };
  }
}

async function apply(inventory, accounts) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'inventory-before.json'), JSON.stringify(publicInventory(inventory), null, 2));
  const results = [];
  for (const accountInventory of inventory.accounts) {
    const account = accounts.find((item) => item.id === accountInventory.id);
    if (!account || accountInventory.status !== 'ok') {
      results.push({ accountId: accountInventory.id, status: 'error', error: accountInventory.error ?? 'account unavailable' });
      continue;
    }
    for (const menu of accountInventory.menus.filter((item) => item.changeRequired)) {
      results.push({ accountId: account.id, ...(await replaceMenu(account, accountInventory, menu, runDir)) });
    }
    d1(`UPDATE rich_menu_groups SET chat_bar_text=${sqlString(TARGET_CHAT_BAR_TEXT)} WHERE account_id=${sqlString(account.id)}`);
  }
  writeFileSync(join(runDir, 'apply-results.json'), JSON.stringify(results, null, 2));
  return results;
}

async function rollback(accounts) {
  const before = JSON.parse(readFileSync(join(runDir, 'inventory-before.json'), 'utf8'));
  const results = [];
  for (const accountInventory of before.accounts) {
    const account = accounts.find((item) => item.id === accountInventory.id);
    if (!account) continue;
    for (const menu of accountInventory.menus.filter((item) => item.changeRequired)) {
      const record = JSON.parse(readFileSync(join(runDir, `${account.id}-${menu.richMenuId}.json`), 'utf8'));
      const image = readFileSync(join(runDir, record.imageFile));
      const payload = { ...record.oldMenu };
      delete payload.richMenuId; delete payload.changeRequired;
      const created = await line(account.token, '/v2/bot/richmenu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      await uploadRichMenuImage(account.token, created.richMenuId, image, record.imageContentType);
      for (const alias of record.aliases) {
        try { await line(account.token, `/v2/bot/richmenu/alias/${alias.richMenuAliasId}`, { method: 'DELETE' }); } catch (error) { if (error.status !== 404) throw error; }
        await line(account.token, '/v2/bot/richmenu/alias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ richMenuAliasId: alias.richMenuAliasId, richMenuId: created.richMenuId }) });
      }
      if (record.isDefault) await line(account.token, `/v2/bot/user/all/richmenu/${created.richMenuId}`, { method: 'POST' });
      await bulkLink(account, created.richMenuId, record.assignedUsers);
      d1(`UPDATE rich_menu_pages SET line_richmenu_id=${sqlString(created.richMenuId)} WHERE line_richmenu_id=${sqlString(record.newId)}; UPDATE rich_menu_groups SET chat_bar_text=${sqlString(record.oldMenu.chatBarText)} WHERE account_id=${sqlString(account.id)}`);
      try { await line(account.token, `/v2/bot/richmenu/${record.newId}`, { method: 'DELETE' }); } catch (error) { if (error.status !== 404) throw error; }
      results.push({ accountId: account.id, restoredFrom: record.newId, restoredTo: created.richMenuId });
    }
  }
  writeFileSync(join(runDir, 'rollback-results.json'), JSON.stringify(results, null, 2));
  return results;
}

const { output, accounts } = await inventory();
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, 'dry-run.json'), JSON.stringify(publicInventory(output), null, 2));
if (mode === 'dry-run') {
  console.log(JSON.stringify(publicInventory(output), null, 2));
} else if (mode === 'apply') {
  console.log(JSON.stringify(await apply(output, accounts), null, 2));
} else {
  console.log(JSON.stringify(await rollback(accounts), null, 2));
}
