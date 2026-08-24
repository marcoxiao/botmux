import type { CompletionEvent } from './types.js';
import type { ProviderId } from './types.js';
import { providerById } from './provider.js';

function productName(provider: ProviderId): 'Codex' | 'TraeX' {
  return providerById(provider)!.productName;
}

function safe(value: string, max: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : normalized;
}

function markdown(value: string): string {
  return value.replace(/[\\`*_\[\]()<>@~]/g, '\\$&');
}

function actionButton(label: string, action: string, eventId: string, primary = false): Record<string, unknown> {
  return {
    tag: 'button',
    type: primary ? 'primary' : 'default',
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value: { action, event_id: eventId } }],
  };
}

export function buildCompletionCard(event: CompletionEvent, root: boolean): Record<string, unknown> {
  const product = productName(event.provider);
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `💬 **会话**：${markdown(safe(event.title, 180))}` },
    { tag: 'hr' },
    { tag: 'markdown', content: '📝 **AI 回复**' },
    {
      tag: 'div',
      element_id: 'main_content',
      text: { tag: 'plain_text', content: safe(event.finalPreview, 6_500), lines: 30 },
    },
  ];
  if (root) {
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: '8px',
      columns: [
        { tag: 'column', width: 'auto', elements: [actionButton('在飞书中接管', 'desktop-handoff.takeover', event.eventId, true)] },
        { tag: 'column', width: 'auto', elements: [actionButton(`打开 ${product} App ↗`, 'desktop-handoff.open-app', event.eventId)] },
      ],
    });
    elements.push({
      tag: 'markdown',
      text_size: 'notation',
      content: `先点击接管，再在本卡片话题中继续；${product} Desktop 离线时不会排队。`,
    });
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: event.status === 'completed' ? 'green' : event.status === 'failed' ? 'red' : 'orange',
      title: { tag: 'plain_text', content: root ? `🤖 ${product} Desktop 任务完成` : `💬 ${product} Desktop 新进展` },
    },
    body: { direction: 'vertical', elements },
  };
}

function retryElements(provider: ProviderId, eventId?: string): Array<Record<string, unknown>> {
  if (!eventId) return [];
  return [{
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: [
      { tag: 'column', width: 'auto', elements: [actionButton('重新接管', 'desktop-handoff.takeover', eventId, true)] },
      { tag: 'column', width: 'auto', elements: [actionButton(`打开 ${productName(provider)} App ↗`, 'desktop-handoff.open-app', eventId)] },
    ],
  }];
}

export function buildTakeoverResultCard(
  provider: ProviderId,
  state: 'success' | 'offline' | 'forbidden' | 'missing',
  eventId?: string,
): Record<string, unknown> {
  const product = productName(provider);
  const meta = {
    success: ['green', `已接管 ${product} Desktop 任务`, '现在可在本卡片话题中继续发送指令，消息会写回同一个 Desktop 会话。'],
    offline: ['red', `${product} Desktop 当前离线`, '请在电脑上打开原任务后重新点击接管；本次没有排队。'],
    forbidden: ['red', '无权执行此操作', `仅当前 Bot 所有者可以接管或打开本机 ${product} App。`],
    missing: ['red', '任务记录已失效', `该通知已超过本地账本保留期，请回到 ${product} App 触发一次新结果。`],
  } as const;
  const [template, title, content] = meta[state];
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    body: {
      direction: 'vertical',
      elements: [{ tag: 'markdown', content }, ...(state === 'offline' ? retryElements(provider, eventId) : [])],
    },
  };
}

export function buildMessageResultCard(
  provider: ProviderId,
  state: 'not-adopted' | 'offline' | 'busy' | 'delivery-unknown' | 'result-unavailable' | 'unsupported',
): Record<string, unknown> {
  const product = productName(provider);
  const meta = {
    'not-adopted': ['orange', `请先接管 ${product} Desktop 任务`, '请先点击话题根卡片的「在飞书中接管」，再继续发送指令。'],
    offline: ['red', `${product} Desktop 当前离线`, '请在电脑上打开原任务后重新发送；本次没有排队。'],
    busy: ['orange', `${product} Desktop 正在处理`, '原任务当前已有一个活跃轮次。本条消息没有排队，请等待完成后再发送。'],
    'delivery-unknown': ['orange', '消息送达状态待确认', `请求可能已经进入 ${product} Desktop，但确认响应超时。请先查看 Desktop 原任务，**不要立即重发**，避免重复执行。`],
    'result-unavailable': ['orange', 'Desktop 结果回传中断', `消息已经进入 ${product} Desktop，但结果回传连接已中断。请打开 Desktop 原任务查看结果，**不要重复发送**。`],
    unsupported: ['orange', '暂不支持这条消息', `当前只支持非空文本；图片、文件和语音不会转交给 ${product} Desktop。`],
  } as const;
  const [template, title, content] = meta[state];
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    body: { direction: 'vertical', elements: [{ tag: 'markdown', content }] },
  };
}

export function buildOpenAppResultCard(event: CompletionEvent, ok: boolean): Record<string, unknown> {
  const product = productName(event.provider);
  const card = buildCompletionCard(event, true);
  card.header = {
    template: ok ? 'green' : 'red',
    title: {
      tag: 'plain_text',
      content: ok ? `已请求打开 ${product} App` : `未能打开 ${product} App`,
    },
  };
  const body = card.body as { elements: Array<Record<string, unknown>> };
  body.elements.unshift({
    tag: 'markdown',
    content: ok
      ? '已向运行 BotMux 的 Mac 发送打开原任务请求；仍需点击下方按钮完成飞书接管。'
      : `请确认 ${product} App 已安装且原任务仍存在；修复后可继续点击下方按钮。`,
  });
  return card;
}
