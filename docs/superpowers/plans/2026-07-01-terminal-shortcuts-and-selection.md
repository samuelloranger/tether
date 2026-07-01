# Terminal Shortcuts + Selectable-Text View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Ctrl-modifier toggle + Shift-Tab to the mobile terminal's utility bar, and replace the instant whole-pane copy gesture with a fullscreen native-selectable text view.

**Architecture:** All changes live in `apps/mobile/App.tsx`. The Ctrl modifier is a one-shot boolean flag consumed inside the existing `handleKeyPress` handler. Shift-Tab is a second gesture (`onLongPress`) on the existing `Tab` button. The selectable view is a full-screen RN `Modal` containing a read-only multiline `TextInput`, which gets native OS text selection for free on both iOS and Android — no custom gesture/highlight code.

**Tech Stack:** React Native (Expo SDK 57), TypeScript, `expo-clipboard`, `@expo/vector-icons` (Feather).

## Global Constraints

- Scope is `apps/mobile/App.tsx` only — no server or `apps/mobile/src/terminal.ts` changes.
- No test runner exists for `App.tsx` (UI-only, no test infra per `CLAUDE.md`). Every task ends with a manual verification step against a live session instead of an automated test.
- Follow existing code style: 2-space indent, single quotes, semicolons, trailing commas (Biome). Run `bun format` before each commit.
- Ctrl-letter mapping covers `a-z`/`A-Z` only (control code = `key.toUpperCase().charCodeAt(0) - 64`). Non-letter keys while armed just disarm without sending a control code — no stuck state.
- Shift+Tab escape sequence is `\x1b[Z` (CSI Z).

---

### Task 1: Ctrl-modifier toggle button

**Files:**
- Modify: `apps/mobile/App.tsx:160-165` (state declarations)
- Modify: `apps/mobile/App.tsx:482-487` (`handleKeyPress`)
- Modify: `apps/mobile/App.tsx:723-734` (utility bar `Ctrl+C`/`Ctrl+D` buttons)
- Modify: `apps/mobile/App.tsx:1012-1027` (utility bar styles)

**Interfaces:**
- Produces: `ctrlArmed: boolean` state and `setCtrlArmed` setter, consumed only within this task (`handleKeyPress` and the new `Ctrl` button). No other task depends on this state.

- [ ] **Step 1: Add `ctrlArmed` state**

In `App.tsx`, find this block (around line 160):

```tsx
  const [mouseOn, setMouseOn] = useState(false);
```

Add immediately after it:

```tsx
  const [mouseOn, setMouseOn] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
```

- [ ] **Step 2: Update `handleKeyPress` to consume the Ctrl modifier**

Find the existing handler:

```tsx
  const handleKeyPress = (e: { nativeEvent: { key: string } }) => {
    const key = e.nativeEvent.key;
    if (key === 'Backspace') sendInput('\x7f');
    else if (key.length === 1) sendInput(key); // printable char (incl. space)
    autoScroll.current = true;
  };
```

Replace it with:

```tsx
  const handleKeyPress = (e: { nativeEvent: { key: string } }) => {
    const key = e.nativeEvent.key;
    if (ctrlArmed) {
      setCtrlArmed(false);
      if (/^[a-zA-Z]$/.test(key)) {
        sendInput(String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64));
        autoScroll.current = true;
        return;
      }
      // Non-letter while armed: fall through and handle normally, modifier dropped.
    }
    if (key === 'Backspace') sendInput('\x7f');
    else if (key.length === 1) sendInput(key); // printable char (incl. space)
    autoScroll.current = true;
  };
```

- [ ] **Step 3: Replace the `Ctrl+C`/`Ctrl+D` buttons with a single `Ctrl` toggle**

Find this block (around line 723-734):

```tsx
              <TouchableOpacity
                style={styles.utilityBtn}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  sendInput('\x03');
                }}
              >
                <Text style={[styles.utilityBtnText, styles.utilityBtnTextDanger]}>Ctrl+C</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\t')}>
                <Text style={styles.utilityBtnText}>Tab</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x04')}>
                <Text style={styles.utilityBtnText}>Ctrl+D</Text>
              </TouchableOpacity>
```

Replace with:

```tsx
              <TouchableOpacity
                style={[styles.utilityBtn, ctrlArmed && styles.utilityBtnActive]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setCtrlArmed((v) => !v);
                }}
              >
                <Text style={[styles.utilityBtnText, ctrlArmed && styles.utilityBtnTextActive]}>
                  Ctrl
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\t')}>
                <Text style={styles.utilityBtnText}>Tab</Text>
              </TouchableOpacity>
```

(The `Ctrl+D` button is gone — `^D` is now sent via `Ctrl` then `d`. The `Tab` button's `onLongPress` for Shift+Tab is added in Task 2.)

- [ ] **Step 4: Add `utilityBtnActive`/`utilityBtnTextActive` styles**

Find this block (around line 1025):

```tsx
  utilityBtnTextDanger: {
    color: '#f87171',
  },
```

Add immediately after it:

```tsx
  utilityBtnTextDanger: {
    color: '#f87171',
  },
  utilityBtnActive: {
    backgroundColor: '#22d3ee',
  },
  utilityBtnTextActive: {
    color: '#0b0f19',
  },
```

- [ ] **Step 5: Format**

Run: `bun format`
Expected: `apps/mobile/App.tsx` reformatted in place if needed, exits 0.

- [ ] **Step 6: Manual verification**

Run: `bun dev:mobile` (from repo root), open the app on a device/simulator, connect to a session.

Verify:
1. Tap `Ctrl` — button highlights (cyan background, dark text).
2. Type `c` on the keyboard — sends `^C` (e.g. interrupts a running `sleep 100`), button un-highlights.
3. Tap `Ctrl`, type `d` — sends `^D` (e.g. exits a `cat` waiting on stdin).
4. Tap `Ctrl`, then tap Backspace — modifier drops silently, Backspace behaves normally (no control code sent, button un-highlights).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): replace Ctrl+C/Ctrl+D buttons with a Ctrl-letter modifier toggle"
```

---

### Task 2: Shift+Tab via long-press on the Tab button

**Files:**
- Modify: `apps/mobile/App.tsx` (the `Tab` button from Task 1, Step 3)

**Interfaces:**
- Consumes: the `Tab` `TouchableOpacity` produced in Task 1, Step 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add `onLongPress` to the `Tab` button**

Find (as left by Task 1):

```tsx
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\t')}>
                <Text style={styles.utilityBtnText}>Tab</Text>
              </TouchableOpacity>
```

Replace with:

```tsx
              <TouchableOpacity
                style={styles.utilityBtn}
                onPress={() => sendInput('\t')}
                onLongPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  sendInput('\x1b[Z');
                }}
              >
                <Text style={styles.utilityBtnText}>Tab</Text>
              </TouchableOpacity>
```

- [ ] **Step 2: Format**

Run: `bun format`
Expected: exits 0.

- [ ] **Step 3: Manual verification**

Run: `bun dev:mobile`, connect to a session with a program that distinguishes Tab/Shift+Tab focus order (e.g. a TUI with multiple fields, or just echo the raw bytes with `cat -v` and confirm `^[[Z` appears for long-press vs a literal tab for a quick tap).

Verify:
1. Quick tap `Tab` — sends `\t` (unchanged behavior).
2. Long-press `Tab` (~500ms) — sends `\x1b[Z`.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): long-press Tab sends Shift+Tab"
```

---

### Task 3: Fullscreen selectable-text view

**Files:**
- Modify: `apps/mobile/App.tsx:1-18` (imports)
- Modify: `apps/mobile/App.tsx:160-165` (state declarations)
- Modify: `apps/mobile/App.tsx:457-467` (`handleCopyScreen` → `openSelectionView`)
- Modify: `apps/mobile/App.tsx:681` (terminal `onLongPress`)
- Modify: `apps/mobile/App.tsx` (JSX: add the `Modal`, near the `SessionDrawer` render block around line 705)
- Modify: `apps/mobile/App.tsx` (styles: add selection-view styles near `utilityBar` styles)

**Interfaces:**
- Consumes: `screen: RenderRow[]` (existing state, already holds full scrollback + visible rows).
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Import `Modal`**

Find the `react-native` import block (top of file):

```tsx
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Pressable,
  PanResponder,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
  type TextStyle,
} from 'react-native';
```

Replace with:

```tsx
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Pressable,
  PanResponder,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
  Modal,
  type TextStyle,
} from 'react-native';
```

- [ ] **Step 2: Add `selectionViewOpen` state**

Find (as left by Task 1):

```tsx
  const [mouseOn, setMouseOn] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
```

Add immediately after it:

```tsx
  const [mouseOn, setMouseOn] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [selectionViewOpen, setSelectionViewOpen] = useState(false);
```

- [ ] **Step 3: Replace `handleCopyScreen` with `openSelectionView` + a `getFullText` helper + keep a `handleCopyAll` for the modal's Copy All button**

Find:

```tsx
  // Long-press the terminal to copy everything currently visible (screen +
  // whatever's rendered from scrollback). No text-selection UI — matches the
  // "copy this pane" gesture most mobile terminal apps use instead.
  const handleCopyScreen = async () => {
    const text = screen
      .map((r) => r.runs.map((run) => run.text).join(''))
      .join('\n')
      .replace(/\n+$/, '');
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Terminal contents copied to clipboard.');
  };
```

Replace with:

```tsx
  // Full plain-text transcript (visible screen + scrollback) for the
  // selectable view and the Copy All fallback.
  const getFullText = () =>
    screen
      .map((r) => r.runs.map((run) => run.text).join(''))
      .join('\n')
      .replace(/\n+$/, '');

  // Long-press the terminal to open a fullscreen, natively-selectable view
  // of everything currently visible + scrollback, instead of copying
  // straight to the clipboard.
  const openSelectionView = () => {
    if (!getFullText()) return;
    setSelectionViewOpen(true);
  };

  const handleCopyAll = async () => {
    const text = getFullText();
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Terminal contents copied to clipboard.');
  };
```

- [ ] **Step 4: Wire the terminal's long-press to `openSelectionView`**

Find (around line 681):

```tsx
              onLongPress={handleCopyScreen}
```

Replace with:

```tsx
              onLongPress={openSelectionView}
```

- [ ] **Step 5: Add the selection Modal to the JSX**

Find the `SessionDrawer` render block:

```tsx
          {/* Session Drawer (overlay) */}
          <SessionDrawer
            visible={drawerOpen}
            sessions={drawerSessions}
            activeId={activeId}
            onSelect={switchTo}
            onNew={newTerminal}
            onKill={killActiveOr}
            onClose={() => setDrawerOpen(false)}
            onSettings={() => { setDrawerOpen(false); setIsConfiguring(true); }}
          />
```

Add immediately after it:

```tsx
          {/* Fullscreen selectable-text view (long-press the terminal to open) */}
          <Modal
            visible={selectionViewOpen}
            animationType="slide"
            onRequestClose={() => setSelectionViewOpen(false)}
          >
            <SafeAreaView style={styles.selectionViewContainer}>
              <View style={styles.selectionViewHeader}>
                <Text style={styles.selectionViewTitle}>Select Text</Text>
                <View style={styles.selectionViewHeaderBtns}>
                  <TouchableOpacity
                    style={styles.selectionViewHeaderBtn}
                    onPress={handleCopyAll}
                    accessibilityRole="button"
                    accessibilityLabel="Copy all"
                  >
                    <Text style={styles.selectionViewHeaderBtnText}>Copy All</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.selectionViewHeaderBtn}
                    onPress={() => setSelectionViewOpen(false)}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                  >
                    <Feather name="x" size={20} color="#cbd5e1" />
                  </TouchableOpacity>
                </View>
              </View>
              {selectionViewOpen && (
                <TextInput
                  style={styles.selectionViewText}
                  value={getFullText()}
                  editable={false}
                  multiline
                  scrollEnabled
                  selection={{ start: getFullText().length, end: getFullText().length }}
                />
              )}
            </SafeAreaView>
          </Modal>
```

(`{selectionViewOpen && (...)}` mounts the `TextInput` fresh each time the modal opens, so the `selection` prop's scroll-to-end trick re-fires on every open rather than only once.)

- [ ] **Step 6: Add selection-view styles**

Find the `utilityIconBtn` style (added context, near the styles from Task 1):

```tsx
  utilityIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
```

Add immediately after it:

```tsx
  utilityIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectionViewContainer: {
    flex: 1,
    backgroundColor: '#070a13',
  },
  selectionViewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  selectionViewTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  selectionViewHeaderBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  selectionViewHeaderBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  selectionViewHeaderBtnText: {
    color: '#22d3ee',
    fontWeight: '600',
    fontSize: 14,
  },
  selectionViewText: {
    flex: 1,
    padding: 16,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 18,
    color: '#cbd5e1',
  },
```

- [ ] **Step 7: Format**

Run: `bun format`
Expected: exits 0.

- [ ] **Step 8: Manual verification**

Run: `bun dev:mobile`, connect to a session, produce some output that scrolls past a full screen (e.g. `seq 1 200`).

Verify:
1. Long-press the terminal — fullscreen modal opens, scrolled to the bottom (most recent output visible).
2. Scroll up inside the text view — earlier output (scrollback) is present as plain text.
3. Long-press-drag over some text — native selection handles appear, system copy menu works.
4. Tap "Copy All" — clipboard gets the full transcript, confirmation alert shown.
5. Tap the close (X) — modal dismisses, terminal underneath is unaffected.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): replace copy-whole-pane gesture with fullscreen selectable text view"
```

---

## Self-Review Notes

- **Spec coverage:** Ctrl-modifier (spec §1) → Task 1. Shift+Tab (spec §1) → Task 2. Fullscreen selectable view (spec §2) → Task 3. All spec requirements have a task.
- **Placeholder scan:** No TBD/TODO; all code steps show complete code.
- **Type consistency:** `ctrlArmed`/`setCtrlArmed` (Task 1) used only within Task 1. `selectionViewOpen`/`setSelectionViewOpen`, `getFullText`, `openSelectionView`, `handleCopyAll` (Task 3) are self-contained within Task 3 and don't collide with Task 1/2 names. `screen` (pre-existing) is read-only in Task 3.
