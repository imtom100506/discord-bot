const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceLog } = require('../src/voiceLog');

test('voice text goes only to logs-tars in the originating guild with mentions disabled', async () => {
  const sent = [];
  const channel = { name: 'logs-tars', isTextBased: () => true, send: async payload => sent.push(payload) };
  const record = createVoiceLog({ guilds: { cache: new Map([['guild', { channels: { cache: new Map([['log', channel]]) } }]]) } });
  await Promise.all([
    record({ guildId: 'guild', channelId: 'voice', userId: 'human', role: 'user', text: 'Hola @everyone' }),
    record({ guildId: 'guild', channelId: 'voice', userId: 'human', role: 'assistant', text: 'En línea.' }),
  ]);
  assert.equal(sent.length, 2); assert.match(sent[0].content, /<@human>.*<#voice>/);
  assert.match(sent[1].content, /TARS/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('missing or unwritable log channel cannot break the voice pipeline', async () => {
  const channel = { name: 'logs-tars', isTextBased: () => true, send: async () => { throw Error('denied'); } };
  const record = createVoiceLog({ guilds: { cache: new Map([['guild', { channels: { cache: new Map([['log', channel]]) } }]]) } });
  await record({ guildId: 'missing', role: 'user', text: 'hola' });
  await record({ guildId: 'guild', role: 'user', text: 'hola' });
});
