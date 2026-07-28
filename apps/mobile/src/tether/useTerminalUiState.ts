import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';

// Screen-local state only. Persisted values and transport state stay in their
// domain hooks so opening a modal never acquires ownership of either.
export function useTerminalUiState() {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [utilityPage, setUtilityPage] = useState(0);
  const [selectionViewOpen, setSelectionViewOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [appearanceModalOpen, setAppearanceModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInput | null>(null);
  const [snippetsModalOpen, setSnippetsModalOpen] = useState(false);
  const [snippetDraft, setSnippetDraft] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);

  return {
    ctxMenu,
    setCtxMenu,
    utilityPage,
    setUtilityPage,
    selectionViewOpen,
    setSelectionViewOpen,
    menuOpen,
    setMenuOpen,
    renameModalOpen,
    setRenameModalOpen,
    renameText,
    setRenameText,
    appearanceModalOpen,
    setAppearanceModalOpen,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    snippetsModalOpen,
    setSnippetsModalOpen,
    snippetDraft,
    setSnippetDraft,
    drawerOpen,
    setDrawerOpen,
  };
}
