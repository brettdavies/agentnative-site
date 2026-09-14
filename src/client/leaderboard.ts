// Leaderboard — client-side filtering (tier + audience) over the CLI board.
//
// Markup (emitted by buildLeaderboardBody in scorecards-render.mjs):
//   <button class="tier-filter" data-tier="all|workhorse|agent|notable">
//   <input class="audience-filter__input" data-filter="agent-optimized-only">
//   <div class="board" data-s="cli">
//     <a class="lrow" data-tier="workhorse|agent|notable"
//        data-audience="agent-optimized|mixed|human-primary|"
//        data-audit-profile="human-tui|file-traversal|posix-utility|diagnostic-only|">
//       <span class="rank">01</span>
//
// The controls sit above the board rather than inside it, so they are found
// on the document and the board is only needed for the rows themselves.

const board = document.querySelector<HTMLElement>('.board[data-s="cli"]');
if (board) {
  // ---------------------------------------------------------------
  // Compose tier + audience filters: a row is visible only if both pass.
  // Tier defaults to "all"; audience-only toggle defaults to off.
  // ---------------------------------------------------------------
  // Scoped to the CLI controls: the website pane's view switch reuses
  // .tier-filter on anchors, so a document-wide selector binds this handler to
  // them too, clearing the active tier and renumbering rows behind a pane the
  // reader is not even looking at.
  const tierButtons = document.querySelectorAll<HTMLButtonElement>('.leaderboard-controls[data-s="cli"] .tier-filter');
  const audienceToggle = document.querySelector<HTMLInputElement>('.audience-filter__input');
  const rows = board.querySelectorAll<HTMLElement>('.lrow');

  let activeTier = 'all';
  let agentOptimizedOnly = false;

  function applyFilters() {
    for (const row of rows) {
      const tierMatch = activeTier === 'all' || row.dataset.tier === activeTier;
      const audienceMatch = !agentOptimizedOnly || isAgentOptimized(row);
      row.hidden = !(tierMatch && audienceMatch);
    }
    renumberVisibleRanks(rows);
  }

  for (const btn of tierButtons) {
    btn.addEventListener('click', () => {
      activeTier = btn.dataset.tier ?? 'all';
      for (const f of tierButtons) f.classList.remove('tier-filter--active');
      btn.classList.add('tier-filter--active');
      applyFilters();
    });
  }

  if (audienceToggle) {
    audienceToggle.addEventListener('change', () => {
      agentOptimizedOnly = audienceToggle.checked;
      applyFilters();
    });
  }
}

// Agent-optimized rows have audience === "agent-optimized" AND no audit_profile.
// A profile being applied means the tool was scored as a category exception,
// which the H6 spec excludes from the agent-optimized cohort.
function isAgentOptimized(row: HTMLElement): boolean {
  return row.dataset.audience === 'agent-optimized' && !row.dataset.auditProfile;
}

// Ranks are the board's own numbering, not the corpus position: a filtered
// board reads 01, 02, 03 rather than the gaps its hidden rows would leave.
function renumberVisibleRanks(rows: ArrayLike<HTMLElement>): void {
  let rank = 1;
  for (const row of Array.from(rows)) {
    if (row.hidden) continue;
    const rankEl = row.querySelector('.rank');
    if (rankEl) rankEl.textContent = String(rank).padStart(2, '0');
    rank += 1;
  }
}

export {};
