# Fictional sample case library

Ten cases with **63 PDFs and 214 pages**, ranging from 10 to 34 pages each.
The cases contain 4-18 visits over different care periods, with distinct outcomes,
setbacks, attendance gaps, itemized bills, letters, diagnostic reports and activity histories.
All people, organizations, events, observations and amounts are invented. Every
PDF page is labeled as fictional. The public design references are in [SOURCES.md](SOURCES.md).

## Use

Choose a folder, read its README, create a case and upload that folder's PDFs.
The reference `cases.json` and per-case `chronology.md` help compare extraction results.
They are reference data, not an automatic database import.

| Folder                                                  | Client        | Visits | PDFs | Pages |   Charges |   Balance |
| ------------------------------------------------------- | ------------- | -----: | ---: | ----: | --------: | --------: |
| [01-rear-end-collision](01-rear-end-collision/)         | Maya Bennett  |     10 |    7 |    21 | $1,335.00 | $1,200.00 |
| [02-grocery-slip-fall](02-grocery-slip-fall/)           | Noah Castillo |      7 |    6 |    16 | $1,025.00 |   $850.00 |
| [03-bicycle-door-collision](03-bicycle-door-collision/) | Lena Park     |      6 |    6 |    15 |   $985.00 |   $910.00 |
| [04-pedestrian-crosswalk](04-pedestrian-crosswalk/)     | Owen Brooks   |     18 |    8 |    34 | $2,245.00 | $1,920.00 |
| [05-highway-sideswipe](05-highway-sideswipe/)           | Amara Lewis   |     15 |    7 |    30 | $1,765.00 | $1,505.00 |
| [06-dog-bite](06-dog-bite/)                             | Eli Morgan    |      4 |    4 |    10 |   $660.00 |   $585.00 |
| [07-apartment-trip-fall](07-apartment-trip-fall/)       | Sofia Rivera  |      8 |    6 |    18 | $1,110.00 |   $990.00 |
| [08-bus-passenger-fall](08-bus-passenger-fall/)         | Theo Nguyen   |     12 |    7 |    26 | $1,600.00 | $1,410.00 |
| [09-falling-merchandise](09-falling-merchandise/)       | Zoe Mitchell  |      5 |    5 |    13 |   $815.00 |   $765.00 |
| [10-rideshare-collision](10-rideshare-collision/)       | Leo Patel     |     16 |    7 |    31 | $1,825.00 | $1,575.00 |

## Things to exercise

- Separate appointment counts from page counts and billed ancillary services.
- Identify different encounter providers and the last completed date of care.
- Track setbacks and attendance gaps without inventing care in the gaps.
- Distinguish discharge, ongoing symptoms and unresolved follow-up requests.
- Avoid double-counting charges appearing on interim and final statements.
- Separate gross charges, credits and remaining balance.
- Keep statements from patients, witnesses, providers and file coordinators attributed.
- Treat missing photographs and recordings as missing evidence.
- Determine OCR needs per page. Cases 02 and 07 have fully scanned medical records;
  case 05 has every third medical-record page scanned. Other PDFs contain selectable text.
- No OCR-provider accuracy result is claimed for these generated examples.

## Reuse

Copy, modify, redistribute and upload these generated materials for software demos
and testing. Keep the fictional-data labels when sharing. The original app branding
is absent; each source type uses a plain records-office, clinical or billing layout.
