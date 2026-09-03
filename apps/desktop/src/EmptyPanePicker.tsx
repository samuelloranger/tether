export function EmptyPanePicker({ onPick }: { onPick: () => void }) {
  return (
    <div className="empty-pane">
      <button type="button" className="empty-pane-button" onClick={onPick}>
        Choose a session…
      </button>
    </div>
  );
}
