import type { ProgressContext, ProgressState } from './reducer.js';

type Phase = ProgressState['phase'];
type Locale = ProgressContext['locale'];

const HEADER_TITLES: Record<Locale, Record<Phase, string>> = {
  zh: {
    starting: '正在准备',
    running: '正在处理',
    waiting_input: '等待你的输入',
    succeeded: '已完成',
    failed: '执行失败',
    cancelled: '已取消',
    ambiguous: '结果待确认',
  },
  en: {
    starting: 'Preparing',
    running: 'Working',
    waiting_input: 'Waiting for your input',
    succeeded: 'Completed',
    failed: 'Execution failed',
    cancelled: 'Cancelled',
    ambiguous: 'Result needs confirmation',
  },
};

const ENGLISH_LABELS: Record<string, string> = {
  理解需求: 'Understanding the request',
  执行命令: 'Running commands',
  修改文件: 'Editing files',
  调用工具: 'Calling tools',
  执行操作: 'Running operations',
  等待你的输入: 'Waiting for your input',
};

export function headerTemplate(phase: Phase): string {
  if (phase === 'succeeded') return 'green';
  if (phase === 'failed') return 'red';
  if (phase === 'cancelled') return 'grey';
  if (phase === 'waiting_input' || phase === 'ambiguous') return 'orange';
  return 'blue';
}

export function headerTitle(phase: Phase, locale: Locale): string {
  return HEADER_TITLES[locale][phase];
}

export function timelineElements(
  timeline: ProgressState['timeline'],
  locale: Locale,
): Array<Record<string, unknown>> {
  return timeline.slice(0, 4).map((item, index) => {
    const icon = item.status === 'completed' ? '✅' : item.status === 'failed' ? '❌' : '🔵';
    const label = locale === 'en' ? ENGLISH_LABELS[item.label] ?? item.label : item.label;
    return {
      tag: 'markdown',
      element_id: `progress_timeline_${index}`,
      content: `${icon} **${label}**${item.count > 1 ? ` ×${item.count}` : ''}`,
    };
  });
}

export function detailsElement(
  operationCount: number,
  locale: Locale,
): Record<string, unknown> | undefined {
  if (operationCount <= 0) return undefined;
  return {
    tag: 'note',
    element_id: 'progress_details',
    elements: [{
      tag: 'plain_text',
      content: locale === 'en'
        ? `${operationCount} operation${operationCount === 1 ? '' : 's'} processed`
        : `已处理 ${operationCount} 个操作`,
    }],
  };
}

function narrativeElement(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const content = Array.from(text).slice(0, 240).join('').trim();
  return content ? { tag: 'markdown', element_id: 'progress_narrative', content } : undefined;
}

export function render(
  state: ProgressState,
  context: ProgressContext,
): {
  schema: '2.0';
  config: { update_multi: true };
  header: Record<string, unknown>;
  body: { direction: 'vertical'; elements: Array<Record<string, unknown>> };
} {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: headerTemplate(state.phase),
      title: { tag: 'plain_text', content: headerTitle(state.phase, context.locale) },
    },
    body: {
      direction: 'vertical',
      elements: [
        narrativeElement(state.currentText),
        ...timelineElements(state.timeline, context.locale),
        detailsElement(state.operationCount, context.locale),
      ].filter((value): value is Record<string, unknown> => value !== undefined),
    },
  };
}
