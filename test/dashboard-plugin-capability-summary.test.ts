import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PluginCapabilityList } from '../src/dashboard/web/plugin-capability-list.js';

type CapabilityListProps = React.ComponentProps<typeof PluginCapabilityList>;

const commonProps: CapabilityListProps = {
  skillsCount: 0,
  mcpCount: 0,
  dashboardCount: 0,
  contributions: {},
  hasService: false,
};

function renderCapabilityList(overrides: Partial<CapabilityListProps> = {}): string {
  const props: CapabilityListProps = {
    ...commonProps,
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(PluginCapabilityList, props));
}

describe('dashboard plugin capability summary', () => {
  it('shows the turn progress contribution as a capability', () => {
    const markup = renderCapabilityList({
      contributions: { turnProgress: { entry: 'turn-progress/index.js' } },
    });

    expect(markup).toContain('<strong>1</strong>进度卡');
    expect(markup).not.toContain('未声明扩展能力');
  });

  it('shows the Lark contribution as a capability', () => {
    const markup = renderCapabilityList({
      contributions: { lark: { entry: 'lark/index.js' } },
    });

    expect(markup).toContain('<strong>1</strong>飞书协同');
    expect(markup).not.toContain('未声明扩展能力');
  });

  it('keeps the empty capability hint without contributions', () => {
    const markup = renderCapabilityList();

    expect(markup).toContain('未声明扩展能力');
  });
});
