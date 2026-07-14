// Web leaderboard sort toggle (plan-003 U15, KTD-9). The board ships
// sorted by GLOBAL; the segmented control re-sorts by RELATIVE and back,
// persisting the selection in a `?sort=` URL param so a shared or
// reloaded board keeps the sort. Rows carry data-global / data-relative
// / data-domain from the build emit.
//
// Markup (emitted by buildWebLeaderboardBody in web-leaderboard-render.mjs):
//   <button class="tier-filter" data-web-sort="global|relative">
//   <table class="leaderboard-table"> <tr data-global data-relative data-domain>

type SortKey = 'global' | 'relative';

const table = document.querySelector<HTMLTableElement>('.leaderboard-table');
const buttons = document.querySelectorAll<HTMLButtonElement>('[data-web-sort]');

function rowValue(row: HTMLTableRowElement, key: SortKey): number {
  return Number(row.dataset[key] ?? 0);
}

function applySort(key: SortKey, updateUrl: boolean): void {
  if (!table) return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  const other: SortKey = key === 'global' ? 'relative' : 'global';
  const rows = [...tbody.querySelectorAll<HTMLTableRowElement>('tr')];
  rows.sort((a, b) => {
    const byKey = rowValue(b, key) - rowValue(a, key);
    if (byKey !== 0) return byKey;
    const byOther = rowValue(b, other) - rowValue(a, other);
    if (byOther !== 0) return byOther;
    return (a.dataset.domain ?? '').localeCompare(b.dataset.domain ?? '');
  });
  rows.forEach((row, i) => {
    tbody.appendChild(row);
    const rank = row.querySelector('.lb-rank');
    if (rank) rank.textContent = String(i + 1);
  });
  for (const btn of buttons) {
    const active = btn.dataset.webSort === key;
    btn.classList.toggle('tier-filter--active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  if (updateUrl) {
    const url = new URL(window.location.href);
    if (key === 'global') url.searchParams.delete('sort');
    else url.searchParams.set('sort', key);
    history.replaceState(null, '', url.toString());
  }
}

if (table && buttons.length > 0) {
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      applySort((btn.dataset.webSort as SortKey) ?? 'global', true);
    });
  }
  const requested = new URL(window.location.href).searchParams.get('sort');
  if (requested === 'relative') applySort('relative', false);
}
