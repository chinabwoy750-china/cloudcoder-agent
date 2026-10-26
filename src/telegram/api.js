import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const base = () => `https://api.telegram.org/bot${config.telegram.token}`;

export async function tgCall(method, payload = {}, { timeoutMs = 60000 } = {}) {
  if (!config.telegram.token) throw new Error('Telegram not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const desc = data?.description || `HTTP ${res.status}`;
      const err = new Error(`Telegram ${method} failed: ${desc}`);
      err.telegram = data;
      throw err;
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendMessage(chatId, text, { parseMode = 'Markdown', replyMarkup, disablePreview = true } = {}) {
  // Telegram caps messages at 4096 chars.
  const chunks = String(text).match(/[\s\S]{1,3800}/g) || [''];
  let last;
  for (const chunk of chunks) {
    try {
      last = await tgCall('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: parseMode,
        disable_web_page_preview: disablePreview,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (err) {
      // Retry without Markdown if entities are malformed.
      if (err.telegram?.description?.includes('parse')) {
        last = await tgCall('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: disablePreview });
      } else throw err;
    }
  }
  return last;
}

export async function sendChatAction(chatId, action = 'typing') {
  try { await tgCall('sendChatAction', { chat_id: chatId, action }); }
  catch (err) { logger.debug(`sendChatAction failed: ${err.message}`); }
}

export async function sendDocument(chatId, buffer, filename, caption) {
  if (!config.telegram.token) throw new Error('Telegram not configured');
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('document', new Blob([buffer]), filename);
  if (caption) { form.set('caption', caption.slice(0, 1000)); form.set('parse_mode', 'Markdown'); }

  const res = await fetch(`${base()}/sendDocument`, { method: 'POST', body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(`Telegram sendDocument failed: ${data?.description || res.status}`);
  }
  return data.result;
}

export async function getUpdates({ offset, timeoutSec }) {
  return tgCall('getUpdates', {
    offset,
    timeout: timeoutSec,
    allowed_updates: ['message', 'callback_query'],
  }, { timeoutMs: (timeoutSec + 15) * 1000 });
}

export async function setMyCommands(commands) {
  return tgCall('setMyCommands', { commands });
}

export async function getMe() {
  return tgCall('getMe');
}
