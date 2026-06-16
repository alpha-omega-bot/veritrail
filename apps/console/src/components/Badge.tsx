import type { ReactNode } from 'react';
import type { BudgetState, EventSeverity, RiskBand } from '../types.ts';

type BadgeTone = 'neutral' | 'ok' | 'info' | 'warn' | 'error' | 'critical';

const TONE_FROM_SEVERITY: Record<EventSeverity, BadgeTone> = {
  info: 'info',
  warn: 'warn',
  error: 'error',
  critical: 'critical',
};

const TONE_FROM_RISK: Record<RiskBand, BadgeTone> = {
  low: 'ok',
  moderate: 'info',
  elevated: 'warn',
  high: 'error',
};

const TONE_FROM_BUDGET: Record<BudgetState, BadgeTone> = {
  ok: 'ok',
  warning: 'warn',
  exceeded: 'error',
};

interface BaseProps {
  children: ReactNode;
}

function Pill({ tone, children }: { tone: BadgeTone } & BaseProps) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function SeverityBadge({ severity }: { severity: EventSeverity }) {
  return <Pill tone={TONE_FROM_SEVERITY[severity]}>{severity}</Pill>;
}

export function RiskBandBadge({ band }: { band: RiskBand }) {
  return <Pill tone={TONE_FROM_RISK[band]}>{band}</Pill>;
}

export function BudgetStateBadge({ state }: { state: BudgetState }) {
  return <Pill tone={TONE_FROM_BUDGET[state]}>{state}</Pill>;
}

export function IntegrityBadge({ ok }: { ok: boolean }) {
  return <Pill tone={ok ? 'ok' : 'critical'}>{ok ? 'Verified' : 'Tampered'}</Pill>;
}

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone } & BaseProps) {
  return <Pill tone={tone}>{children}</Pill>;
}
