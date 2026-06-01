# UI, CSS, And Theming

## Component System

Use Carbon CSS component markup for routine UI primitives. Buttons, dialogs,
menus, tabs, tables, forms, dropdowns, notifications, tags, and pagination should
use `cds--` component classes unless a Carbon component does not fit the use
case.

Do not replace Carbon component structures with custom card/list/button
imitations. Custom CSS should compose layout around Carbon components, not
recreate tabs, tables, modals, form fields, or tags from scratch.

## Token System

Use a token-driven CSS system rooted in `web/src/style.css`.

Global CSS should own stable primitives:

- typography tokens
- spacing tokens
- radius tokens
- text color tokens
- surface, border, and shadow tokens
- chart color tokens
- theme variables
- reusable shell utilities

## CSS Rules

Agents should:

- look for an existing CSS variable before adding raw color, spacing, radius, border, or shadow literals
- add new root CSS variables only for reusable semantic decisions
- keep scoped component CSS for component-specific structure
- use token references inside scoped CSS
- extract a shared component, stylesheet, or utility when a pattern appears in more than one component
- route chart colors through CSS variables and a small theme bridge module

Agents must not:

- hardcode common chart palette values in chart options
- copy toolbar, table, card shell, or dialog patterns into multiple components
- create one-off visual systems per component

## UI Principles

- Management screens should be dense but readable.
- Application first screens should be useful; do not default to a marketing landing page.
- Dashboards should use reusable widget components backed by saved widget configuration.
- Mobile layouts must be considered from the start.
- Do not nest cards inside cards unless the inner card is a repeated item or true framed tool.
- Text must not overflow or overlap controls at mobile or desktop widths.

The app should remain themeable by changing shared variables and component-framework theme configuration.
