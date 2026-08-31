# `foreign-workbook.xlsx`

Written by **openpyxl**, not by this package — which is the whole point of it.

Our own writer emits inline strings in a store-only ZIP. Excel and every other real writer emit
**shared strings** in **deflate-compressed** parts, so a reader tested only against our own output
would pass while being unable to open a single file a user actually has.

It also carries the shapes a person's real spreadsheet has and a synthetic fixture would not:

| In the file | What it proves |
|---|---|
| A title block and a blank row above the header | The header scan looks past preamble |
| An `Org unit` column between the tiers and the parties | Context columns are not read as role letters |
| A party column named `R&D` | Entity decoding, through the shared-string table |
| A cell reading `ar` | Letters are normalized, not taken literally |
| A row with Project filled but Program blank | A gap is skipped and counted, never guessed at |
| `Entities` and `Document` sheets | The optional sheets are found by name |

Regenerate with `scripts/make-foreign-workbook.py` if it ever needs to change — but prefer adding a
case to it over replacing it, since every row here is load-bearing for some test.
