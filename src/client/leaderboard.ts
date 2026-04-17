// Leaderboard — client-side tier filtering and column sorting.
//
// Markup (emitted by buildLeaderboardBody in scorecards.mjs):
//   <button class="tier-filter" data-tier="all|workhorse|agent|notable">
//   <table class="leaderboard-table">
//     <th data-sort-col="rank|tool|score|principles">
//     <tr data-tier="workhorse|agent|notable">
//       <td class="lb-score" data-sort="-1|0..100">
//       <td class="lb-principles" data-sort="0..7">

const table = document.querySelector<HTMLTableElement>('.leaderboard-table');
if (table) {
  // ---------------------------------------------------------------
  // Tier filtering
  // ---------------------------------------------------------------
  const filters = document.querySelectorAll<HTMLButtonElement>('.tier-filter');
  const rows = table.querySelectorAll<HTMLTableRowElement>('tbody tr');

  for (const btn of filters) {
    btn.addEventListener('click', () => {
      const tier = btn.dataset.tier ?? 'all';
      for (const f of filters) f.classList.remove('tier-filter--active');
      btn.classList.add('tier-filter--active');

      for (const row of rows) {
        if (tier === 'all' || row.dataset.tier === tier) {
          row.hidden = false;
        } else {
          row.hidden = true;
        }
      }
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
      const col = th.dataset.sortCol!;
      if (currentSort === col) {
        ascending = !ascending;
      } else {
        currentSort = col;
        ascending = col === 'tool'; // tool sorts A-Z by default, others descending
      }

      const tbody = table.querySelector('tbody')!;
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

      // Update rank column after re-sort
      const visible = sorted.filter((r) => !r.hidden);
      for (let i = 0; i < visible.length; i++) {
        const rankCell = visible[i].querySelector('.lb-rank');
        if (rankCell) rankCell.textContent = String(i + 1);
      }

      // Visual indicator on sorted header
      for (const h of headers) h.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
    });
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
