// boot.js — runs last: global listeners, the first poll and the refresh timer.

// Registered before the focus-clearing click listener below, as they were when this was one
// script, and only now that every drawer they close has been defined.
document.addEventListener('click', e => {
  hideCtxMenu();
  const venuePop = document.getElementById('venuePopover');
  if (venuePop && !venuePop.contains(e.target)) closeVenuePopover();
  // Close pinned hedge popup if click is outside it
  const popup = document.getElementById('hedgePopup');
  if (hedgePinned && popup && !popup.contains(e.target)) {
    hideHedgePopup(true);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeVenuePopover(); hideCtxMenu(); closeCalc('calcOverlay'); hideHedgePopup(true); closeUpnlDrawerForce(); closeExpDrawerForce(); closeFundDrawerForce(); closeLiqDrawerForce(); closeSimDrawerForce(); closeHlDrawerForce(); closeGoalDrawerForce(); cancelTripNote(); }
});

startSessionClock();
setInterval(tickCountdowns, 30_000);

const VIEWS = ['tiles', 'list', 'orders', 'stops', 'stress', 'unwind', 'journal', 'confluence'];
const savedView = loadPref('posView', 'tiles');
fetchData().then(() => { if (VIEWS.includes(savedView) && savedView !== posView) setView(savedView); });
autoRefresh = setInterval(() => { if (!document.hidden) fetchData(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchData(); });
window.addEventListener('resize', () => { if (posView === 'tiles') requestAnimationFrame(drawThreadLines); });

// Clear tile focus when clicking outside the tile grid
document.addEventListener('click', e => {
  // _applyFocus(threadKey) leaves _focusedTileId null, so guarding on it alone made a
  // focused hedge thread impossible to dismiss by clicking away.
  if (!_focusedTileId && !_focusedThreadKey) return;
  const grid = document.getElementById('ptile-grid');
  if (grid && !grid.contains(e.target)) clearTileFocus();
});
