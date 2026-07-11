# Veritrail Kubernetes Deployment Guide

This directory contains Kubernetes manifests for deploying Veritrail in a production Kubernetes cluster.

## Prerequisites

- Kubernetes cluster (1.24+)
- kubectl configured
- Ingress controller (nginx recommended)
- cert-manager (for TLS certificates)
- Storage provisioner for PersistentVolumes

## Quick Start

```bash
# Create namespace and resources
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/server-deployment.yaml
kubectl apply -f k8s/console-deployment.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml

# Check deployment status
kubectl -n veritrail get all
kubectl -n veritrail get pvc
kubectl -n veritrail get ingress
```

## Configuration

### Secrets

**IMPORTANT:** Update the secrets in `configmap.yaml` before deploying:

```yaml
VERITRAIL_API_KEY: 'your-secure-api-key'
VERITRAIL_SIGNER_SECRET: 'your-secure-hmac-secret'
```

Generate secure keys:

```bash
# Generate API key
openssl rand -base64 32

# Generate signer secret
openssl rand -base64 64
```

### Ingress

Update the hostname in `ingress.yaml`:

```yaml
- host: veritrail.example.com # Change this
```

### Storage

Adjust storage size in `pvc.yaml` based on expected ledger size:

```yaml
resources:
  requests:
    storage: 10Gi # Adjust as needed
```

## Scaling

The deployment includes HorizontalPodAutoscalers (HPA):

- **Server**: 2-10 replicas based on CPU/memory
- **Console**: 2-5 replicas based on CPU

Adjust in `hpa.yaml` as needed.

## Monitoring

The server deployment includes Prometheus annotations for metrics scraping:

```yaml
prometheus.io/scrape: 'true'
prometheus.io/port: '8787'
prometheus.io/path: '/api/metrics/prometheus'
```

Metrics available at: `/api/metrics/prometheus`

## Health Checks

- **Liveness**: `/api/health/live` - checks if the process is alive
- **Readiness**: `/api/health/ready` - checks if the service can handle traffic

## Resource Requests/Limits

Current settings:

### Server

- Requests: 256Mi memory, 100m CPU
- Limits: 512Mi memory, 500m CPU

### Console

- Requests: 64Mi memory, 50m CPU
- Limits: 128Mi memory, 200m CPU

Adjust based on your workload.

## Security

- Containers run as non-root users
- SecurityContext with capabilities dropped
- TLS termination at ingress
- Secrets stored in Kubernetes Secrets

## Backup

The ledger data is stored in a PersistentVolume. To backup:

```bash
# Get pod name
POD=$(kubectl -n veritrail get pod -l app=veritrail-server -o jsonpath='{.items[0].metadata.name}')

# Copy ledger file
kubectl -n veritrail cp $POD:/data/veritrail-ledger.jsonl ./backup-$(date +%Y%m%d).jsonl
```

## Troubleshooting

```bash
# View logs
kubectl -n veritrail logs -l app=veritrail-server --tail=100 -f
kubectl -n veritrail logs -l app=veritrail-console --tail=100 -f

# Check pod status
kubectl -n veritrail describe pod -l app=veritrail-server

# Check events
kubectl -n veritrail get events --sort-by='.lastTimestamp'

# Access shell in pod
kubectl -n veritrail exec -it deployment/veritrail-server -- sh
```

## Updating

```bash
# Update image version
kubectl -n veritrail set image deployment/veritrail-server server=veritrail/server:0.2.0
kubectl -n veritrail set image deployment/veritrail-console console=veritrail/console:0.2.0

# Rollout status
kubectl -n veritrail rollout status deployment/veritrail-server
kubectl -n veritrail rollout status deployment/veritrail-console

# Rollback if needed
kubectl -n veritrail rollout undo deployment/veritrail-server
```

## Clean Up

```bash
kubectl delete namespace veritrail
```

Note: This will delete all resources including the PersistentVolume (data).
