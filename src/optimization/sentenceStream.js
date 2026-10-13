// SSE incremental: respeta fronteras UTF-8 y eventos divididos entre paquetes.
async function readSentenceStream(response, { onSentence, limit, signal }) {
  if (!response.body) throw Error('Respuesta sin stream');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', text = '', unsaid = '', delivered = false, done = false, usage, reason;
  const spoken = [];
  async function emit(force = false) {
    while (unsaid) {
      const sentence = unsaid.match(/^([\s\S]*?[.!?](?:\s|$))/);
      const boundary = sentence ? sentence[1].length : unsaid.length >= 180 ? unsaid.lastIndexOf(' ', 180) : -1;
      if (!force && boundary <= 0) break;
      const count = boundary > 0 ? boundary : unsaid.length;
      const chunk = unsaid.slice(0, count).trim(); unsaid = unsaid.slice(count);
      if (chunk) { signal?.throwIfAborted(); delivered = true; await onSentence(chunk); spoken.push(chunk); }
    }
  }
  async function event(raw) {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { done = true; return; }
    const item = JSON.parse(data);
    if (item.error) throw Error('Proveedor rechazó el stream');
    if (item.usage) usage = item.usage.total_tokens;
    const choice = item.choices?.[0];
    if (choice?.finish_reason) reason = choice.finish_reason;
    const token = choice?.delta?.content;
    if (typeof token === 'string') {
      const keep = token.slice(0, Math.max(0, limit - text.length));
      text += keep; unsaid += keep;
      await emit();
      if (text.length >= limit) { done = true; if (unsaid.trim()) unsaid = unsaid.replace(/\s+\S*$/, '') + '…'; }
    }
  }
  try {
    while (!done) {
      signal?.throwIfAborted();
      const result = await reader.read();
      pending += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
      if (pending.length > 65536) throw Error('Evento SSE demasiado grande');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending)) && !done) {
        const raw = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
        await event(raw);
      }
      if (result.done) { if (pending.trim()) await event(pending); break; }
    }
    if (!text.trim() || (!done && !reason) || reason === 'length') throw Error('Stream incompleto');
    await emit(true);
    return { text: spoken.join(' '), usage };
  } catch (error) {
    if (delivered) error.code = 'AI_PARTIAL'; // No repetir por otro proveedor una respuesta ya audible.
    throw error;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
module.exports = { readSentenceStream };
