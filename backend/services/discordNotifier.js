const trimText = (value, maxLength = 1000) => {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

const escapeMarkdown = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\*/g, '\\*')
  .replace(/_/g, '\\_')
  .replace(/~/g, '\\~')
  .replace(/\|/g, '\\|');

export async function notifyDiscord(content) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: trimText(content, 1900),
        allowed_mentions: { parse: [] },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn('Discord notification failed:', response.status, trimText(body, 200));
    }
  } catch (error) {
    console.warn('Discord notification failed:', error.message);
  }
}

export async function notifyZaloFailure({ storeName, orderCode, customerName, phone, eventType, error, message }) {
  if (process.env.ZALO_NOTIFY_DISCORD_ON_FAILURE === 'false') {
    return;
  }

  await notifyDiscord([
    '**Zalo delivery failed**',
    '',
    `Store: **${escapeMarkdown(storeName || 'Unknown')}**`,
    `Order code: \`${escapeMarkdown(orderCode || '')}\``,
    `Customer: ${escapeMarkdown(customerName || 'Unknown')}`,
    `Phone: \`${escapeMarkdown(phone || '')}\``,
    `Event type: **${escapeMarkdown(eventType || 'unknown')}**`,
    `Error: ${escapeMarkdown(error?.message || error || 'Unknown')}`,
    `Time: \`${new Date().toISOString()}\``,
    '',
    '**Message content**',
    escapeMarkdown(trimText(message, 700)),
  ].join('\n'));
}

export async function notifyZaloSuccess({ storeName, orderCode, customerName, phone, eventType, message }) {
  if (process.env.ZALO_NOTIFY_DISCORD_ON_SUCCESS !== 'true') {
    return;
  }

  await notifyDiscord([
    '**Zalo delivery succeeded**',
    '',
    `Store: **${escapeMarkdown(storeName || 'Unknown')}**`,
    `Order code: \`${escapeMarkdown(orderCode || '')}\``,
    `Customer: ${escapeMarkdown(customerName || 'Unknown')}`,
    `Phone: \`${escapeMarkdown(phone || '')}\``,
    `Event type: **${escapeMarkdown(eventType || 'unknown')}**`,
    `Time: \`${new Date().toISOString()}\``,
    '',
    '**Message content**',
    escapeMarkdown(trimText(message, 700)),
  ].join('\n'));
}
