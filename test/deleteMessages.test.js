const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDelete, deleteMessages, confirmDelete } = require('../src/deleteMessages');
let sequence = 0;
function fixture() {
  const replies = [], deleted = [], logs = []; let time = 2000000000, role = true, allowed = true, clear = 0;
  const rows = new Map(Array.from({ length: 100 }, (_, i) => [String(i), { id: String(i), createdTimestamp: time - i * 1000, author: { id: i % 2 ? '2' : '1' }, content: 'text' }]));
  const ctx = { user: { id: '1' }, messageId: 'command',
    guild: { id: 'guild', members: { fetch: async () => ({ roles: { cache: { some: () => role } } }), fetchMe: async () => ({ id: 'bot' }) } },
    channel: { id: String(++sequence), permissionsFor: () => ({ has: () => allowed }),
      messages: { fetch: async options => { assert.equal(options.before, 'command'); return rows; } },
      bulkDelete: async ids => { deleted.push(ids); return new Map(ids.map(id => [id, rows.get(id)])); } },
    reply: async text => replies.push(text) };
  const options = { now: () => time, clearContext: () => { clear++; }, sendLog: (...args) => logs.push(args) };
  return { ctx, options, rows, replies, deleted, logs, get clear() { return clear; }, denyRole: () => { role = false; }, denyPermission: () => { allowed = false; }, advance: ms => { time += ms; } };
}
test('parser accepts both bounded formats and rejects ambiguous input', () => {
  assert.deepEqual(parseDelete('<@!123> 100'), { count: 100, userId: '123' });
  for (const value of ['0', '101', '-2', '1.5', '50 extra', '<@1> <@2> 10', '']) assert.equal(parseDelete(value), null);
});
test('normal deletion excludes pinned, old and internal state messages', async () => {
  const f = fixture(); f.rows.get('0').pinned = true;
  f.rows.get('1').createdTimestamp = 0;
  Object.assign(f.rows.get('2'), { author: { id: 'bot' }, content: 'TARS · Presupuesto IA · No borrar' });
  await deleteMessages(f.ctx, '10', f.options);
  assert.equal(f.deleted[0].length, 10);
  assert.ok(f.deleted[0].every(id => !['0', '1', '2'].includes(id)));
  assert.equal(f.clear, 1); assert.equal(f.logs[0][0], 'borrado');
});
test('user filter never deletes another author', async () => {
  const f = fixture(); await deleteMessages(f.ctx, '<@2> 50', f.options);
  assert.equal(f.deleted[0].length, 50); assert.ok(f.deleted[0].every(id => f.rows.get(id).author.id === '2'));
});
test('large deletion requires same user/channel confirmation and rechecks permissions', async () => {
  const f = fixture(); await deleteMessages(f.ctx, '100', f.options);
  assert.equal(f.deleted.length, 0);
  assert.equal(await confirmDelete({ ...f.ctx, user: { id: 'other' } }, 'sí', f.options), false);
  assert.equal(await confirmDelete({ ...f.ctx, channel: { id: 'other' } }, 'sí', f.options), false);
  f.denyRole(); await confirmDelete(f.ctx, 'sí', f.options);
  assert.equal(f.deleted.length, 0);
});
test('confirmation deletes only original selected IDs and preserves newly pinned messages', async () => {
  const f = fixture(); await deleteMessages(f.ctx, '60', f.options);
  f.rows.get('0').pinned = true;
  f.rows.set('new', { id: 'new', author: { id: '1' }, createdTimestamp: 2000000001 });
  await confirmDelete(f.ctx, 'si', f.options);
  assert.equal(f.deleted[0].length, 59); assert.ok(!f.deleted[0].includes('new'));
  assert.equal(await confirmDelete(f.ctx, 'sí', f.options), false);
});
test('no and expired confirmations do not delete; role and permissions are mandatory', async () => {
  for (const mode of ['no', 'expired', 'role', 'permission']) {
    const f = fixture();
    if (mode === 'role') f.denyRole(); if (mode === 'permission') f.denyPermission();
    await deleteMessages(f.ctx, '100', f.options);
    if (mode === 'expired') f.advance(30000);
    await confirmDelete(f.ctx, mode === 'no' ? 'no' : 'si', f.options);
    assert.equal(f.deleted.length, 0);
  }
});
