import { ErrorBanner, MockNotice } from '../components/ErrorBanner.tsx';
import { formatDateTime } from '../format.ts';
import { getIncident, useAsync } from '../api.ts';
import { Loading } from '../components/Loading.tsx';
import { mockCorrelationIds } from '../mocks.ts';
import { SeverityBadge } from '../components/Badge.tsx';
import { StatCard } from '../components/StatCard.tsx';
import { useState } from 'react';

export function ForensicsView() {
  const [correlationId, setCorrelationId] = useState<string>(mockCorrelationIds[0] ?? '');
  const { data, loading, error, fromMock } = useAsync(
    () => getIncident(correlationId),
    [correlationId],
  );

  return (
    <section aria-labelledby="forensics-heading">
      <header className="view__header">
        <h1 id="forensics-heading">Forensics</h1>
        <p className="view__lede">Reconstruct an incident timeline from a correlation id.</p>
      </header>

      {fromMock && <MockNotice />}

      <div className="toolbar">
        <label className="toolbar__field">
          <span>Correlation</span>
          <select
            value={correlationId}
            onChange={(e) => setCorrelationId(e.target.value)}
            aria-label="Select a correlation id"
          >
            {mockCorrelationIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <Loading label="Reconstructing incident…" />}
      {error !== null && <ErrorBanner message={error} />}

      {!loading && error === null && data !== null && (
        <>
          <div className="hero-card">
            <div>
              <div className="hero-card__label">{data.title}</div>
              <div className="hero-card__meta">
                <code>{data.correlationId}</code> · agents:{' '}
                {data.agents.length > 0 ? data.agents.join(', ') : '—'}
              </div>
            </div>
            <div className="hero-card__badge">
              <SeverityBadge severity={data.peakSeverity} />
            </div>
          </div>

          <div className="stat-grid">
            <StatCard label="Opened" value={formatDateTime(data.openedAt)} />
            <StatCard
              label="Closed"
              value={data.closedAt === null ? 'Open' : formatDateTime(data.closedAt)}
            />
            <StatCard label="Timeline steps" value={data.timeline.length} />
          </div>

          {data.timeline.length === 0 ? (
            <p className="empty">No timeline entries for this correlation id.</p>
          ) : (
            <ol className="timeline">
              {data.timeline.map((entry, i) => (
                <li key={`${entry.timestamp}-${i}`} className="timeline__item">
                  <div className="timeline__marker" aria-hidden="true" />
                  <div className="timeline__body">
                    <div className="timeline__top">
                      <code className="mono">{entry.type}</code>
                      <SeverityBadge severity={entry.severity} />
                    </div>
                    <div className="timeline__time">{formatDateTime(entry.timestamp)}</div>
                    <div className="timeline__summary">{entry.summary}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
