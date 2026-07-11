# Data Processing Agreement (Template)

This Data Processing Agreement ("DPA") forms part of the Master Services Agreement
or equivalent agreement (the "Agreement") between the parties identified below and
governs the processing of Personal Data by Veritrail on behalf of the Customer. In
the event of a conflict between this DPA and the Agreement on matters of data
protection, this DPA prevails.

This is a template. Items in [square brackets] are placeholders the parties fill in
on execution. Capitalised terms not defined here have the meaning given to them in
the GDPR or the Agreement.

---

## 1. Parties

**Data Controller (the "Customer")**

| Field                                      | Value                          |
| ------------------------------------------ | ------------------------------ |
| Legal name                                 | [Customer Name]                |
| Registered address                         | [Customer Address]             |
| Company number                             | [Customer Registration Number] |
| Authorised signatory                       | [Name, Title]                  |
| Notice address for data protection matters | [Email and Postal Address]     |

**Data Processor ("Veritrail")**

| Field                                      | Value                           |
| ------------------------------------------ | ------------------------------- |
| Legal name                                 | [Veritrail Legal Entity Name]   |
| Registered address                         | [Veritrail Registered Address]  |
| Company number                             | [Veritrail Registration Number] |
| Authorised signatory                       | [Name, Title]                   |
| Notice address for data protection matters | privacy@veritrail.example       |

Each a "Party" and together the "Parties".

## 2. Subject matter and duration

**Subject matter.** The processing of Personal Data by Veritrail to provide the
Veritrail platform — provenance, attestation, and audit-ledger services — to the
Customer under the Agreement.

**Duration.** This DPA takes effect on the later of [Effective Date] and the date of
last signature, and remains in force for as long as Veritrail processes Personal Data
on behalf of the Customer under the Agreement, plus any post-termination period
required by §10.

## 3. Nature and purpose of processing

**Nature.** Receipt, storage, indexing, integrity verification, encryption, transmission,
backup, restoration, and deletion of Personal Data submitted to the Veritrail platform
by or on behalf of the Customer.

**Purpose.** To enable the Customer to record tamper-evident provenance and audit
trails for the Customer's own systems, to issue signed receipts to the Customer's data
subjects, and to support the Customer's compliance with applicable laws.

**Operations performed.** Append, read, hash, sign, verify, encrypt, decrypt, export,
erase (by crypto-shredding per §4 of `gdpr.md`), back up, and restore.

## 4. Type of Personal Data and categories of data subjects

**Categories of Personal Data.** As determined by the Customer. By default the
Customer is expected to submit:

- Identifiers (user IDs, email addresses, account references)
- Authentication metadata (sign-in timestamps, IP addresses, device fingerprints)
- Transaction or event payloads (the records the Customer wishes to attest)
- Any other Personal Data the Customer chooses to submit through the API

**Special categories.** The Customer must not submit special categories of Personal
Data under Article 9 GDPR, or data relating to criminal convictions under Article 10,
unless Veritrail has agreed in writing in advance.

**Categories of data subjects.** As determined by the Customer. Typically:

- The Customer's end users or customers
- The Customer's employees, contractors, and administrators
- Counterparties or third parties referenced in records the Customer submits

## 5. Sub-processors

**Authorisation.** The Customer grants Veritrail general written authorisation to
engage the sub-processors listed in Annex A to perform processing activities on the
Customer's Personal Data.

**Obligations imposed on sub-processors.** Veritrail will impose data protection
obligations on each sub-processor that are no less protective than those in this DPA,
including the security measures in §6 and the breach notification SLA in §8.

**Liability.** Veritrail remains fully liable to the Customer for the performance of
each sub-processor's obligations.

**Changes.** Veritrail will notify the Customer in writing at least 30 days before
engaging or replacing a sub-processor. The Customer may object on reasonable data
protection grounds; the Parties will work in good faith to resolve the objection,
failing which the Customer may terminate the affected service on written notice.

### Annex A — Sub-processor list (template)

| Sub-processor   | Purpose              | Processing location | Transfer mechanism                 |
| --------------- | -------------------- | ------------------- | ---------------------------------- |
| [Postgres host] | Primary data store   | [Region]            | SCCs Module Three where applicable |
| Stripe, Inc.    | Subscription billing | EU and US           | SCCs Module Two                    |
| Resend, Inc.    | Transactional email  | EU and US           | SCCs Module Two                    |

## 6. Security measures

Veritrail implements and maintains the technical and organisational measures
described in §32 of `gdpr.md`. Those measures include, at a minimum:

- TLS 1.3 in transit
- AES-256-GCM at rest, with field-level encryption for sensitive payloads
- Tamper-evident receipts signed by a hardware-backed key
- Role-based access control with MFA for staff with production access
- Quarterly access reviews and annual penetration testing
- Rate limiting and anomaly detection on the API surface
- Daily backups with monthly restore drills (RPO 15 minutes, RTO 4 hours)
- An audit log capturing every state-changing action

The Parties acknowledge that the measures must be reviewed and updated as the state
of the art and the risk profile evolve.

## 7. Audit rights

**Standard evidence.** Veritrail will make available to the Customer, on written
request and no more than once per year, its most recent SOC 2 Type II report, ISO
27001 certificate (where available), penetration test summary, and a written response
to a standard security questionnaire (CAIQ-Lite or equivalent).

**On-site audit.** The Customer may, on at least 30 days' written notice and at the
Customer's expense, conduct an on-site audit of those Veritrail facilities and
records that relate to the processing of the Customer's Personal Data, subject to
reasonable confidentiality and security restrictions. On-site audits are limited to
once per year unless required more frequently by a supervisory authority or following
a confirmed breach affecting the Customer.

**Regulator access.** Veritrail will cooperate with reasonable requests from
supervisory authorities exercising powers under Article 58 GDPR.

## 8. Breach notification SLA

Veritrail will notify the Customer of any Personal Data Breach affecting the
Customer's Personal Data without undue delay and in any event within **72 hours** of
becoming aware of the breach.

The notification will include, to the extent known at the time:

- The nature of the breach, including categories and approximate numbers of data
  subjects and records affected
- The likely consequences
- The measures taken or proposed to address the breach and mitigate adverse effects
- The contact point for further information

Where the full information is not available within 72 hours, Veritrail will provide
it in phases without further undue delay.

## 9. Liability

The liability of each Party under this DPA is subject to the limitations and
exclusions of liability set out in the Agreement. Where the Agreement does not
specify an aggregate cap, the aggregate liability of each Party under this DPA in any
12-month period is limited to **the fees paid by the Customer to Veritrail in the
12 months preceding the event giving rise to the claim**.

Nothing in this DPA excludes or limits liability that cannot be excluded or limited
under applicable law, including liability for fines imposed by a supervisory
authority arising from a Party's own breach.

## 10. Term and termination

This DPA takes effect on the Effective Date and continues until the Agreement
terminates or expires.

**On termination**, Veritrail will, at the Customer's choice and subject to the
Customer's written instruction received within 30 days of termination:

- Return all Personal Data to the Customer in the export format described in §3 of
  `gdpr.md` (Article 20 portability bundle); or
- Delete all Personal Data, by crypto-shredding per §2 of `gdpr.md`, save to the
  extent retention is required by law.

If the Customer provides no instruction within 30 days, Veritrail will delete the
Personal Data. Veritrail will provide a signed certificate of deletion or return on
request.

Backups containing Personal Data will be deleted on the expiry of the backup
retention period (90 days from the date of the last write).

## 11. Miscellaneous

**Governing law.** The governing law and jurisdiction set out in the Agreement apply
to this DPA.

**International transfers.** Where Veritrail transfers Personal Data outside the EEA,
the United Kingdom, or Switzerland, the Parties rely on the European Commission's
Standard Contractual Clauses (2021/914) and the UK International Data Transfer
Addendum where applicable, and conduct a transfer impact assessment where required.

**Entire agreement.** This DPA, together with the Agreement, constitutes the entire
agreement between the Parties on the subject matter and supersedes any prior data
protection terms.

**Counterparts.** This DPA may be executed in counterparts, including by electronic
signature, each of which constitutes an original and which together form one
instrument.

---

## Signatures

For and on behalf of the Customer:

| Field     | Value                                          |
| --------- | ---------------------------------------------- |
| Name      | [Authorised Signatory Name]                    |
| Title     | [Title]                                        |
| Date      | [Date of Signature]                            |
| Signature | **\*\***\*\***\*\***\_\_\_**\*\***\*\***\*\*** |

For and on behalf of Veritrail:

| Field     | Value                                          |
| --------- | ---------------------------------------------- |
| Name      | [Authorised Signatory Name]                    |
| Title     | [Title]                                        |
| Date      | [Date of Signature]                            |
| Signature | **\*\***\*\***\*\***\_\_\_**\*\***\*\***\*\*** |
