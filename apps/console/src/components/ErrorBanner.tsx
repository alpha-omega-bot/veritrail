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

/** Subtle notice that the displayed data is local sample data, not live. */
export function MockNotice() {
  return (
    <div className="mock-notice" role="note">
      Showing sample data. Connect the Veritrail API for live records.
    </div>
  );
}
