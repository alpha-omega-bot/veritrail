import { notFoundError, type EventType } from '@veritrail/core';

/**
 * Severity of a control's evidence requirement.
 *
 * - `must` controls fail the report when no evidence is found and are
 *   surfaced as compliance gaps that must be remediated before audit.
 * - `should` controls are recommended best practices; their absence is
 *   flagged but does not by itself fail an audit cycle.
 */
export type ControlSeverity = 'must' | 'should';

/**
 * A single auditable control inside a framework. The `requiredEventTypes`
 * list is the operational claim: if the ledger contains at least one event
 * of every type listed here within the report window, Veritrail can show
 * the auditor cryptographic evidence the control was exercised.
 */
export interface Control {
  /** Stable control identifier shaped as `<framework>.<section>.<n>`. */
  readonly id: string;
  /** Short human-readable name (e.g. "Change authorization"). */
  readonly name: string;
  /** What the control attests to, in one or two plain sentences. */
  readonly description: string;
  /** Ledger event types whose presence proves this control was exercised. */
  readonly requiredEventTypes: readonly EventType[];
  /** Severity used to compute gaps and the overall compliance score. */
  readonly severity: ControlSeverity;
}

/**
 * A versioned bundle of controls representing a single compliance framework
 * or framework section. Frameworks are intentionally compact: they declare
 * the controls Veritrail's ledger can attest to via event-type presence,
 * not the full set of organizational controls.
 */
export interface Framework {
  /** Stable framework identifier (e.g. `soc2-cc7`). */
  readonly id: string;
  /** Display name shown on reports. */
  readonly name: string;
  /** Version or revision of the underlying criteria. */
  readonly version: string;
  /** Controls covered by this template. */
  readonly controls: readonly Control[];
}

/**
 * SOC 2 Trust Services Criteria — Common Criteria 7: System Operations.
 * Control ids follow the AICPA 2017 TSC with 2022 Points of Focus.
 */
const SOC2_CC7: Framework = {
  id: 'soc2-cc7',
  name: 'SOC 2 — Common Criteria 7 (System Operations)',
  version: '2017 TSC (2022 PoF)',
  controls: [
    {
      id: 'SOC2.CC7.1',
      name: 'Detection of configuration and operational changes',
      description:
        'The entity uses detection and monitoring procedures to identify changes to configurations that could introduce new vulnerabilities.',
      requiredEventTypes: ['admin.action', 'policy.evaluated'],
      severity: 'must',
    },
    {
      id: 'SOC2.CC7.2',
      name: 'Monitoring of system components',
      description:
        'The entity monitors system components and operations for anomalies indicative of malicious acts, natural disasters, and errors.',
      requiredEventTypes: ['action.executed', 'action.failed'],
      severity: 'must',
    },
    {
      id: 'SOC2.CC7.3',
      name: 'Evaluation of security events',
      description:
        'The entity evaluates security events to determine whether they could or have resulted in a failure to meet objectives.',
      requiredEventTypes: ['action.denied', 'policy.evaluated'],
      severity: 'must',
    },
    {
      id: 'SOC2.CC7.4',
      name: 'Incident response',
      description:
        'The entity responds to identified security incidents by executing a defined incident response program.',
      requiredEventTypes: ['action.failed', 'decision.recorded'],
      severity: 'must',
    },
    {
      id: 'SOC2.CC7.5',
      name: 'Recovery from identified incidents',
      description:
        'The entity identifies, develops, and implements activities to recover from identified security incidents.',
      requiredEventTypes: ['action.rolled_back'],
      severity: 'should',
    },
    {
      id: 'SOC2.CC7.6',
      name: 'Authorized administrative actions',
      description:
        'Privileged administrative actions are authorized and logged with sufficient detail to be reviewed.',
      requiredEventTypes: ['admin.action', 'action.authorized'],
      severity: 'should',
    },
  ],
};

/**
 * EU AI Act — Annex IV technical documentation requirements for high-risk
 * AI systems. Item numbers follow the consolidated text of Regulation
 * (EU) 2024/1689, Annex IV §1–§9.
 */
const EU_AI_ACT_ANNEX_IV: Framework = {
  id: 'eu-ai-act-annex-iv',
  name: 'EU AI Act — Annex IV (Technical documentation)',
  version: 'Regulation (EU) 2024/1689',
  controls: [
    {
      id: 'EU-AI-ACT.AnnexIV.2c',
      name: 'Logs of automated decisions',
      description:
        'Annex IV §2(c): description of the decisions and outputs produced by the system, including a log retained for the lifetime of the system.',
      requiredEventTypes: ['decision.recorded', 'action.executed'],
      severity: 'must',
    },
    {
      id: 'EU-AI-ACT.AnnexIV.2g',
      name: 'Human oversight measures',
      description:
        'Annex IV §2(g): the human oversight measures needed, including the technical measures put in place to facilitate the interpretation of outputs.',
      requiredEventTypes: ['action.authorized', 'action.denied'],
      severity: 'must',
    },
    {
      id: 'EU-AI-ACT.AnnexIV.3',
      name: 'Risk management and post-market monitoring',
      description:
        'Annex IV §3 and §9: evidence of continuous risk management and post-market monitoring of the AI system.',
      requiredEventTypes: ['policy.evaluated', 'vendor.signal'],
      severity: 'must',
    },
    {
      id: 'EU-AI-ACT.AnnexIV.5',
      name: 'Validation and testing data record-keeping',
      description:
        'Annex IV §5: detailed information about the validation and testing data used, including their characteristics and provenance.',
      requiredEventTypes: ['evidence.attached'],
      severity: 'should',
    },
    {
      id: 'EU-AI-ACT.AnnexIV.6',
      name: 'Cybersecurity and resilience controls',
      description:
        'Annex IV §6: cybersecurity measures put in place to ensure resilience against attempts by unauthorized third parties.',
      requiredEventTypes: ['action.denied', 'admin.action'],
      severity: 'must',
    },
  ],
};

/**
 * HIPAA Security Rule — administrative and technical safeguards under
 * 45 CFR §164.308 and §164.312 that map to ledger-observable behaviour.
 */
const HIPAA_SECURITY: Framework = {
  id: 'hipaa-security',
  name: 'HIPAA Security Rule',
  version: '45 CFR Part 164 Subpart C',
  controls: [
    {
      id: 'HIPAA.164.308.a.1.ii.D',
      name: 'Information system activity review',
      description:
        '§164.308(a)(1)(ii)(D): regular review of records of information system activity such as audit logs and access reports.',
      requiredEventTypes: ['action.executed', 'admin.action'],
      severity: 'must',
    },
    {
      id: 'HIPAA.164.308.a.6',
      name: 'Security incident procedures',
      description:
        '§164.308(a)(6): identify and respond to suspected or known security incidents and mitigate their harmful effects.',
      requiredEventTypes: ['action.failed', 'decision.recorded'],
      severity: 'must',
    },
    {
      id: 'HIPAA.164.312.a.1',
      name: 'Access control',
      description:
        '§164.312(a)(1): technical policies and procedures that allow only authorized persons or software to access ePHI.',
      requiredEventTypes: ['action.authorized', 'action.denied'],
      severity: 'must',
    },
    {
      id: 'HIPAA.164.312.b',
      name: 'Audit controls',
      description:
        '§164.312(b): hardware, software, and procedural mechanisms that record and examine activity in systems that contain ePHI.',
      requiredEventTypes: ['policy.evaluated', 'action.executed'],
      severity: 'must',
    },
    {
      id: 'HIPAA.164.312.c.1',
      name: 'Integrity controls',
      description:
        '§164.312(c)(1): policies and procedures to protect ePHI from improper alteration or destruction.',
      requiredEventTypes: ['evidence.attached', 'action.rolled_back'],
      severity: 'should',
    },
  ],
};

/**
 * ISO/IEC 42001:2023 — AI Management System (AIMS). Control numbers follow
 * Annex A of the published standard.
 */
const ISO_42001: Framework = {
  id: 'iso-42001',
  name: 'ISO/IEC 42001:2023 — AI Management System',
  version: '2023 edition',
  controls: [
    {
      id: 'ISO-42001.A.6.2.6',
      name: 'AI system operation and monitoring',
      description:
        'Annex A.6.2.6: ensure that AI systems are operated and monitored according to defined requirements.',
      requiredEventTypes: ['action.executed', 'action.failed'],
      severity: 'must',
    },
    {
      id: 'ISO-42001.A.6.2.8',
      name: 'AI system recording of event logs',
      description:
        'Annex A.6.2.8: record events automatically generated by the AI system during operation.',
      requiredEventTypes: ['decision.recorded', 'evidence.attached'],
      severity: 'must',
    },
    {
      id: 'ISO-42001.A.9.2',
      name: 'Resources for AI systems',
      description:
        'Annex A.9.2: identify, monitor, and govern the resources required to operate AI systems including budgets and quotas.',
      requiredEventTypes: ['budget.charged', 'budget.exceeded'],
      severity: 'should',
    },
    {
      id: 'ISO-42001.A.10.3',
      name: 'Third-party and supplier obligations',
      description:
        'Annex A.10.3: ensure that suppliers, partners, and third parties involved with AI systems meet defined obligations.',
      requiredEventTypes: ['vendor.registered', 'vendor.signal'],
      severity: 'must',
    },
    {
      id: 'ISO-42001.B.7.4',
      name: 'Human oversight of AI decisions',
      description:
        'Annex B.7.4: implement human oversight mechanisms for AI decisions, including approval and override.',
      requiredEventTypes: ['action.authorized', 'action.denied'],
      severity: 'must',
    },
  ],
};

/** Identifier of a built-in framework template. */
export type FrameworkId = 'soc2-cc7' | 'eu-ai-act-annex-iv' | 'hipaa-security' | 'iso-42001';

/**
 * The built-in framework templates. Each is a curated, compact slice of the
 * underlying criteria — enough to demonstrate ledger-backed evidence without
 * claiming to be a full audit checklist.
 */
export const FRAMEWORK_TEMPLATES: Readonly<Record<FrameworkId, Framework>> = {
  'soc2-cc7': SOC2_CC7,
  'eu-ai-act-annex-iv': EU_AI_ACT_ANNEX_IV,
  'hipaa-security': HIPAA_SECURITY,
  'iso-42001': ISO_42001,
};

/** All built-in framework ids in stable display order. */
export const FRAMEWORK_IDS: readonly FrameworkId[] = [
  'soc2-cc7',
  'eu-ai-act-annex-iv',
  'hipaa-security',
  'iso-42001',
];

/**
 * Look up a framework by id and return it, or `null` when the id is not one
 * of the built-in templates. Callers that need to fail loudly should use
 * {@link requireFramework} instead.
 */
export function getFramework(id: string): Framework | null {
  return (FRAMEWORK_TEMPLATES as Record<string, Framework>)[id] ?? null;
}

/**
 * Look up a framework by id, throwing a `VeritrailError` with code
 * `NOT_FOUND` when the id is unknown. Useful at API boundaries where an
 * unknown framework is a caller error.
 */
export function requireFramework(id: string): Framework {
  const framework = getFramework(id);
  if (framework === null) {
    throw notFoundError(`unknown framework: ${id}`);
  }
  return framework;
}
