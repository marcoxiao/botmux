export interface TurnProgressEligibilityInput {
  pluginId?: string;
  larkTransport: boolean;
  http: boolean;
  docComment: boolean;
  vcReceiver: boolean;
  vcListener: boolean;
  substitute: boolean;
  managedOrSilent: boolean;
  suppressDelivery?: boolean;
  steerSuperseded?: boolean;
}

export function canStartTurnProgress(input: TurnProgressEligibilityInput): boolean {
  return !!input.pluginId
    && input.larkTransport
    && !input.http
    && !input.docComment
    && !input.vcReceiver
    && !input.vcListener
    && !input.substitute
    && !input.managedOrSilent;
}

export function canDeliverFinalInProgressCard(input: TurnProgressEligibilityInput): boolean {
  return canStartTurnProgress(input)
    && input.suppressDelivery !== true
    && input.steerSuperseded !== true;
}
