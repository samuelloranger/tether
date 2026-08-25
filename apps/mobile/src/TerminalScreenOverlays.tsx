import { Keyboard, TextInput } from 'react-native';
import { AlertModal } from './AlertModal';
import { ContextMenu } from './ContextMenu';
import { OverflowMenu } from './OverflowMenu';
import { isDesktop } from './platform';
import { SelectionView } from './SelectionView';
import { AppearanceModal, RenameModal, SnippetsModal } from './SessionModals';
import type { TerminalStyles } from './terminalScreenTypes';
import { useChrome, useGit, useSession, useTranscript, useUi, useUpdater } from './tether/context';
import { UpdateModal } from './UpdateModal';
import { UtilityBar } from './UtilityBar';

export function TerminalOverflowMenu() {
  const chrome = useChrome();
  const { menuOpen, setMenuOpen, setSnippetsModalOpen, setAppearanceModalOpen } = useUi();
  const { openRename, hardResetSession } = useSession();
  const { openDiff } = useGit();
  const { openSelectionView, jumpPrompt } = useTranscript();
  const { checkForUpdatesManual } = useUpdater();
  return (
    <OverflowMenu
      visible={menuOpen}
      onClose={() => setMenuOpen(false)}
      onRename={openRename}
      onViewChanges={() => {
        setMenuOpen(false);
        void openDiff();
      }}
      fontSize={chrome.fontSize}
      onFontDelta={chrome.changeFontSize}
      mouseEnabled={chrome.mouseEnabled}
      onToggleMouse={chrome.toggleMouseEnabled}
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
      notificationsEnabled={chrome.notificationsEnabled}
      onToggleNotifications={chrome.toggleNotificationsEnabled}
      onTestNotification={() => {
        setMenuOpen(false);
        chrome.testNotification();
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

export function TerminalSessionModals() {
  const ui = useUi();
  const session = useSession();
  const { fontFamily, changeFontFamily } = useChrome();
  return (
    <>
      <RenameModal
        visible={ui.renameModalOpen}
        onClose={() => ui.setRenameModalOpen(false)}
        value={ui.renameText}
        onChangeText={ui.setRenameText}
        placeholder={session.activeId}
        onSubmit={session.submitRename}
      />
      <SnippetsModal
        visible={ui.snippetsModalOpen}
        onClose={() => ui.setSnippetsModalOpen(false)}
        snippets={session.snippets}
        onSend={session.sendSnippet}
        onRemove={session.removeSnippet}
        draft={ui.snippetDraft}
        onDraftChange={ui.setSnippetDraft}
        onAdd={session.addSnippet}
      />
      <AppearanceModal
        visible={ui.appearanceModalOpen}
        onClose={() => ui.setAppearanceModalOpen(false)}
        fontFamily={fontFamily}
        onFontChange={changeFontFamily}
      />
    </>
  );
}

export function TerminalSelectionAndKeys({
  styles,
  desktopUi,
  docked,
}: {
  styles: TerminalStyles;
  desktopUi: boolean;
  docked: boolean;
}) {
  const chrome = useChrome();
  const ui = useUi();
  const session = useSession();
  const { searchText, handlePaste } = useTranscript();
  return (
    <>
      <SelectionView
        visible={ui.selectionViewOpen}
        onClose={() => {
          ui.setSelectionViewOpen(false);
          ui.setSearchQuery('');
        }}
        searchQuery={ui.searchQuery}
        onSearchChange={ui.setSearchQuery}
        searchInputRef={ui.searchInputRef}
        text={searchText}
        insets={chrome.insets}
        fontFamily={chrome.fontFamily}
        fontSize={chrome.fontSize}
        lineHeight={chrome.lineHeight}
      />
      {!desktopUi && (
        <UtilityBar
          ctrlArmed={session.ctrlArmed}
          setCtrlArmed={session.setCtrlArmed}
          sendKey={session.sendKey}
          cursorSeq={session.cursorSeq}
          page={ui.utilityPage}
          setPage={ui.setUtilityPage}
          docked={docked}
          onPaste={handlePaste}
          onImagePick={session.pickAndUploadImage}
          onHideKeyboard={() => {
            session.terminalViewRef.current?.blur();
            session.inputRef.current?.blur();
            Keyboard.dismiss();
          }}
        />
      )}
      {isDesktop && (
        <TextInput
          ref={session.inputRef}
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

export function TerminalDesktopChrome() {
  const { ctxMenu, setCtxMenu } = useUi();
  const { copySelection, handlePaste, selectAllTerminal } = useTranscript();
  const updater = useUpdater();
  if (!isDesktop) return null;
  return (
    <>
      <ContextMenu
        menu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onCopy={() => void copySelection()}
        onPaste={() => void handlePaste()}
        onSelectAll={selectAllTerminal}
      />
      <UpdateModal
        info={updater.updateInfo}
        updating={updater.updating}
        pct={updater.upPct}
        label={updater.upLabel}
        onDismiss={updater.dismissUpdate}
        onUpdate={updater.startUpdate}
        onDownload={updater.downloadUpdate}
      />
      <AlertModal />
    </>
  );
}
