# gantt-flow Desktop — building with this library

These components are the **real desktop application** (`@gantt-flow/desktop`), not a generic
component kit. Most are app screens wired to two global stores, so the rules below are load-bearing —
a screen built without them renders empty.

## State: two global zustand stores, no provider

There is **no React context provider to wrap** — state lives in two module-singleton stores exposed
on the bundle global, mutated imperatively before/while rendering:

- `useApp` — the document (project, selection, level scope, dirty flag).
- `useUI` — UI shell state (open overlay, active pane, toasts, dialogs).

To show a **data screen** (`App`, `TableView`, `FullTable`, `FlowCanvas`, `Inspector`, `StatusBar`,
`SummaryDialog`, `IssueListDialog`), seed the store first, then render:

```jsx
import { App, useApp, useUI } from '@gantt-flow/desktop';
useApp.getState().loadSample();                 // or loadTemplate('order-to-ship'|'monthly-closing'|'procurement'|'onboarding'), or loadProject(project)
// useApp.getState().select(taskId);            // a selected task → Inspector shows its editor
export default () => <App />;
```

To show an **overlay** (driven by `useUI`, render nothing when closed):

```jsx
useUI.getState().setOverlay('help');            // 'help' | 'palette' | 'issues' | 'summary' | 'settings' | 'backups' | null
useUI.setState({ dialog: { kind: 'confirm', title: '…', message: '…', confirmLabel: '削除', danger: true, resolve: () => {} } }); // <Modal />
useUI.getState().toast('保存しました', 'success'); // 'success' | 'info' | 'error' → <Toaster />
```

`Welcome`, `Menu`/`MenuItem`/`MenuCheckItem`, and the icons are prop-driven and need no seeding.

## Styling: global semantic classes + CSS variable tokens (never prop styling)

Components carry their own class names — `.menu`/`.menu-item`/`.menu-check`, `.modal`/`.modal-backdrop`/`.modal-actions`,
`.statusbar`, `.toast`, `.ft-sort`, `.lane-*`, `.chip`/`.chip-io`/`.chip-issue`, `.welcome`. There are **no
style props and no utility classes**. Style your own layout glue with the design tokens (CSS custom properties):

- Surfaces / text: `--bg`, `--panel`, `--panel-2`, `--ink`, `--muted`, `--faint`, `--line`
- Accent: `--accent`, `--accent-strong`, `--accent-soft`, `--on-accent`
- Semantic: `--in` (input · teal), `--out` (output · orange), `--ok`, `--danger` / `--danger-soft`, `--amber`; level dots `--lvl-large` / `--lvl-medium` / `--lvl-small` / `--lvl-detail`
- Shape / type / depth: `--radius`, `--radius-sm`, `--radius-lg`, `--shadow`, `--shadow-pop`, `--ring`, `--font-ui`, `--font-mono`

Icons are inline SVG using `currentColor`; size via `width`/`height`, color via the parent's `color`.
Dark theme is `[data-theme="dark"]` on a root ancestor (the light values above are the canonical palette).

## Where the truth lives

Read `styles.css` (it `@import`s `_ds_bundle.css` = all component CSS + the `:root` tokens) for the full
class/token vocabulary before styling. Per component, read `components/<group>/<Name>/<Name>.prompt.md`
(usage) and `<Name>.d.ts` (props). Brand/usage notes are in `guidelines/`.
