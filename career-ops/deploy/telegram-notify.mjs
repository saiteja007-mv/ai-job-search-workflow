/**
 * telegram-notify.mjs — one-way push to the phone.
 *
 * Extracted from telegram-control.mjs's send() so the bot and the poller cannot drift
 * on formatting or on the 4096-char hard cap Telegram enforces.
 */
const API_BASE = 'https://api.telegram.org/bot';

/** Telegram hard-caps at 4096; keep the tail, which is the most recent output. */
export function clamp(text) {
  const body = (text || '(no output)').toString();
  return body.length > 3900 ? '…\n' + body.slice(-3900) : body;
}

/**
 * Returns true if it went out. Never throws: a notification failing must not take down
 * the poller that called it, or one Telegram blip turns into a missed acceptance.
 */
export async function notify(text, { token = process.env.TELEGRAM_BOT_TOKEN,
                                     chat = process.env.TELEGRAM_ALLOWED_CHAT_ID,
                                     buttons = null } = {}) {   // buttons: inline keyboard rows, handled by telegram-control.mjs
  if (!token || !chat) return false;
  try {
    const res = await fetch(`${API_BASE}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: clamp(text), disable_web_page_preview: true,
                             ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
