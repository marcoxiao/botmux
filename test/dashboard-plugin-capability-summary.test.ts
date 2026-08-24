import React from 'react';
import TestRenderer, { act, type ReactTestRendererJSON, type ReactTestRendererNode } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import * as pluginPage from '../src/dashboard/web/plugin-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const commonProps = {
  globalEnabled: false,
  enabledBotCount: 0,
  botCount: 1,
};

function collectJsonText(node: ReactTestRendererNode | ReactTestRendererNode[] | null): string {
  if (node === null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectJsonText).join('');
  return collectJsonText((node as ReactTestRendererJSON).children);
}

function renderCapabilitySummary(plugin: Record<string, unknown>): string {
  const Component = (pluginPage as any).PluginCapabilitySummary;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Component, { ...commonProps, plugin } as any));
  });
  const text = collectJsonText(renderer.toJSON());
  act(() => renderer.unmount());
  return text;
}

describe('dashboard plugin capability summary', () => {
  it('exports the capability summary component', () => {
    expect((pluginPage as Record<string, unknown>).PluginCapabilitySummary).toBeTypeOf('function');
  });

  it('shows the turn progress contribution as a capability', () => {
    const text = renderCapabilitySummary({ contributions: { turnProgress: { entry: 'turn-progress/index.js' } } });

    expect(text).toContain('1进度卡');
    expect(text).not.toContain('未声明扩展能力');
  });

  it('shows the Lark contribution as a capability', () => {
    const text = renderCapabilitySummary({ contributions: { lark: { entry: 'lark/index.js' } } });

    expect(text).toContain('1飞书协同');
    expect(text).not.toContain('未声明扩展能力');
  });

  it('keeps the empty capability hint without contributions', () => {
    const text = renderCapabilitySummary({ contributions: {} });

    expect(text).toContain('未声明扩展能力');
  });
});
