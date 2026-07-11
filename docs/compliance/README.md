# Veritrail Compliance Documentation

This directory contains the documents Veritrail customers most often need during
procurement, vendor security review, and a SOC 2 or GDPR examination. Each file is
written to stand on its own — share a single link rather than the whole folder when
that is what the reviewer needs.

## Contents

| Document                                     | Audience                                         | Purpose                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`soc2.md`](./soc2.md)                       | Security and compliance teams, external auditors | Maps Veritrail features to the AICPA Trust Services Criteria and documents the shared-responsibility split.                                                 |
| [`gdpr.md`](./gdpr.md)                       | Data protection officers, privacy counsel        | Explains how Veritrail supports GDPR Articles 17, 20, 25, 32, and 33, and where Veritrail acts as a processor or sub-processor.                             |
| [`data-processing.md`](./data-processing.md) | Procurement, legal                               | A Data Processing Agreement template customers can sign with Veritrail; covers parties, sub-processors, security, audit rights, and the 72-hour breach SLA. |

## How to use this directory

If you are evaluating Veritrail as a vendor, start with `soc2.md` for the controls
overview, then move to `gdpr.md` if you process personal data of EEA, UK, or Swiss
residents. `data-processing.md` is the template your legal team will mark up and
return to Veritrail for execution.

If you are an existing customer preparing for your own SOC 2 examination, the
"Customer responsibilities" section of `soc2.md` is the right starting point — it
lists the complementary user-entity controls (CUECs) auditors typically expect to
see, with pointers to the Veritrail features that produce the supporting evidence.

If you are a Veritrail engineer changing platform behaviour that touches any of these
documents, update the relevant file in the same pull request. The compliance posture
of the product and the documentation of that posture are version-controlled together
on purpose.

For questions, contact `privacy@veritrail.example` or the contact named in your
Master Services Agreement.
