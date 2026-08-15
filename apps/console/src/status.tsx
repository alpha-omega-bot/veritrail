import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { RiskBand, VendorSignalSeverity } from './types.ts';

type IndicatorType = React.ComponentProps<typeof StatusIndicator>['type'];

/** Vendor risk bands as the scoring engine actually emits them. */
const RISK_TYPE: Record<RiskBand, IndicatorType> = {
  low: 'success',
  medium: 'info',
  high: 'warning',
  critical: 'error',
};

/** Severity attached to an individual vendor signal. */
const SIGNAL_TYPE: Record<VendorSignalSeverity, IndicatorType> = {
  info: 'info',
  low: 'success',
  medium: 'info',
  high: 'warning',
  critical: 'error',
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function RiskBandStatus({ band }: { band: RiskBand }) {
  return <StatusIndicator type={RISK_TYPE[band]}>{titleCase(band)}</StatusIndicator>;
}

export function SignalSeverityStatus({ severity }: { severity: VendorSignalSeverity }) {
  return <StatusIndicator type={SIGNAL_TYPE[severity]}>{titleCase(severity)}</StatusIndicator>;
}

/**
 * Whether a budget has passed its limit. Derived from the server's `exceeded`
 * flag rather than recomputed client-side, so the console never disagrees with
 * the engine that actually enforces the budget.
 */
export function BudgetStateStatus({ exceeded }: { exceeded: boolean }) {
  return (
    <StatusIndicator type={exceeded ? 'error' : 'success'}>
      {exceeded ? 'Exceeded' : 'Within limit'}
    </StatusIndicator>
  );
}

/**
 * Hash-chain verification state. There is deliberately no "unknown" rendering
 * path here: callers must not render this component unless the server returned
 * a real verification result.
 */
export function IntegrityStatus({ ok }: { ok: boolean }) {
  return (
    <StatusIndicator type={ok ? 'success' : 'error'}>
      {ok ? 'Verified' : 'Integrity failure'}
    </StatusIndicator>
  );
}
