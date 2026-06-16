interface ErrorBannerProps {
  message: string;
}

export function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <div className="error-banner" role="alert">
      <strong>Error:</strong> {message}
    </div>
  );
}

/** Subtle notice that the displayed data is local mock fallback, not live. */
export function MockNotice() {
  return (
    <div className="mock-notice" role="note">
      Showing mock data — the Veritrail API is unreachable.
    </div>
  );
}
