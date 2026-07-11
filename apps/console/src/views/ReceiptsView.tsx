import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';

import {
  generateReceipt,
  publishAnchor,
  verifyReceipt,
  type AnchorHead,
  type Receipt,
  type ReceiptVerifyResult,
} from '../api.ts';
import { useAuth } from '../auth/AuthContext.tsx';

export function ReceiptsView() {
  const { session } = useAuth();

  const [anchor, setAnchor] = useState<AnchorHead | null>(null);
  const [anchorLoading, setAnchorLoading] = useState(false);
  const [anchorError, setAnchorError] = useState<string | null>(null);

  const [seqInput, setSeqInput] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  const [verifyInput, setVerifyInput] = useState('');
  const [verifyResult, setVerifyResult] = useState<ReceiptVerifyResult | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Receipts</Header>}>
        <Alert type="info" header="Sign in to use this feature">
          Receipt management is available to signed-in users.
        </Alert>
      </ContentLayout>
    );
  }

  const onPublishAnchor = async () => {
    setAnchorLoading(true);
    setAnchorError(null);
    try {
      const result = await publishAnchor();
      setAnchor(result);
    } catch (e) {
      setAnchorError(e instanceof Error ? e.message : 'Failed to publish anchor');
    } finally {
      setAnchorLoading(false);
    }
  };

  const onGenerateReceipt = async () => {
    const seq = Number(seqInput);
    if (!Number.isFinite(seq) || !Number.isInteger(seq) || seq < 0) {
      setReceiptError('Enter a valid non-negative integer seq');
      return;
    }
    setReceiptLoading(true);
    setReceiptError(null);
    try {
      const result = await generateReceipt(seq);
      setReceipt(result);
    } catch (e) {
      setReceiptError(e instanceof Error ? e.message : 'Failed to generate receipt');
    } finally {
      setReceiptLoading(false);
    }
  };

  const onDownloadReceipt = () => {
    if (!receipt) return;
    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `receipt-${receipt.event.seq}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const onVerify = async () => {
    setVerifyError(null);
    setVerifyResult(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(verifyInput);
    } catch {
      setVerifyError('Receipt is not valid JSON');
      return;
    }
    setVerifyLoading(true);
    try {
      const result = await verifyReceipt(parsed);
      setVerifyResult(result);
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : 'Failed to verify receipt');
    } finally {
      setVerifyLoading(false);
    }
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Publish ledger anchors, generate per-event inclusion receipts, and verify receipts."
        >
          Receipts
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Anchor head</Header>}>
          <SpaceBetween size="m">
            {anchorError && (
              <Alert type="error" header="Publish failed">
                {anchorError}
              </Alert>
            )}
            <Box>
              <Button
                variant="primary"
                onClick={() => void onPublishAnchor()}
                loading={anchorLoading}
              >
                Publish anchor
              </Button>
            </Box>
            {anchor && (
              <KeyValuePairs
                columns={3}
                items={[
                  { label: 'Anchor ID', value: anchor.anchorId },
                  { label: 'Seq', value: String(anchor.seq) },
                  { label: 'Head hash', value: anchor.headHash },
                ]}
              />
            )}
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2">Generate receipt</Header>}>
          <SpaceBetween size="m">
            {receiptError && (
              <Alert type="error" header="Generate failed">
                {receiptError}
              </Alert>
            )}
            <FormField
              label="Seq"
              description="The ledger sequence number to generate a receipt for."
            >
              <Input
                type="number"
                value={seqInput}
                onChange={(e: { detail: { value: string } }) => setSeqInput(e.detail.value)}
                placeholder="0"
              />
            </FormField>
            <Box>
              <Button
                variant="primary"
                onClick={() => void onGenerateReceipt()}
                loading={receiptLoading}
                disabled={!seqInput.trim()}
              >
                Generate
              </Button>
            </Box>
            {receipt && (
              <SpaceBetween size="m">
                <KeyValuePairs
                  columns={2}
                  items={[
                    { label: 'Event seq', value: String(receipt.event.seq) },
                    { label: 'Event ID', value: receipt.event.id },
                    { label: 'Chain length', value: String(receipt.chain.length) },
                    { label: 'Anchor head hash', value: receipt.anchor.headHash },
                  ]}
                />
                <Box>
                  <Button onClick={onDownloadReceipt}>Download receipt</Button>
                </Box>
              </SpaceBetween>
            )}
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2">Verify</Header>}>
          <SpaceBetween size="m">
            {verifyError && (
              <Alert type="error" header="Verify failed">
                {verifyError}
              </Alert>
            )}
            <FormField
              label="Receipt JSON"
              description="Paste a receipt JSON to verify it against the ledger."
            >
              <Textarea
                value={verifyInput}
                onChange={(e: { detail: { value: string } }) => setVerifyInput(e.detail.value)}
                placeholder='{"event":{...},"chain":[...],"anchor":{...}}'
                rows={10}
              />
            </FormField>
            <Box>
              <Button
                variant="primary"
                onClick={() => void onVerify()}
                loading={verifyLoading}
                disabled={!verifyInput.trim()}
              >
                Verify
              </Button>
            </Box>
            {verifyResult && (
              <Alert
                type={verifyResult.ok ? 'success' : 'error'}
                header={verifyResult.ok ? 'Receipt is valid' : 'Receipt is invalid'}
              >
                {verifyResult.failures && verifyResult.failures.length > 0 ? (
                  <SpaceBetween size="xs">
                    <Box>Failures:</Box>
                    <ul>
                      {verifyResult.failures.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </SpaceBetween>
                ) : verifyResult.ok ? (
                  'All checks passed.'
                ) : (
                  'Verification failed with no detailed failures returned.'
                )}
              </Alert>
            )}
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
