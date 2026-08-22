import { describe, expect, it } from 'vitest';
import {
  canDeliverFinalInProgressCard,
  canStartTurnProgress,
  type TurnProgressEligibilityInput,
} from '../src/core/turn-progress/eligibility.js';

const ordinary: TurnProgressEligibilityInput = {
  pluginId: 'semantic-progress',
  larkTransport: true,
  http: false,
  docComment: false,
  vcReceiver: false,
  vcListener: false,
  substitute: false,
  managedOrSilent: false,
};

describe('turn progress eligibility', () => {
  it('allows only an enabled plugin on an ordinary Lark IM turn', () => {
    expect(canStartTurnProgress(ordinary)).toBe(true);
    for (const ineligible of [
      { pluginId: undefined },
      { larkTransport: false },
      { http: true },
      { docComment: true },
      { vcReceiver: true },
      { vcListener: true },
      { substitute: true },
      { managedOrSilent: true },
    ]) {
      expect(canStartTurnProgress({ ...ordinary, ...ineligible }), JSON.stringify(ineligible)).toBe(false);
    }
  });

  it('reuses start eligibility and additionally excludes suppressed or superseded finals', () => {
    expect(canDeliverFinalInProgressCard(ordinary)).toBe(true);
    expect(canDeliverFinalInProgressCard({ ...ordinary, suppressDelivery: true })).toBe(false);
    expect(canDeliverFinalInProgressCard({ ...ordinary, steerSuperseded: true })).toBe(false);
    expect(canDeliverFinalInProgressCard({ ...ordinary, http: true })).toBe(false);
  });
});
