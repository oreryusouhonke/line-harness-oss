import { Hono } from 'hono';
import type { Env } from '../index.js';

const iemotoVoice = new Hono<Env>();
const CLASSIFICATIONS = new Set(['IEMOTO_RAW','ASSISTANT_DRAFT','IEMOTO_APPROVED','IEMOTO_REVISED','IEMOTO_REJECTED','FACT_ONLY']);
const RATINGS = new Set(['家元らしい','少し違う','全然違う','長すぎる','短すぎる','説教臭い','AIっぽい','毒が足りない','優しさが足りない','商売感覚が違う']);

iemotoVoice.get('/api/iemoto-voice/conversations', async (c) => {
  const classification = c.req.query('classification');
  const where = classification ? 'WHERE EXISTS (SELECT 1 FROM iemoto_voice_messages m WHERE m.conversation_id=c.id AND m.classification=?)' : '';
  const stmt = c.env.DB.prepare(`SELECT c.*, (SELECT COUNT(*) FROM iemoto_voice_messages m WHERE m.conversation_id=c.id) message_count FROM iemoto_voice_conversations c ${where} ORDER BY COALESCE(c.conversation_at,c.created_at) DESC LIMIT 200`);
  const rows = await (classification ? stmt.bind(classification) : stmt).all();
  return c.json({ success: true, data: rows.results });
});

iemotoVoice.get('/api/iemoto-voice/conversations/:id', async (c) => {
  const conversation = await c.env.DB.prepare('SELECT * FROM iemoto_voice_conversations WHERE id=?').bind(c.req.param('id')).first();
  if (!conversation) return c.json({ success: false, error: 'Not found' }, 404);
  const messages = await c.env.DB.prepare(`SELECT m.*, (SELECT json_group_array(json_object('rating',e.rating,'note',e.note,'created_at',e.created_at)) FROM iemoto_voice_evaluations e WHERE e.message_id=m.id) evaluations FROM iemoto_voice_messages m WHERE conversation_id=? ORDER BY sort_order`).bind(c.req.param('id')).all();
  return c.json({ success: true, data: { conversation, messages: messages.results } });
});

iemotoVoice.post('/api/iemoto-voice/import-normalized', async (c) => {
  const body = await c.req.json<{ conversations?: Array<Record<string, unknown>> }>();
  const rows = body.conversations || [];
  if (rows.length > 30) return c.json({ success: false, error: 'Maximum 30 conversations per import' }, 400);
  for (const row of rows) {
    const id = String(row.id || '');
    if (!id) continue;
    await c.env.DB.prepare(`INSERT OR IGNORE INTO iemoto_voice_conversations (id,title,conversation_at,category,emotions_json,source_json,pii_masked,enabled,review_status) VALUES (?,?,?,?,?,?,?,0,'pending')`).bind(id, String(row.title || '無題'), row.createdAt || null, String(row.category || 'general'), JSON.stringify(row.emotions || []), JSON.stringify(row.source || {}), Array.isArray(row.messages) && row.messages.some((m: any) => m.piiMasked) ? 1 : 0).run();
    const messages = Array.isArray(row.messages) ? row.messages : [];
    for (let index = 0; index < messages.length; index += 1) {
      const message: any = messages[index];
      if (!CLASSIFICATIONS.has(message.classification)) continue;
      await c.env.DB.prepare(`INSERT OR IGNORE INTO iemoto_voice_messages (id,conversation_id,role,content,classification,category,style_features_json,pii_masked,use_for_style,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(String(message.id), id, message.role === 'assistant' ? 'assistant' : 'user', String(message.content || ''), message.classification, String(message.category || 'general'), JSON.stringify(message.styleFeatures || {}), message.piiMasked ? 1 : 0, message.useForStyle ? 1 : 0, index, message.createdAt || null).run();
    }
  }
  return c.json({ success: true, data: { imported: rows.length } });
});

iemotoVoice.patch('/api/iemoto-voice/messages/:id', async (c) => {
  const body = await c.req.json<{ classification?: string; useForStyle?: boolean }>();
  if (body.classification && !CLASSIFICATIONS.has(body.classification)) return c.json({ success: false, error: 'Invalid classification' }, 400);
  await c.env.DB.prepare(`UPDATE iemoto_voice_messages SET classification=COALESCE(?,classification), use_for_style=COALESCE(?,use_for_style) WHERE id=?`).bind(body.classification || null, body.useForStyle === undefined ? null : body.useForStyle ? 1 : 0, c.req.param('id')).run();
  return c.json({ success: true });
});

iemotoVoice.post('/api/iemoto-voice/messages/:id/evaluations', async (c) => {
  const body = await c.req.json<{ rating?: string; note?: string }>();
  if (!body.rating || !RATINGS.has(body.rating)) return c.json({ success: false, error: 'Invalid rating' }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO iemoto_voice_evaluations (id,message_id,rating,note,evaluator_id) VALUES (?,?,?,?,?)`).bind(id, c.req.param('id'), body.rating, body.note || null, c.get('staff')?.id || null).run();
  return c.json({ success: true, data: { id } }, 201);
});

iemotoVoice.post('/api/iemoto-voice/style-proposals', async (c) => {
  const evaluations = await c.env.DB.prepare(`SELECT id,rating,note FROM iemoto_voice_evaluations ORDER BY created_at DESC LIMIT 100`).all<{ id:string; rating:string; note:string|null }>();
  const grouped = evaluations.results.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.rating]: (acc[row.rating] || 0) + 1 }), {});
  const diff = `# IEMOTO_STYLE_GUIDE.md 変更案（自動適用禁止）\n\n評価集計: ${JSON.stringify(grouped)}\n\n- AIっぽい／説教臭い評価の付いた表現を禁止例へ追加する。\n- 長すぎる／短すぎる評価をカテゴリ別の長さルールへ反映する。\n- 毒／優しさ／商売感覚の不足は、承認済み実例と照合して変更する。\n`;
  const id = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO iemoto_style_proposals (id,source_evaluation_ids_json,proposed_diff,status) VALUES (?,?,?,'draft')`).bind(id, JSON.stringify(evaluations.results.map((row) => row.id)), diff).run();
  return c.json({ success: true, data: { id, proposedDiff: diff, applied: false } }, 201);
});

export { iemotoVoice };
