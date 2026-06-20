import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { BudgetState, EventSeverity, RiskBand } from './types.ts';

type IndicatorType = React.ComponentProps<typeof StatusIndicator>['type'];

const SEVERITY_TYPE: Record<EventSeverity, IndicatorType> = {
  info: 'info',
  warn: 'warning',
  error: 'error',
  critical: 'error',
};

const RISK_TYPE: Record<RiskBand, IndicatorType> = {
  low: 'success',
  moderate: 'info',
  elevated: 'warning',
  high: 'error',
};

const BUDGET_TYPE: Record<BudgetState, IndicatorType> = {
  ok: 'success',
  warning: 'warning',
  exceeded: 'error',
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function SeverityStatus({ severity }: { severity: EventSeverity }) {
  return <StatusIndicator type={SEVERITY_TYPE[severity]}>{titleCase(severity)}</StatusIndicator>;
}

export function RiskBandStatus({ band }: { band: RiskBand }) {
  return <StatusIndicator type={RISK_TYPE[band]}>{titleCase(band)}</StatusIndicator>;
}

export function BudgetStateStatus({ state }: { state: BudgetState }) {
  return <StatusIndicator type={BUDGET_TYPE[state]}>{titleCase(state)}</StatusIndicator>;
}

export function IntegrityStatus({ ok }: { ok: boolean }) {
  return (
    <StatusIndicator type={ok ? 'success' : 'error'}>
      {ok ? 'Verified' : 'Tampered'}
    </StatusIndicator>
  );
}
