import type React from 'react';

interface PluginCapabilityListProps {
  skillsCount: number;
  mcpCount: number;
  dashboardCount: number;
  contributions?: {
    cli?: { commands?: readonly unknown[] };
    turnProgress?: { entry?: string };
    lark?: { entry?: string };
  };
  hasService: boolean;
}

export function PluginCapabilityList(props: PluginCapabilityListProps): React.JSX.Element {
  const capabilities = [
    { label: 'Skills', count: props.skillsCount },
    { label: 'MCP', count: props.mcpCount },
    { label: '命令', count: props.contributions?.cli?.commands?.length ?? 0 },
    { label: 'Dashboard', count: props.dashboardCount },
    { label: '进度卡', count: props.contributions?.turnProgress ? 1 : 0 },
    { label: '飞书协同', count: props.contributions?.lark ? 1 : 0 },
  ].filter(item => item.count > 0);
  return (
    <>
      {capabilities.map(item => (
        <span className="plugin-capability-chip" key={item.label}><strong>{item.count}</strong>{item.label}</span>
      ))}
      {capabilities.length === 0 && !props.hasService
        ? <span className="plugin-muted">未声明扩展能力</span>
        : null}
    </>
  );
}
