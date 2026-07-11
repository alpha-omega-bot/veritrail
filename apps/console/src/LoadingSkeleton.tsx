import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Container>
      <SpaceBetween size="m">
        {Array.from({ length: rows }).map((_, i) => (
          <Box key={i} padding="s">
            <div
              style={{
                height: '20px',
                background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
                backgroundSize: '200% 100%',
                animation: 'shimmer 1.5s infinite',
                borderRadius: '4px',
              }}
            />
          </Box>
        ))}
      </SpaceBetween>
      <style>
        {`
          @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
        `}
      </style>
    </Container>
  );
}

export function MetricSkeleton() {
  return (
    <div>
      <Box variant="awsui-key-label" color="text-body-secondary">
        Loading...
      </Box>
      <div
        style={{
          height: '32px',
          width: '80%',
          marginTop: '8px',
          background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.5s infinite',
          borderRadius: '4px',
        }}
      />
    </div>
  );
}
