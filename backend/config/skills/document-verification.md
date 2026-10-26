# Document Verification Skill

You design test suites for features that read documents: a user uploads a PDF or
image, the system extracts values (OCR, AI or both) and shows them, often with a
confidence score per field. Examples: labor tickets, invoices, receipts,
timesheets, delivery notes, forms.

The business question is never "does the upload button work". It is: **can the
business trust the values the system extracted, and does the system say so when
it is unsure?** Design the suite around that question.

## 1. Build the extraction model first

From the requirements and the observed screen, list:

- **Input documents**: document type, accepted file types, one or several files
  per upload, page and size limits.
- **Trigger and flow**: choose files, then the action that starts extraction
  (Scan, Extract, Process…), then the results.
- **Extracted fields (EXT-xx)**: every output field, grouped as the screen groups
  them (header fields, table columns). For each: data type (text, name, number,
  money, date, time, duration, code, list), whether the screen marks it
  required, and whether a confidence score is shown.
- **Rules on extracted values (BR-xx)**: only the rules the requirements state or
  the screen enforces. Do not assume arithmetic between fields (totals, time
  differences) or what the system ignores; leave unstated rules out.
- **Risk per field**: record-linking IDs (ticket, order, project, account
  numbers), hours, money and quantities are High; dates and names are Medium;
  free text is Low. High-risk fields get P0 cases.

## 2. Where expected values come from (the oracle)

Never invent an extracted value and never take one from reading the document
yourself. Every accuracy check names its oracle:

- **answer-key**: test documents whose correct values are known by
  construction. Used for exact accuracy.
- **business-rule**: stated rules that must hold on any document (formats,
  ranges, required fields). Needs no answer key and works on real documents.
- **baseline**: the approved result of an earlier run on the same documents.
  Used to detect changes between releases.

In test data, describe the document class and the oracle ("handwritten
multi-row ticket, oracle: answer-key"), never literal extracted values.

## 3. Pass rule

- A field passes when the displayed value equals the expected value after
  normalising format only (spacing, case, date and time notation).
- **Literal reading**: the system must show what is written, nothing more. When
  a value is unreadable, crossed out, or only implied (ditto marks, "same as
  above"), the field must stay **empty**, and a required field must then raise
  the missing-value message. A guessed or carried-over value is a defect.
- A **wrong value shown with high confidence is the most severe defect**:
  reviewers trust high-confidence fields, so the error reaches the business.
- A wrong value shown with low confidence and flagged for review is reported as
  an accuracy miss, not a trust defect.
- Confidence must fall when the document is harder to read (faint, messy, skewed).

## 4. Document variation classes

Vary the document, not just the form. Use the classes that fit the document type:

- **Content**: all fields filled; optional fields blank; one row and many rows;
  values at limits (0, very large, long names).
- **Handwriting**: neat; messy or cramped; crossed-out and rewritten values;
  digits that look alike (1/7, 0/6, 5/S); ditto marks and "same as above".
- **Notation**: am/pm and 24-hour time; date formats; decimals and fractions.
- **Scan quality**: clean; faint; low resolution; skewed; rotated; marks or
  stamps over fields.
- **Structure**: one page; several pages; several documents in one upload; the
  same document uploaded twice.
- **Bad input**: wrong document type; blank page; corrupt file; unsupported file
  type; over the size or page limit.

## 5. Suites to produce

Use the suite name as the case "submodule":

| Suite | Category | What it proves |
| --- | --- | --- |
| Upload & Trigger | positive / negative / boundary | Accepted types, several files, limits, trigger states; fields empty and confidence "N/A" before extraction |
| Field Accuracy | accuracy | Every EXT field is read correctly; one data-driven case per field group, P0 groups also on handwritten variants |
| Table / Row Accuracy | accuracy | Row count, row order, every column per row, rows not merged or dropped |
| Unreadable Values | accuracy | Unreadable, crossed-out and implied values stay empty; required ones raise the missing-value message |
| Confidence Trust | confidence | High confidence never on a wrong value; low confidence on unclear values; confidence falls on degraded scans |
| Stated Rules | business-rule | Every stated BR holds on extracted values; violations are shown to the user |
| Bad Documents | negative | Wrong, blank, corrupt or unsupported files are rejected with a clear message and no partial data |
| Release Regression | accuracy | The same documents give the same results as the approved baseline; any change is reported per field |

**Writes**: when the application context is read-only (a shared test
environment), cases may upload, scan and read results but must not save,
submit or delete. Check validation messages instead of saving corrections.

## 6. Data-driven cases

One case design runs against many documents. A data-driven case states:

- the field group or rule it checks (EXT-xx / BR-xx ids in traceabilityId),
- the document classes it runs on,
- the oracle,
- the steps: upload the document, start extraction, wait for the results, then
  for each field compare the displayed value and its confidence with the oracle.

Write one case per check and list the documents, not one case per document.
Coverage = fields × document classes, not the number of cases.

## 7. Coverage levels

- **essential**: upload happy path; one accuracy case per field group on clean
  documents; P0 fields on neat handwriting; unreadable required values once;
  one confidence-trust case; wrong-type and blank document.
- **standard** (default): every suite in section 5; accuracy for each field
  group across content, handwriting and notation classes; each stated BR with a
  passing and a violating document; all bad-document classes.
- **exhaustive**: standard, plus every scan-quality class for every field group,
  several documents per upload combined with variations, and release regression
  per field group.

## 8. Before you finish

Check: every EXT field appears in at least one accuracy case; every stated BR has
a case; every High-risk field is P0 and is tested on handwritten and degraded
documents; unreadable required values are covered; confidence trust is covered;
no case contains an invented extracted value; no case saves data when the
context is read-only.
