export type ViewId = 'overview' | 'ledger' | 'spend' | 'vendor-risk' | 'forensics';

interface NavItem {
  id: ViewId;
  label: string;
  description: string;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { id: 'overview', label: 'Overview', description: 'Integrity & key metrics' },
  { id: 'ledger', label: 'Ledger', description: 'Append-only audit events' },
  { id: 'spend', label: 'Spend', description: 'Budgets & cost control' },
  { id: 'vendor-risk', label: 'Vendor Risk', description: 'Provider risk scores' },
  { id: 'forensics', label: 'Forensics', description: 'Incident reconstruction' },
];

interface NavProps {
  current: ViewId;
}

export function Nav({ current }: NavProps) {
  return (
    <nav className="nav" aria-label="Primary">
      <div className="nav__brand">
        <span className="nav__logo" aria-hidden="true">
          V
        </span>
        <div>
          <div className="nav__title">Veritrail</div>
          <div className="nav__subtitle">Console</div>
        </div>
      </div>
      <ul className="nav__list">
        {NAV_ITEMS.map((item) => {
          const active = item.id === current;
          return (
            <li key={item.id}>
              <a
                href={`#/${item.id}`}
                className={`nav__link${active ? ' nav__link--active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="nav__link-label">{item.label}</span>
                <span className="nav__link-desc">{item.description}</span>
              </a>
            </li>
          );
        })}
      </ul>
      <div className="nav__footer">Operator console</div>
    </nav>
  );
}

/** The set of valid view ids, exported for hash routing. */
export const VIEW_IDS: ReadonlyArray<ViewId> = NAV_ITEMS.map((i) => i.id);
