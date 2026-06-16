import { ForensicsView } from './views/ForensicsView.tsx';
import { LedgerView } from './views/LedgerView.tsx';
import { Nav, VIEW_IDS } from './components/Nav.tsx';
import { OverviewView } from './views/OverviewView.tsx';
import { SpendView } from './views/SpendView.tsx';
import { useEffect, useState } from 'react';
import { VendorRiskView } from './views/VendorRiskView.tsx';
import type { ViewId } from './components/Nav.tsx';

function isViewId(value: string): value is ViewId {
  return (VIEW_IDS as ReadonlyArray<string>).includes(value);
}

function readHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return isViewId(raw) ? raw : 'overview';
}

function renderView(view: ViewId) {
  switch (view) {
    case 'overview':
      return <OverviewView />;
    case 'ledger':
      return <LedgerView />;
    case 'spend':
      return <SpendView />;
    case 'vendor-risk':
      return <VendorRiskView />;
    case 'forensics':
      return <ForensicsView />;
  }
}

export function App() {
  const [view, setView] = useState<ViewId>(readHash);

  useEffect(() => {
    const onHashChange = () => setView(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div className="app">
      <Nav current={view} />
      <main className="content" id="main">
        {renderView(view)}
      </main>
    </div>
  );
}
