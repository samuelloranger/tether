import { Keyboard, TextInput } from 'react-native';
import { AlertModal } from './AlertModal';
import { ContextMenu } from './ContextMenu';
import { OverflowMenu } from './OverflowMenu';
import { isDesktop } from './platform';
import { SelectionView } from './SelectionView';
import { AppearanceModal, RenameModal, SnippetsModal } from './SessionModals';
import type { TerminalStyles, TetherApp } from './terminalScreenTypes';
import { UpdateModal } from './UpdateModal';
import { UtilityBar } from './UtilityBar';

export function TerminalOverflowMenu({ app }: { app: TetherApp }) {
  const {
    menuOpen,
    setMenuOpen,
    openRename,
    openDiff,
    fontSize,
    changeFontSize,
    mouseEnabled,
    toggleMouseEnabled,
    openSelectionView,
    jumpPrompt,
    setSnippetsModalOpen,
    setAppearanceModalOpen,
    notificationsEnabled,
    toggleNotificationsEnabled,
    testNotification,
    checkForUpdatesManual,
    hardResetSession,
  } = app;
  return (
    <OverflowMenu
      visible={menuOpen}
      onClose={() => setMenuOpen(false)}
      onRename={openRename}
      onViewChanges={() => {
        setMenuOpen(false);
        void openDiff();
      }}
      fontSize={fontSize}
      onFontDelta={changeFontSize}
      mouseEnabled={mouseEnabled}
      onToggleMouse={toggleMouseEnabled}
      onSelectText={openSelectionView}
      onJumpPromptUp={() => jumpPrompt(-1)}
      onJumpPromptDown={() => jumpPrompt(1)}
      onSnippets={() => {
        setMenuOpen(false);
        setSnippetsModalOpen(true);
      }}
      onAppearance={() => {
        setMenuOpen(false);
        setAppearanceModalOpen(true);
      }}
      notificationsEnabled={notificationsEnabled}
      onToggleNotifications={toggleNotificationsEnabled}
      onTestNotification={() => {
        setMenuOpen(false);
        testNotification();
      }}
      onCheckUpdates={() => {
        setMenuOpen(false);
        void checkForUpdatesManual();
      }}
      onRestart={() => {
        setMenuOpen(false);
        hardResetSession();
      }}
    />
  );
}

export function TerminalSessionModals({ app }: { app: TetherApp }) {
  return (
    <>
      <RenameModal
        visible={app.renameModalOpen}
        onClose={() => app.setRenameModalOpen(false)}
        value={app.renameText}
        onChangeText={app.setRenameText}
        placeholder={app.activeId}
        onSubmit={app.submitRename}
      />
      <SnippetsModal
        visible={app.snippetsModalOpen}
        onClose={() => app.setSnippetsModalOpen(false)}
        snippets={app.snippets}
        onSend={app.sendSnippet}
        onRemove={app.removeSnippet}
        draft={app.snippetDraft}
        onDraftChange={app.setSnippetDraft}
        onAdd={app.addSnippet}
      />
      <AppearanceModal
        visible={app.appearanceModalOpen}
        onClose={() => app.setAppearanceModalOpen(false)}
        fontFamily={app.fontFamily}
        onFontChange={app.changeFontFamily}
      />
    </>
  );
}

export function TerminalSelectionAndKeys({
  app,
  styles,
  desktopUi,
}: {
  app: TetherApp;
  styles: TerminalStyles;
  desktopUi: boolean;
}) {
  return (
    <>
      <SelectionView
        visible={app.selectionViewOpen}
        onClose={() => {
          app.setSelectionViewOpen(false);
          app.setSearchQuery('');
        }}
        searchQuery={app.searchQuery}
        onSearchChange={app.setSearchQuery}
        searchInputRef={app.searchInputRef}
        text={app.searchText}
        insets={app.insets}
        fontFamily={app.fontFamily}
        fontSize={app.fontSize}
        lineHeight={app.lineHeight}
      />
      {!desktopUi && (
        <UtilityBar
          ctrlArmed={app.ctrlArmed}
          setCtrlArmed={app.setCtrlArmed}
          sendKey={app.sendKey}
          cursorSeq={app.cursorSeq}
          page={app.utilityPage}
          setPage={app.setUtilityPage}
          onPaste={app.handlePaste}
          onImagePick={app.pickAndUploadImage}
          onHideKeyboard={() => {
            app.terminalViewRef.current?.blur();
            app.inputRef.current?.blur();
            Keyboard.dismiss();
          }}
        />
      )}
      {isDesktop && (
        <TextInput
          ref={app.inputRef}
          style={styles.hiddenInput}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          accessibilityLabel="Terminal IME composition target (hidden)"
        />
      )}
    </>
  );
}

export function TerminalDesktopChrome({ app }: { app: TetherApp }) {
  if (!isDesktop) return null;
  return (
    <>
      <ContextMenu
        menu={app.ctxMenu}
        onClose={() => app.setCtxMenu(null)}
        onCopy={() => void app.copySelection()}
        onPaste={() => void app.handlePaste()}
        onSelectAll={app.selectAllTerminal}
      />
      <UpdateModal
        info={app.updateInfo}
        updating={app.updating}
        pct={app.upPct}
        label={app.upLabel}
        onDismiss={app.dismissUpdate}
        onUpdate={app.startUpdate}
        onDownload={app.downloadUpdate}
      />
      <AlertModal />
    </>
  );
}
