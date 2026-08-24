import { describe, expect, it } from 'vitest';
import { render } from '../src/card.js';
import type { ProgressState } from '../src/reducer.js';

const context = (locale: 'zh' | 'en' = 'zh') => ({
  schemaVersion: 1 as const,
  sessionId: 'session-1',
  primaryTurnId: 'turn-1',
  turnId: 'turn-1',
  workerGeneration: 1,
  cliId: 'codex-app',
  locale,
  restored: false,
});

function state(phase: ProgressState['phase'] = 'running'): ProgressState {
  return {
    seq: 5,
    phase,
    currentText: '正在检查实现',
    timeline: [
      { key: 'start', label: '理解需求', status: 'completed', count: 1 },
      { key: 'command', label: '执行命令', status: 'current', count: 2 },
    ],
    operationCount: 2,
    operationStates: {},
  };
}

describe('semantic progress card', () => {
  it('renders a CardKit 2.0 card with no controls or invented metrics', () => {
    const card = render(state(), context());
    expect(card).toMatchObject({
      schema: '2.0',
      config: { update_multi: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: '正在处理' } },
      body: { direction: 'vertical' },
    });
    const serialized = JSON.stringify(card);
    expect(serialized).not.toMatch(/percent|percentage|\bETA\b|百分比|预计/iu);
    expect(serialized).not.toMatch(/button|form_submit|action/iu);
  });

  it.each([
    ['starting', '正在准备', 'blue'],
    ['running', '正在处理', 'blue'],
    ['waiting_input', '等待你的输入', 'orange'],
    ['succeeded', '已完成', 'green'],
    ['failed', '执行失败', 'red'],
    ['cancelled', '已取消', 'grey'],
    ['ambiguous', '结果待确认', 'orange'],
  ] as const)('maps %s to its native header', (phase, title, template) => {
    expect(render(state(phase), context()).header).toEqual({
      template,
      title: { tag: 'plain_text', content: title },
    });
  });

  it('supports English headers and keeps at most four timeline rows', () => {
    const input = state();
    input.timeline = Array.from({ length: 6 }, (_, index) => ({
      key: String(index), label: `Step ${index}`, status: 'completed' as const, count: 1,
    }));
    const card = render(input, context('en'));
    expect(card.header).toMatchObject({ title: { content: 'Working' } });
    const timeline = card.body.elements.filter(element => element.element_id?.startsWith('progress_timeline_'));
    expect(timeline).toHaveLength(4);
  });

  it('shows the complete operation count and caps narration at 240 Unicode characters', () => {
    const input = state();
    input.operationCount = 37;
    input.currentText = '进'.repeat(300);
    const card = render(input, context());
    const serialized = JSON.stringify(card);
    expect(card.body.elements.find(element => element.element_id === 'progress_details')).toEqual({
      tag: 'markdown',
      element_id: 'progress_details',
      content: '已处理 37 个操作',
    });
    expect(serialized).not.toContain('"tag":"note"');
    expect(serialized).toContain('已处理 37 个操作');
    expect(serialized).toContain('进'.repeat(240));
    expect(serialized).not.toContain('进'.repeat(241));
  });

  it('never renders internal reducer metadata or raw provider payloads', () => {
    const input = {
      ...state(),
      command: 'printenv PRIVATE_TOKEN',
      stdout: 'private stdout',
      invocation: { path: '/private/secret' },
      result: 'private result',
      reasoning: 'chain of thought',
    } as ProgressState;
    const serialized = JSON.stringify(render(input, context()));
    expect(serialized).not.toMatch(/printenv|private|chain of thought|operationStates/iu);
  });
});
