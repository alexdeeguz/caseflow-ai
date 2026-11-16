# DEMO-007: Apartment walkway trip and fall - Sofia Rivera

Entirely fictional sample matter. **18 pages across 6 PDFs; 8 completed visits.**

- Client: Sofia Rivera
- Incident: 2025-08-02
- Initial visit: 2025-08-03
- Last visit in release: 2025-10-05
- Record release: 2025-10-13
- Provider: Dr. Reese Nolan, Maple Community Clinic
- Course status: Returned to ordinary office activity; occasional kneeling discomfort
- Total charges: $1,110.00
- Payments: $100.00
- Adjustments: $20.00
- Ending balance: $990.00

## Documents

- [01-incident-report.pdf](01-incident-report.pdf) - 2 page(s)
- [02-treatment-record.pdf](02-treatment-record.pdf) - 9 page(s)
- [03-itemized-bill.pdf](03-itemized-bill.pdf) - 1 page(s)
- [04-correspondence.pdf](04-correspondence.pdf) - 4 page(s)
- [05-interim-statement.pdf](05-interim-statement.pdf) - 1 page(s)
- [06-imaging-report.pdf](06-imaging-report.pdf) - 1 page(s)

## Expected extraction behavior

Create one case and upload the PDFs in this folder. The initial functional inventory continues the first visit and is not an additional encounter. Ancillary imaging and wound care are separate charge lines but not extra visits.

The interim statement overlaps the final statement. Do not add their totals. Use the final cumulative statement for current charges and balance.

Treatment pages requiring OCR (one-based): 1, 2, 3, 4, 5, 6, 7, 8, 9. Other treatment pages have selectable text.

See [chronology.md](chronology.md) and the parent `cases.json` for exact visit dates, charges and correspondence. Photos and outside recordings referenced as outstanding are not supplied. No settlement, liability acceptance or wage-loss amount is established. These files do not create database records automatically.
