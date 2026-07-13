import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
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
  ActivityIndicator,
  useWindowDimensions,
  Modal,
  Linking,
  AccessibilityInfo,
  type TextStyle,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Feather from '@expo/vector-icons/Feather';
import { useFonts } from '@expo-google-fonts/fira-code/useFonts';
import { FiraCode_400Regular } from '@expo-google-fonts/fira-code/400Regular';
import { TerminalEmulator, type RenderRow, type CellStyle } from './terminal';
import { splitRunByLinks, urlColumns } from './links';
import { SessionCache, nextTermId, type SessionEntry } from './sessionCache';
import { SessionDrawer, PANEL_W, type DrawerSession } from './SessionDrawer';
import { applyFieldChange, SENT } from './input';
import { getPassword, setPassword as persistPassword, authHeaders } from './secureConfig';
import { httpBase, wsUrl, validateAddress } from './address';
import { openTerminalSocket, type TerminalSocket } from './wsTransport';
import { keyToBytes, COPY, PASTE } from './desktopKeys';
import { notify, confirmAction } from './dialog';
import { fetchUpdate, installUpdate, openReleasesPage, type PendingUpdate } from './desktopUpdate';
import TitleBar from './TitleBar';
import { injectDragRegionStyles } from './dragRegion';
import { styles } from './styles';
import { isDesktop, isMacDesktop } from './platform';
import { TermRow } from './TermRow';
import { ArrowCluster } from './Dpad';
import { ConnectionBanner } from './ConnectionBanner';
import { UtilityBar } from './UtilityBar';
import { OverflowMenu } from './OverflowMenu';
import { RenameModal, SnippetsModal } from './SessionModals';
import { SelectionView } from './SelectionView';
import { ContextMenu } from './ContextMenu';
import { UpdateModal } from './UpdateModal';
import { ConfigScreen } from './ConfigScreen';
import { mouseSeq } from './mouseSeq';


// Constants for async storage keys
const KEY_SERVER_IP = 'tether_server_ip';
const KEY_PORT = 'tether_port';
const KEY_SESSION_ID = 'tether_session_id';
const KEY_FONT = 'tether_font_size';
const KEY_SNIPPETS = 'tether_snippets';


import { useTetherApp } from './useTetherApp';

export function TerminalScreen({ app }: { app: ReturnType<typeof useTetherApp> }) {
  const {
    fontsLoaded, insets, serverIp, setServerIp, port, setPort, password, setPassword, passwordRef, setupMode, setSetupMode, confirmPassword, setConfirmPassword, testStatus, setTestStatus, isConfiguring, setIsConfiguring, ready, setReady, readyRef, lastConnectedRef, connectionStatus, setConnectionStatus, hasConnectedRef, screen, setScreen, inputText, setInputText, prevValueRef, skipNextChangeRef, termHeight, setTermHeight, mouseOn, setMouseOn, ctxMenu, setCtxMenu, updateInfo, setUpdateInfo, pendingUpdate, updateProgress, setUpdateProgress, updating, setUpdating, ctrlArmed, setCtrlArmed, selectionViewOpen, setSelectionViewOpen, menuOpen, setMenuOpen, renameModalOpen, setRenameModalOpen, renameText, setRenameText, searchQuery, setSearchQuery, searchInputRef, snippets, setSnippets, snippetsModalOpen, setSnippetsModalOpen, snippetDraft, setSnippetDraft, cache, activeId, setActiveId, activeIdRef, drawerOpen, setDrawerOpen, drawerSessions, setDrawerSessions, sock, gen, open, listRef, inputRef, reconnectTimeout, autoScroll, scrolledRef, lastContentHeight, blinkOn, setBlinkOn, reduceMotion, setReduceMotion, renderScheduled, mouseOnRef, wheelAccum, lastDy, CHAR_RATIO, fontSize, setFontSize, lineHeight, paneWidth, gridWidth, numCols, numRows, entryFor, wsSend, panResponder, scheduleRender, resetTerminal, applyWsMessage, connect, disconnect, switchTo, newTerminal, killActiveOr, changeFontSize, persistSnippets, addSnippet, removeSnippet, sendSnippet, refreshSessions, testConnection, saveConfig, sendInput, cursorSeq, getFullText, searchText, openSearch, openSelectionView, handleCopyAll, copySelection, selectAllTerminal, handlePaste, handleKeyPress, resetField, handleChangeText, handleSend, disposePending, checkForUpdatesManual, startUpdate, downloadUpdate, dismissUpdate, activeName, upPct, upLabel, openRename, submitRename, hardResetSession, onScroll, renderRow, terminalGrid, titleBarStatus,
  } = app;
  return (
        /* Terminal Client Screen */
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.terminalContainer, isDesktop && styles.terminalRow]}
        >
          {/* Desktop: permanent sidebar of terminals in place of the overlay drawer. */}
          {isDesktop && (
            <SessionDrawer
              docked
              visible
              sessions={drawerSessions}
              activeId={activeId}
              onSelect={switchTo}
              onNew={newTerminal}
              onKill={killActiveOr}
              onClose={() => {}}
              onSettings={() => setIsConfiguring(true)}
            />
          )}

          <View style={styles.terminalMain}>
          {/* Desktop: custom window title bar (replaces the OS titlebar). */}
          {isDesktop && (
            <TitleBar
              isMac={isMacDesktop}
              title={activeName}
              subtitle={`${serverIp}:${port}`}
              status={titleBarStatus}
              onNew={newTerminal}
              onSettings={() => setIsConfiguring(true)}
              onMenu={() => setMenuOpen(true)}
            />
          )}
          {/* Mobile header panel */}
          {!isDesktop && (
          <View style={styles.header}>
            {!isDesktop && (
              <TouchableOpacity
                style={styles.headerBtn}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => { Keyboard.dismiss(); refreshSessions(); setDrawerOpen(true); }}
                accessibilityRole="button"
                accessibilityLabel="Open terminal list"
              >
                <Feather name="menu" size={20} color="#cbd5e1" />
              </TouchableOpacity>
            )}

            <View style={styles.headerInfo}>
              <Text style={styles.headerTitle}>{activeName}</Text>
              <Text style={styles.headerSubtitle}>{serverIp}:{port}</Text>
            </View>

            <View style={styles.headerControls}>
              {connectionStatus === 'connected' ? (
                <View style={[styles.statusBadge, styles.badgeConnected]}>
                  <View style={[styles.badgeDot, styles.dotConnected]} />
                  <Text style={styles.badgeTextConnected}>Connected</Text>
                </View>
              ) : connectionStatus === 'auth-failed' ? (
                <View style={[styles.statusBadge, styles.badgeOffline]}>
                  <View style={[styles.badgeDot, styles.dotOffline]} />
                  <Text style={styles.badgeTextOffline}>Auth</Text>
                </View>
              ) : connectionStatus === 'connecting' ? (
                <View style={[styles.statusBadge, styles.badgeConnecting]}>
                  <ActivityIndicator size={8} color="#fbbf24" style={styles.spinIcon} />
                  <Text style={styles.badgeTextConnecting}>Connecting…</Text>
                </View>
              ) : (
                <View style={[styles.statusBadge, styles.badgeOffline]}>
                  <View style={[styles.badgeDot, styles.dotOffline]} />
                  <Text style={styles.badgeTextOffline}>Offline</Text>
                </View>
              )}

              <TouchableOpacity
                style={styles.headerBtn}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                onPress={() => setMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Terminal menu"
              >
                <Feather name="more-vertical" size={19} color="#cbd5e1" />
              </TouchableOpacity>
            </View>
          </View>
          )}

          {/* Connection banner — names the real state; no safety overclaim. */}
          <ConnectionBanner
            status={connectionStatus}
            hasConnected={hasConnectedRef.current}
            onEdit={() => setIsConfiguring(true)}
          />

          {/* Terminal grid — vertical FlatList inside a horizontal ScrollView so
              wide (e.g. 80-col) output stays legible and scrolls sideways.
              Tapping it focuses the hidden capture field to bring up the keyboard. */}
          <View
            style={styles.terminalScroll}
            onLayout={(e) => setTermHeight(e.nativeEvent.layout.height)}
            {...panResponder.panHandlers}
          >
            {isDesktop ? (
              // Desktop: a plain, non-focusable surface. It must NOT be a Pressable:
              // react-native-web's Pressable is focusable (tabIndex 0) and consumes a
              // focused Enter as an "activate" gesture (PressResponder isValidKeyPress
              // returns true for Enter regardless of role), so Enter never reaches the
              // PTY. Keyboard is captured globally via the window keydown listener;
              // text selection is native (selectable) and actions use the right-click
              // menu — so no press handlers are needed here.
              <View nativeID="tether-terminal" style={{ flex: 1 }}>
                {terminalGrid}
              </View>
            ) : (
              <Pressable
                nativeID="tether-terminal"
                style={{ flex: 1 }}
                accessibilityRole="button"
                accessibilityLabel="Terminal. Double-tap to type, long-press to select text."
                onPressIn={() => {
                  scrolledRef.current = false;
                }}
                onPress={() => {
                  // Only a genuine tap focuses the input; a scroll-release must not
                  // pop the keyboard.
                  if (!scrolledRef.current) inputRef.current?.focus();
                }}
                onLongPress={openSelectionView}
              >
                {terminalGrid}
              </Pressable>
            )}
          </View>

          {/* Session Drawer (overlay) — mobile only; desktop uses the docked sidebar. */}
          {!isDesktop && (
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
          )}

          {/* Overflow menu (header ⋯) */}
          <OverflowMenu
            visible={menuOpen}
            onClose={() => setMenuOpen(false)}
            onRename={openRename}
            fontSize={fontSize}
            onFontDelta={changeFontSize}
            onSearch={openSearch}
            onSnippets={() => {
              setMenuOpen(false);
              setSnippetsModalOpen(true);
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

          {/* Rename Modal */}
          <RenameModal
            visible={renameModalOpen}
            onClose={() => setRenameModalOpen(false)}
            value={renameText}
            onChangeText={setRenameText}
            placeholder={activeId}
            onSubmit={submitRename}
          />

          {/* Snippets Modal */}
          <SnippetsModal
            visible={snippetsModalOpen}
            onClose={() => setSnippetsModalOpen(false)}
            snippets={snippets}
            onSend={sendSnippet}
            onRemove={removeSnippet}
            draft={snippetDraft}
            onDraftChange={setSnippetDraft}
            onAdd={addSnippet}
          />

          {/* Fullscreen selectable-text view (long-press the terminal to open) */}
          <SelectionView
            visible={selectionViewOpen}
            onClose={() => {
              setSelectionViewOpen(false);
              setSearchQuery('');
            }}
            onCopy={handleCopyAll}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchInputRef={searchInputRef}
            text={searchText}
          />

          {/* Mobile Terminal Shortcuts Utility Bar — desktop uses the real keyboard. */}
          {!isDesktop && (
            <UtilityBar
              ctrlArmed={ctrlArmed}
              setCtrlArmed={setCtrlArmed}
              sendInput={sendInput}
              cursorSeq={cursorSeq}
              onPaste={handlePaste}
            />
          )}

          {/* Hidden keyboard-capture field (mobile): tapping the terminal focuses
              it, so typing goes straight into the terminal (the shell echoes it
              back). Desktop reads the physical keyboard globally instead. */}
          {!isDesktop && (
            <TextInput
              ref={inputRef}
              style={styles.hiddenInput}
              value={inputText}
              onKeyPress={handleKeyPress}
              onChangeText={handleChangeText}
              onSubmitEditing={handleSend}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              blurOnSubmit={false}
              keyboardAppearance="dark"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              accessibilityLabel="Terminal input (hidden)"
            />
          )}
          </View>

          {/* Desktop right-click menu */}
          {isDesktop && (
            <ContextMenu
              menu={ctxMenu}
              onClose={() => setCtxMenu(null)}
              onCopy={() => void copySelection()}
              onPaste={() => void handlePaste()}
              onSelectAll={selectAllTerminal}
            />
          )}

          {/* Desktop self-update modal */}
          {isDesktop && (
            <UpdateModal
              info={updateInfo}
              updating={updating}
              pct={upPct}
              label={upLabel}
              onDismiss={dismissUpdate}
              onUpdate={startUpdate}
              onDownload={downloadUpdate}
            />
          )}
        </KeyboardAvoidingView>
  );
}
