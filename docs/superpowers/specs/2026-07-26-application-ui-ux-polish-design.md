# Application UI/UX Polish Design

**Date:** 2026-07-26  
**Scope:** Tether mobile application and its desktop-adaptive shell  
**Direction:** Full operating-surface polish; preserve the Catppuccin visual identity and all terminal behavior.

## Goal

Make Tether feel calm, precise, and responsive across the entire operating path: connection setup, live terminal work, sessions, overlays, file/diff review, and desktop navigation. The terminal remains the visual and functional center of the product.

## Visual system

- Keep the existing Catppuccin palettes, semantic color roles, and typography.
- Consolidate repeated surface treatment into existing theme/style primitives: background, base surface, raised surface, input, border, selected, and semantic status colors.
- Establish a consistent hierarchy: primary actions use the accent fill; normal actions use quiet raised surfaces; destructive actions are explicitly danger-colored and require deliberate placement.
- Normalize geometry across shared controls: 44pt minimum interactive targets, coherent 8/12/16/24 spacing rhythm, stable corner-radius tiers, and visible focus/pressed/disabled states.
- Preserve content and product truth. Copy changes are limited to clarity, state labels, and accessible names.

## Surface behavior

### Setup and recovery

The connection screen becomes a more legible, confidence-building first step: grouped form fields, clear validation and reachability feedback, deliberate disabled/loading treatment, and one unmistakable next action. Recovery paths from offline and authentication failures keep users close to the relevant settings rather than leaving them at an ambiguous terminal state.

### Live terminal workspace

Terminal output stays visually dominant and remains free of decorative animation. Header context, connection state, change indicators, and utility controls become more scannable without taking terminal space. The status treatment communicates connected, reconnecting, offline, and authentication-failed states through both text and semantic color.

### Sessions and navigation

Mobile drawers, desktop sidebar/overlay/tabs, session rows, preview rows, and activity markers use the same selection, hierarchy, and action conventions. Important current state is visible at a glance; row-level destructive actions remain separated from selection.

### Overlays and takeovers

Overflow menus, modals, selection, snippets, appearance settings, file views, diff review, and presentation previews are treated as a coherent family. Each establishes an obvious entry, current purpose, close/back route, loading/empty/error state, and return path to the terminal.

### Responsive and accessible operation

Mobile prioritizes one-handed reach and readable labels; desktop supports denser navigation while retaining the same relationships. Every control gets an accessible label, keyboard focus behavior where applicable, sufficient contrast, and a reliable disabled/loading state. Long labels, missing data, offline state, and reduced-space layouts remain usable.

## Motion thesis

Motion clarifies relationship and confirms work; it never creates latency or competes with live terminal output.

- **Focal continuity:** the session drawer and full-surface takeovers enter and exit from their relevant edge or source, making the relationship to the terminal unmistakable.
- **Feedback:** taps, toggles, selected rows, connection status changes, and successful actions receive compact transform/opacity/color feedback (roughly 100–150ms).
- **State transitions:** menus, modals, banners, loading affordances, and changes between terminal-adjacent surfaces use fast, interruptible transitions (roughly 150–300ms; overlays may use 300–500ms).
- **Meaningful signals only:** activity or waiting indicators may pulse once on a state change; no looping decoration, scroll reveals, bounce, or animation of terminal text/layout.
- **Performance budget:** prefer native-driver opacity and transform animations; do not animate layout-driving values or terminal dimensions; ensure repeated interactions interrupt cleanly and respect the device’s reduced-motion preference.

## Implementation boundaries

- Keep terminal engine, renderer, transport, and session semantics unchanged.
- Add or extend small shared UI primitives only where the pattern is genuinely reused; avoid a new UI dependency unless the existing React Native stack cannot express the behavior.
- Refine each surface in place, favoring the existing theme and style modules over local hard-coded values.
- Add focused tests for extracted visual-state helpers; validate interactive behavior manually on mobile and desktop form factors.

## Verification

Walk setup, connection recovery, active-terminal work, session switching, menus, modals, selection, file/diff review, and preview return paths on narrow mobile, intermediate, and desktop layouts. Check focus, touch target size, contrast, long labels, loading/empty/error/disabled states, transition interruption, reduced motion, and terminal resize/render stability. Run the relevant mobile typecheck, lint, and test commands before shipping.
