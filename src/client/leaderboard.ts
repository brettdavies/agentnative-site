// Leaderboard — client-side filtering (tier + audience) and column sorting.
//
// Markup (emitted by buildLeaderboardBody in scorecards-render.mjs):
//   <button class="tier-filter" data-tier="all|workhorse|agent|notable">
//   <input class="audience-filter__input" data-filter="agent-optimized-only">
//   <table class="leaderboard-table">
//     <th data-sort-col="rank|tool|score|principles">
//     <tr data-tier="workhorse|agent|notable"
//         data-audience="agent-optimized|mixed|human-primary|"
//         data-audit-profile="human-tui|file-traversal|posix-utility|diagnostic-only|">
//       <td class="lb-score" data-sort="-1|0..100">
//       <td class="lb-principles" data-sort="0..7">

const table = document.querySelector<HTMLTableElement>('.leaderboard-table');
if (table) {
  // ---------------------------------------------------------------
  // Compose tier + audience filters: a row is visible only if both pass.
  // Tier defaults to "all"; audience-only toggle defaults to off.
  // ---------------------------------------------------------------
  const tierButtons = document.querySelectorAll<HTMLButtonElement>('.tier-filter');
  const audienceToggle = document.querySelector<HTMLInputElement>('.audience-filter__input');
  const rows = table.querySelectorAll<HTMLTableRowElement>('tbody tr');

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

  // ---------------------------------------------------------------
  // Column sorting
  // ---------------------------------------------------------------
  const headers = table.querySelectorAll<HTMLTableCellElement>('th[data-sort-col]');
  let currentSort = '';
  let ascending = false;

  for (const th of headers) {
    th.addEventListener('click', () => {
      const col = th.dataset.sortCol;
      if (!col) return; // selector requires data-sort-col, but narrow for the type checker
      if (currentSort === col) {
        ascending = !ascending;
      } else {
        currentSort = col;
        ascending = col === 'tool'; // tool sorts A-Z by default, others descending
      }

      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      const sorted = [...tbody.querySelectorAll<HTMLTableRowElement>('tr')];

      sorted.sort((a, b) => {
        const va = getCellValue(a, col);
        const vb = getCellValue(b, col);
        if (typeof va === 'number' && typeof vb === 'number') {
          return ascending ? va - vb : vb - va;
        }
        const sa = String(va);
        const sb = String(vb);
        return ascending ? sa.localeCompare(sb) : sb.localeCompare(sa);
      });

      for (const row of sorted) tbody.appendChild(row);

      renumberVisibleRanks(sorted);

      // Visual indicator on sorted header
      for (const h of headers) h.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
    });
  }
}

// Agent-optimized rows have audience === "agent-optimized" AND no audit_profile.
// A profile being applied means the tool was scored as a category exception,
// which the H6 spec excludes from the agent-optimized cohort.
function isAgentOptimized(row: HTMLTableRowElement): boolean {
  return row.dataset.audience === 'agent-optimized' && !row.dataset.auditProfile;
}

function renumberVisibleRanks(rows: ArrayLike<HTMLTableRowElement>): void {
  let rank = 1;
  for (const row of Array.from(rows)) {
    if (row.hidden) continue;
    const rankCell = row.querySelector('.lb-rank');
    if (rankCell) rankCell.textContent = String(rank);
    rank += 1;
  }
}

function getCellValue(row: HTMLTableRowElement, col: string): string | number {
  switch (col) {
    case 'rank': {
      const cell = row.querySelector('.lb-rank');
      return cell ? Number(cell.textContent) : 0;
    }
    case 'tool': {
      const cell = row.querySelector('.lb-tool');
      return cell?.textContent?.trim() ?? '';
    }
    case 'score': {
      const cell = row.querySelector<HTMLElement>('.lb-score');
      return cell ? Number(cell.dataset.sort ?? -1) : -1;
    }
    case 'principles': {
      const cell = row.querySelector<HTMLElement>('.lb-principles');
      return cell ? Number(cell.dataset.sort ?? 0) : 0;
    }
    default:
      return '';
  }
}
