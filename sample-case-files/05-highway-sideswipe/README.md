# DEMO-005: Highway sideswipe collision - Amara Lewis

Entirely fictional sample matter. **30 pages across 7 PDFs; 15 completed visits.**

- Client: Amara Lewis
- Incident: 2025-06-06
- Initial visit: 2025-06-07
- Last visit in release: 2025-10-11
- Record release: 2025-10-19
- Provider: Dr. Riley Shaw, Pinehaven Rehabilitation
- Course status: Shoulder symptoms persist with overhead inventory work
- Total charges: $1,765.00
- Payments: $200.00
- Adjustments: $60.00
- Ending balance: $1,505.00

## Documents

- [01-incident-report.pdf](01-incident-report.pdf) - 3 page(s)
- [02-treatment-record.pdf](02-treatment-record.pdf) - 16 page(s)
- [03-itemized-bill.pdf](03-itemized-bill.pdf) - 2 page(s)
- [04-correspondence.pdf](04-correspondence.pdf) - 6 page(s)
- [05-interim-statement.pdf](05-interim-statement.pdf) - 1 page(s)
- [07-activity-statement.pdf](07-activity-statement.pdf) - 1 page(s)
- [08-continuation-referral.pdf](08-continuation-referral.pdf) - 1 page(s)

## Expected extraction behavior

Create one case and upload the PDFs in this folder. The initial functional inventory continues the first visit and is not an additional encounter. Ancillary imaging and wound care are separate charge lines but not extra visits.

The interim statement overlaps the final statement. Do not add their totals. Use the final cumulative statement for current charges and balance.

Attendance gap: 2025-07-22 through 2025-08-11. Travel and shift changes caused a scheduling gap; the return visit documents reduced tolerance. No visits or charges in that interval.

Treatment pages requiring OCR (one-based): 3, 6, 9, 12, 15. Other treatment pages have selectable text.

See [chronology.md](chronology.md) and the parent `cases.json` for exact visit dates, charges and correspondence. Photos and outside recordings referenced as outstanding are not supplied. No settlement, liability acceptance or wage-loss amount is established. These files do not create database records automatically.
