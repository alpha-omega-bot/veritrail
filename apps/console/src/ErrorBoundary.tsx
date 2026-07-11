import { Component, type ErrorInfo, type ReactNode } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box padding={{ vertical: 'xxxl', horizontal: 'l' }}>
          <Container>
            <SpaceBetween size="l">
              <Alert
                type="error"
                header="Something went wrong"
                action={<Button onClick={() => window.location.reload()}>Reload page</Button>}
              >
                An unexpected error occurred while rendering the console. Please try reloading the
                page.
              </Alert>
              {this.state.error && (
                <Box variant="code" padding="s">
                  {this.state.error.message}
                </Box>
              )}
            </SpaceBetween>
          </Container>
        </Box>
      );
    }

    return this.props.children;
  }
}
