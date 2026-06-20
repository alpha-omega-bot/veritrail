import { ForensicsView } from './views/ForensicsView.tsx';
import { LedgerView } from './views/LedgerView.tsx';
import { OverviewView } from './views/OverviewView.tsx';
import { SpendView } from './views/SpendView.tsx';
import { VendorRiskView } from './views/VendorRiskView.tsx';
import { useEffect, useState } from 'react';
import AppLayout from '@cloudscape-design/components/app-layout';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import TopNavigation from '@cloudscape-design/components/top-navigation';

export type ViewId = 'overview' | 'ledger' | 'spend' | 'vendor-risk' | 'forensics';

interface NavItem {
  id: ViewId;
  label: string;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { id: 'overview', label: 'Overview' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'spend', label: 'Spend' },
  { id: 'vendor-risk', label: 'Vendor Risk' },
  { id: 'forensics', label: 'Forensics' },
];

const VIEW_IDS: ReadonlyArray<ViewId> = NAV_ITEMS.map((i) => i.id);

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
    <>
      <div id="top-nav">
        <TopNavigation
          identity={{
            href: '#/overview',
            title: 'Veritrail',
            logo: { src: LOGO_SRC, alt: 'Veritrail' },
          }}
          utilities={[
            {
              type: 'button',
              text: 'Trust & control plane for AI agents',
              disableUtilityCollapse: true,
            },
          ]}
        />
      </div>
      <AppLayout
        headerSelector="#top-nav"
        toolsHide
        navigationWidth={240}
        navigation={
          <SideNavigation
            activeHref={`#/${view}`}
            header={{ href: '#/overview', text: 'Console' }}
            items={NAV_ITEMS.map((item) => ({
              type: 'link',
              text: item.label,
              href: `#/${item.id}`,
            }))}
          />
        }
        content={renderView(view)}
        ariaLabels={{ navigation: 'Primary', navigationToggle: 'Open navigation' }}
      />
    </>
  );
}

// Inline SVG "V" mark in Cloudscape blue, encoded as a data URI for the top-nav logo.
const LOGO_SRC =
  'data:image/svg+xml;base64,' +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
      `<rect width="28" height="28" rx="5" fill="#0972d3"/>` +
      `<path d="M7 8 L14 20 L21 8" fill="none" stroke="#fff" stroke-width="2.6" ` +
      `stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );
