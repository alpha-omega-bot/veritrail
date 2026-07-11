// Prometheus-style metrics for Veritrail server observability

export interface Metrics {
  // Request metrics
  httpRequestsTotal: number;
  httpRequestDurationMs: number[];
  httpErrorsTotal: number;
  httpRateLimitHitsTotal: number;

  // Ledger metrics
  ledgerEventsTotal: number;
  ledgerAppendDurationMs: number[];
  ledgerAppendErrorsTotal: number;
  ledgerIntegrityChecksTotal: number;
  ledgerIntegrityFailuresTotal: number;

  // Module metrics
  permissionsEvaluationsTotal: number;
  permissionsDeniedsTotal: number;
  spendGuardChecksTotal: number;
  spendGuardBlocksTotal: number;

  // System metrics
  processUptimeMs: number;
  processMemoryUsedBytes: number;
  processCpuUsagePercent: number;
}

export interface MetricsSnapshot extends Metrics {
  timestamp: number;
}

export class MetricsCollector {
  private metrics: Metrics;
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
    this.metrics = {
      httpRequestsTotal: 0,
      httpRequestDurationMs: [],
      httpErrorsTotal: 0,
      httpRateLimitHitsTotal: 0,
      ledgerEventsTotal: 0,
      ledgerAppendDurationMs: [],
      ledgerAppendErrorsTotal: 0,
      ledgerIntegrityChecksTotal: 0,
      ledgerIntegrityFailuresTotal: 0,
      permissionsEvaluationsTotal: 0,
      permissionsDeniedsTotal: 0,
      spendGuardChecksTotal: 0,
      spendGuardBlocksTotal: 0,
      processUptimeMs: 0,
      processMemoryUsedBytes: 0,
      processCpuUsagePercent: 0,
    };
  }

  recordHttpRequest(durationMs: number): void {
    this.metrics.httpRequestsTotal += 1;
    this.metrics.httpRequestDurationMs.push(durationMs);
    // Keep only last 1000 samples for percentile calculations
    if (this.metrics.httpRequestDurationMs.length > 1000) {
      this.metrics.httpRequestDurationMs.shift();
    }
  }

  recordHttpError(): void {
    this.metrics.httpErrorsTotal += 1;
  }

  recordRateLimitHit(): void {
    this.metrics.httpRateLimitHitsTotal += 1;
  }

  recordLedgerAppend(durationMs: number, success: boolean): void {
    if (success) {
      this.metrics.ledgerEventsTotal += 1;
      this.metrics.ledgerAppendDurationMs.push(durationMs);
      if (this.metrics.ledgerAppendDurationMs.length > 1000) {
        this.metrics.ledgerAppendDurationMs.shift();
      }
    } else {
      this.metrics.ledgerAppendErrorsTotal += 1;
    }
  }

  recordIntegrityCheck(passed: boolean): void {
    this.metrics.ledgerIntegrityChecksTotal += 1;
    if (!passed) {
      this.metrics.ledgerIntegrityFailuresTotal += 1;
    }
  }

  recordPermissionsEvaluation(allowed: boolean): void {
    this.metrics.permissionsEvaluationsTotal += 1;
    if (!allowed) {
      this.metrics.permissionsDeniedsTotal += 1;
    }
  }

  recordSpendGuardCheck(allowed: boolean): void {
    this.metrics.spendGuardChecksTotal += 1;
    if (!allowed) {
      this.metrics.spendGuardBlocksTotal += 1;
    }
  }

  snapshot(): MetricsSnapshot {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    return {
      ...this.metrics,
      processUptimeMs: Date.now() - this.startTime,
      processMemoryUsedBytes: memUsage.heapUsed,
      processCpuUsagePercent: (cpuUsage.user + cpuUsage.system) / 1000000, // Convert to seconds
      timestamp: Date.now(),
    };
  }

  getPrometheusMetrics(): string {
    const snap = this.snapshot();
    const lines: string[] = [];

    lines.push('# HELP veritrail_http_requests_total Total HTTP requests');
    lines.push('# TYPE veritrail_http_requests_total counter');
    lines.push(`veritrail_http_requests_total ${snap.httpRequestsTotal}`);

    lines.push('# HELP veritrail_http_errors_total Total HTTP errors');
    lines.push('# TYPE veritrail_http_errors_total counter');
    lines.push(`veritrail_http_errors_total ${snap.httpErrorsTotal}`);

    lines.push('# HELP veritrail_http_rate_limit_hits_total Total rate limit hits');
    lines.push('# TYPE veritrail_http_rate_limit_hits_total counter');
    lines.push(`veritrail_http_rate_limit_hits_total ${snap.httpRateLimitHitsTotal}`);

    if (snap.httpRequestDurationMs.length > 0) {
      const sorted = [...snap.httpRequestDurationMs].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];

      lines.push('# HELP veritrail_http_request_duration_ms HTTP request duration');
      lines.push('# TYPE veritrail_http_request_duration_ms summary');
      lines.push(`veritrail_http_request_duration_ms{quantile="0.5"} ${p50}`);
      lines.push(`veritrail_http_request_duration_ms{quantile="0.95"} ${p95}`);
      lines.push(`veritrail_http_request_duration_ms{quantile="0.99"} ${p99}`);
    }

    lines.push('# HELP veritrail_ledger_events_total Total ledger events appended');
    lines.push('# TYPE veritrail_ledger_events_total counter');
    lines.push(`veritrail_ledger_events_total ${snap.ledgerEventsTotal}`);

    lines.push('# HELP veritrail_ledger_append_errors_total Total ledger append errors');
    lines.push('# TYPE veritrail_ledger_append_errors_total counter');
    lines.push(`veritrail_ledger_append_errors_total ${snap.ledgerAppendErrorsTotal}`);

    lines.push('# HELP veritrail_ledger_integrity_checks_total Total integrity checks');
    lines.push('# TYPE veritrail_ledger_integrity_checks_total counter');
    lines.push(`veritrail_ledger_integrity_checks_total ${snap.ledgerIntegrityChecksTotal}`);

    lines.push('# HELP veritrail_ledger_integrity_failures_total Total integrity failures');
    lines.push('# TYPE veritrail_ledger_integrity_failures_total counter');
    lines.push(`veritrail_ledger_integrity_failures_total ${snap.ledgerIntegrityFailuresTotal}`);

    lines.push('# HELP veritrail_permissions_evaluations_total Total permissions evaluations');
    lines.push('# TYPE veritrail_permissions_evaluations_total counter');
    lines.push(`veritrail_permissions_evaluations_total ${snap.permissionsEvaluationsTotal}`);

    lines.push('# HELP veritrail_permissions_denieds_total Total permissions denials');
    lines.push('# TYPE veritrail_permissions_denieds_total counter');
    lines.push(`veritrail_permissions_denieds_total ${snap.permissionsDeniedsTotal}`);

    lines.push('# HELP veritrail_spend_guard_checks_total Total spend guard checks');
    lines.push('# TYPE veritrail_spend_guard_checks_total counter');
    lines.push(`veritrail_spend_guard_checks_total ${snap.spendGuardChecksTotal}`);

    lines.push('# HELP veritrail_spend_guard_blocks_total Total spend guard blocks');
    lines.push('# TYPE veritrail_spend_guard_blocks_total counter');
    lines.push(`veritrail_spend_guard_blocks_total ${snap.spendGuardBlocksTotal}`);

    lines.push('# HELP veritrail_process_uptime_ms Process uptime in milliseconds');
    lines.push('# TYPE veritrail_process_uptime_ms gauge');
    lines.push(`veritrail_process_uptime_ms ${snap.processUptimeMs}`);

    lines.push('# HELP veritrail_process_memory_used_bytes Process memory used in bytes');
    lines.push('# TYPE veritrail_process_memory_used_bytes gauge');
    lines.push(`veritrail_process_memory_used_bytes ${snap.processMemoryUsedBytes}`);

    return lines.join('\n') + '\n';
  }
}
