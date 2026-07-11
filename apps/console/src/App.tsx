import { useEffect, useState, lazy, Suspense } from 'react';
import AppLayout from '@cloudscape-design/components/app-layout';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import Spinner from '@cloudscape-design/components/spinner';
import Box from '@cloudscape-design/components/box';

import { AuthProvider, useAuth, type Session } from './auth/AuthContext.tsx';
import { LoginView } from './auth/LoginView.tsx';
import { MagicLinkView } from './auth/MagicLinkView.tsx';

const OverviewView = lazy(() =>
  import('./views/OverviewView.tsx').then((m) => ({ default: m.OverviewView })),
);
const LedgerView = lazy(() =>
  import('./views/LedgerView.tsx').then((m) => ({ default: m.LedgerView })),
);
const SpendView = lazy(() =>
  import('./views/SpendView.tsx').then((m) => ({ default: m.SpendView })),
);
const VendorRiskView = lazy(() =>
  import('./views/VendorRiskView.tsx').then((m) => ({ default: m.VendorRiskView })),
);
const ForensicsView = lazy(() =>
  import('./views/ForensicsView.tsx').then((m) => ({ default: m.ForensicsView })),
);
const PoliciesView = lazy(() =>
  import('./views/PoliciesView.tsx').then((m) => ({ default: m.PoliciesView })),
);
const ComplianceView = lazy(() =>
  import('./views/ComplianceView.tsx').then((m) => ({ default: m.ComplianceView })),
);
const ReceiptsView = lazy(() =>
  import('./views/ReceiptsView.tsx').then((m) => ({ default: m.ReceiptsView })),
);
const SimulatorView = lazy(() =>
  import('./views/SimulatorView.tsx').then((m) => ({ default: m.SimulatorView })),
);
const IncidentRcaView = lazy(() =>
  import('./views/IncidentRcaView.tsx').then((m) => ({ default: m.IncidentRcaView })),
);
const ApiKeysView = lazy(() =>
  import('./views/ApiKeysView.tsx').then((m) => ({ default: m.ApiKeysView })),
);
const BillingView = lazy(() =>
  import('./views/BillingView.tsx').then((m) => ({ default: m.BillingView })),
);
const TeamView = lazy(() => import('./views/TeamView.tsx').then((m) => ({ default: m.TeamView })));
const SettingsView = lazy(() =>
  import('./views/SettingsView.tsx').then((m) => ({ default: m.SettingsView })),
);
const OnboardingView = lazy(() =>
  import('./views/OnboardingView.tsx').then((m) => ({ default: m.OnboardingView })),
);
const WebhooksView = lazy(() =>
  import('./views/WebhooksManageView.tsx').then((m) => ({ default: m.WebhooksManageView })),
);
const UsageAnalyticsView = lazy(() =>
  import('./views/UsageAnalyticsView.tsx').then((m) => ({ default: m.UsageAnalyticsView })),
);

export type ViewId =
  | 'overview'
  | 'ledger'
  | 'spend'
  | 'vendor-risk'
  | 'forensics'
  | 'policies'
  | 'compliance'
  | 'receipts'
  | 'simulator'
  | 'rca'
  | 'webhooks'
  | 'usage'
  | 'api-keys'
  | 'billing'
  | 'team'
  | 'settings'
  | 'onboarding'
  | 'login'
  | 'magic-link';

interface NavItem {
  id: ViewId;
  label: string;
  authRequired?: boolean;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { id: 'overview', label: 'Overview' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'spend', label: 'Spend' },
  { id: 'vendor-risk', label: 'Vendor Risk' },
  { id: 'forensics', label: 'Forensics' },
  { id: 'policies', label: 'Policies', authRequired: true },
  { id: 'simulator', label: 'Simulator', authRequired: true },
  { id: 'rca', label: 'AI RCA', authRequired: true },
  { id: 'receipts', label: 'Receipts', authRequired: true },
  { id: 'compliance', label: 'Compliance', authRequired: true },
  { id: 'webhooks', label: 'Webhooks', authRequired: true },
  { id: 'usage', label: 'Usage', authRequired: true },
  { id: 'api-keys', label: 'API Keys', authRequired: true },
  { id: 'team', label: 'Team', authRequired: true },
  { id: 'billing', label: 'Billing', authRequired: true },
  { id: 'settings', label: 'Settings', authRequired: true },
];

const VIEW_IDS = NAV_ITEMS.map((i) => i.id).concat([
  'onboarding',
  'login',
  'magic-link',
]) as ReadonlyArray<ViewId>;

function isViewId(value: string): value is ViewId {
  return (VIEW_IDS as ReadonlyArray<string>).includes(value);
}

function readHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return isViewId(raw) ? raw : 'overview';
}

function renderView(view: ViewId, onDemo: () => void) {
  const fallback = (
    <Box textAlign="center" padding={{ vertical: 'xxl' }}>
      <Spinner size="large" />
    </Box>
  );
  const wrap = (node: React.ReactNode) => <Suspense fallback={fallback}>{node}</Suspense>;
  switch (view) {
    case 'overview':
      return wrap(<OverviewView />);
    case 'ledger':
      return wrap(<LedgerView />);
    case 'spend':
      return wrap(<SpendView />);
    case 'vendor-risk':
      return wrap(<VendorRiskView />);
    case 'forensics':
      return wrap(<ForensicsView />);
    case 'policies':
      return wrap(<PoliciesView />);
    case 'compliance':
      return wrap(<ComplianceView />);
    case 'receipts':
      return wrap(<ReceiptsView />);
    case 'simulator':
      return wrap(<SimulatorView />);
    case 'rca':
      return wrap(<IncidentRcaView />);
    case 'webhooks':
      return wrap(<WebhooksView />);
    case 'usage':
      return wrap(<UsageAnalyticsView />);
    case 'api-keys':
      return wrap(<ApiKeysView />);
    case 'billing':
      return wrap(<BillingView />);
    case 'team':
      return wrap(<TeamView />);
    case 'settings':
      return wrap(<SettingsView />);
    case 'onboarding':
      return wrap(<OnboardingView />);
    case 'login':
      return <LoginView onDemo={onDemo} />;
    case 'magic-link':
      return wrap(<MagicLinkView />);
  }
}

function AppShell() {
  const { session, loading, logout, setCurrentOrgProject } = useAuth();
  const [view, setView] = useState<ViewId>(readHash);
  const [demoOverride, setDemoOverride] = useState(false);

  useEffect(() => {
    const onHashChange = () => setView(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const viewLabel = NAV_ITEMS.find((item) => item.id === view)?.label ?? 'Veritrail';
    document.title = `${viewLabel} - Veritrail Console`;
  }, [view]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key >= '1' && e.key <= '5') {
        e.preventDefault();
        const index = parseInt(e.key, 10) - 1;
        const targetView = NAV_ITEMS[index];
        if (targetView) {
          window.location.hash = `#/${targetView.id}`;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onSwitchOrg = (e: Event) => {
      const detail = (e as CustomEvent<{ orgId: string }>).detail;
      if (detail?.orgId) setCurrentOrgProject(detail.orgId, null);
    };
    window.addEventListener('veritrail:switch-org', onSwitchOrg);
    return () => window.removeEventListener('veritrail:switch-org', onSwitchOrg);
  }, [setCurrentOrgProject]);

  if (loading) {
    return (
      <Box padding={{ vertical: 'xxxl' }} textAlign="center">
        <Spinner size="large" />
      </Box>
    );
  }

  // Anonymous (no session) AND not in demo mode → land on the login screen.
  // The user can choose "Continue in demo mode" to see the sample data.
  if (!session && !demoOverride && view !== 'magic-link' && view !== 'login') {
    return <LoginView onDemo={() => setDemoOverride(true)} />;
  }

  if (view === 'login' && !session) {
    return <LoginView onDemo={() => setDemoOverride(true)} />;
  }

  const utilities = buildUtilities(session, () => {
    setDemoOverride(false);
    logout();
  });

  const navItems = NAV_ITEMS.filter((item) => !item.authRequired || session !== null);

  return (
    <>
      <div id="top-nav">
        <TopNavigation
          identity={{
            href: '#/overview',
            title: 'Veritrail',
            logo: { src: LOGO_SRC, alt: 'Veritrail' },
          }}
          utilities={utilities}
        />
      </div>
      <AppLayout
        headerSelector="#top-nav"
        toolsHide
        navigationWidth={240}
        navigation={
          <SideNavigation
            activeHref={`#/${view}`}
            header={{
              href: '#/overview',
              text: session?.orgs.find((o) => o.id === session.currentOrgId)?.name ?? 'Console',
            }}
            items={[
              ...buildProjectSwitcher(session, setCurrentOrgProject),
              ...navItems.map((item) => ({
                type: 'link' as const,
                text: item.label,
                href: `#/${item.id}`,
              })),
            ]}
          />
        }
        content={renderView(view, () => setDemoOverride(true))}
        ariaLabels={{ navigation: 'Primary', navigationToggle: 'Open navigation' }}
      />
    </>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

function buildUtilities(
  session: Session | null,
  onLogout: () => void,
): React.ComponentProps<typeof TopNavigation>['utilities'] {
  const base: React.ComponentProps<typeof TopNavigation>['utilities'] = [
    {
      type: 'button',
      text: 'Trust & control plane for AI agents',
      disableUtilityCollapse: true,
    },
    {
      type: 'button',
      iconName: 'status-info',
      title: 'Keyboard shortcuts: Alt+1 to Alt+5 for quick navigation',
      ariaLabel: 'Keyboard shortcuts information',
    },
  ];
  if (session) {
    const orgItems = session.orgs.map((org) => ({
      id: `org:${org.id}`,
      text: org.id === session.currentOrgId ? `${org.name} (current)` : `Switch to ${org.name}`,
    }));
    return [
      ...base,
      {
        type: 'menu-dropdown',
        text: session.orgs.find((o) => o.id === session.currentOrgId)?.name ?? 'Workspace',
        iconName: 'multiscreen',
        items: orgItems,
        onItemClick: ({ detail }) => {
          if (detail.id.startsWith('org:')) {
            const orgId = detail.id.slice('org:'.length);
            // Switching org clears the current project; the next API call will
            // pick the first project on demand. A future PR can list projects
            // here.
            const cp = session.orgs.find((o) => o.id === orgId);
            if (cp) {
              // setCurrentOrgProject is closed over by the parent component;
              // we re-route through window.dispatchEvent so AppShell can
              // listen and trigger a state update.
              window.dispatchEvent(new CustomEvent('veritrail:switch-org', { detail: { orgId } }));
            }
          }
        },
      },
      {
        type: 'menu-dropdown',
        text: session.user.displayName ?? session.user.email,
        iconName: 'user-profile',
        items: [
          { id: 'settings', text: 'Settings', href: '#/settings' },
          { id: 'api-keys', text: 'API keys', href: '#/api-keys' },
          { id: 'billing', text: 'Billing', href: '#/billing' },
          { id: 'logout', text: 'Sign out' },
        ],
        onItemClick: ({ detail }) => {
          if (detail.id === 'logout') onLogout();
        },
      },
    ];
  }
  return [...base, { type: 'button', text: 'Sign in', href: '#/login' }];
}

type SideNavItem = NonNullable<React.ComponentProps<typeof SideNavigation>['items']>[number];

function buildProjectSwitcher(
  session: Session | null,
  _setCurrentOrgProject: (orgId: string, projectId: string | null) => void,
): ReadonlyArray<SideNavItem> {
  if (!session || session.orgs.length === 0) return [];
  const currentOrg = session.orgs.find((o) => o.id === session.currentOrgId) ?? session.orgs[0];
  if (!currentOrg) return [];
  return [
    {
      type: 'section',
      text: 'Workspace',
      items: session.orgs.map<SideNavItem>((org) => ({
        type: 'link',
        text: org.name + (org.id === currentOrg.id ? '  •' : ''),
        href: '#',
        // Switching workspace from the side nav is wired in a follow-up; for
        // now we show the active one and rely on Settings for explicit switch.
      })),
    },
    { type: 'divider' },
  ];
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
