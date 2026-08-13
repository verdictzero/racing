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

- Chart, Roster and Tasks now sit in their own boxed group in the left rail, matching the box Task Flows already had. The two boxes carry different hues so the two systems still read apart.
- The right rail is wider and the product name no longer wraps; the version chip drops to its own line.
- The tier label on the current breadcrumb chip is legible on every theme.
- Hiding the flow gallery now tells you how to bring it back.

- New field guide under Help: "How do I use this tool" — every screen and gesture in the order you meet them, with a cheat sheet of the ones that are not discoverable by clicking.
