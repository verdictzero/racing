- Light and High Contrast themes added alongside the default Dark, picked from a segmented control in the toolbar.
- High Contrast is now three variants: Light, Dark and Neon. All three share one structural stylesheet, so they differ only in palette.
- The theme is a device preference, not document data — it is left out of the exported file and survives Load, Merge, Demo and Clear.
- The stored theme is applied before the first paint, so light-mode users no longer get a flash of dark.
- Dark stays the default and is never resolved against the operating system — a fresh browser always opens dark.
- An old `contrast` theme preference migrates to High Contrast (Dark) rather than resetting.

- Flow gallery: every flow in the workspace as a card showing a sketch of its actual graph, its counts and its chart anchor.
- Nested flows: drag a gallery card onto the canvas and it becomes one box standing in for that whole flow. A reference, not a copy — one edit updates every host, and reference loops are blocked.
- A nested box gets a socket per entry point and per exit point of the flow inside, so a procedure that ends two ways can feed two different next steps. Exposed ports store the selection, not a count.
- Groups: labelled frames around steps. Name one, colour it, or collapse it into a single box whose sockets are its real boundary crossings.
- Multi-select in flows: click, shift-click, or shift-drag a marquee.
- Flow noodles read their colours from the live theme instead of baked-in literals.
- Nested handoffs are tinted separately from plain and branch edges.

- Flows have two modes. Chart-Linked: every step names the org-chart row it implements and reads that row's RACI live. Free-Form: RACI authored on the step. Switching is lossless both ways.
- The mode strip above the canvas now carries the mode picker itself, right-justified — the label and the control are one thing, and the duplicate in the toolbar is gone.
- Flows are RACI only. DACI and RAPID are removed; a file naming either loads as RACI. Charts still offer RACI and RASCI.
- Creating a flow from a chart Task row starts it Chart-Linked with its first step already linked.

- Redirectors: drag any handoff line and it bends around whatever is in the way, leaving a handle. Drag the handle to steer it, double-click it to remove. A click without dragging still opens the handoff popover.
- A branch condition rides the middle of the routed line rather than the straight line between the two ends, so routing around an obstacle no longer strands the label on top of it.

- A step inside a group stays in that group however far it is dragged, and the frame resizes to follow it.
- To take a step out of a group, hold Alt (Option on a Mac) while dragging it. The frame freezes and turns amber, and says so in its own header while you drag.
- A step with no group still joins any frame it is dropped into, and highlights that frame on the way in.

- Every chart and every flow carries a status: Draft or Final. Both states are always labelled, on the chart tabs, the flow picker, the gallery cards and a strip above the canvas.
- Final locks the artifact. Add, delete and rename affordances are removed, fields go inert, and anything that moves on a Final artifact is put back on save whatever path produced it. One click reopens it as a draft; nothing is destroyed.
- A Final flow reading rows from a Draft chart is flagged per step.
- Status carries into every export: an Excel Document sheet and Status column, XML attributes, a Mermaid header line, PowerPoint title and flow slides, and a diagonal DRAFT watermark on printed pages.

- Excel import: the file picker now takes a .xlsx anywhere it took a .json. Charts can come back out of a spreadsheet, not just go into one.
- A blank Excel template to fill in, under Export. One flat sheet: the first columns are the hierarchy, the rest are your parties, and each row repeats its ancestors with the deepest filled cell naming the row being defined.
- Naming a parent on a child's row creates it, so nobody writes scaffolding rows by hand.
- The template is the same shape the Excel export writes, so export, edit in Excel, and load back is a closed loop.
- Party column headers become the chart's column labels, so a source workbook's own vocabulary survives the trip.
- It reads real spreadsheets, not only its own template: the header row is found rather than assumed, a title and notes above the table are fine, blank rows and extra columns are ignored, letters are case-insensitive.
- Optional Entities and Document sheets carry the entity registry and the metadata block.
- A row that skips a level is skipped and counted rather than guessed at.
- Everything imported arrives as a new chart tab behind a summary of what was found. Nothing already open is touched.

- Entities: parties that are neither people nor directorates — boards, committees, vendors, standing teams — created in a section at the bottom of the Roster.
- An entity is flat. It has a name, a kind, a short label and a lead, and nothing underneath it, because it names a party at the depth RACI already stops at.
- An entity is assignable anywhere a directorate is: the Responsible Party panel switches between Directorate and Entity, and a Program or Project row's org list has an Entities group.
- Each entity card counts how many things name it. Deleting one that is in use names what would be left pointing at nothing, and those parties read "(missing entity)" rather than silently emptying.
- Entities carry into the exports — an `<entities>` block in the XML, an Entities sheet in the Excel file, each row listing everywhere the entity is named.

- Details: every chart and every flow now carries the same metadata block — description, customer, priority, budget and tags — edited in one panel, opened with ✎ Details on the chart-tab bar or the strip above a flow.
- The gallery filter matches every one of those fields instead of just name and description, so a customer, a fiscal year or a tag narrows the list. Tags show on the gallery cards.
- Metadata rides into the exports: extra columns on the Excel Document sheet, a `<meta>` element in the XML.
- A Final chart or flow shows its details read-only rather than hiding them.
- A flow's old top-level description folds into the new block when an older file is loaded.

- Chart, Roster and Tasks now sit in their own boxed group in the left rail, matching the box Task Flows already had. The two boxes carry different hues so the two systems still read apart.
- The right rail is wider and the product name no longer wraps; the version chip drops to its own line.
- The tier label on the current breadcrumb chip is legible on every theme.
- Hiding the flow gallery now tells you how to bring it back.

- New field guide under Help: "How do I use this tool" — every screen and gesture in the order you meet them, with a cheat sheet of the ones that are not discoverable by clicking.
