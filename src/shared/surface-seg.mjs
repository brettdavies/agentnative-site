/**
 * Shared CLI | Website segment markup for board and audit Probe A surfaces.
 *
 * @param {object} opts
 * @param {string} opts.dataAttr - e.g. `data-surface-board-seg` (no leading space)
 * @param {string} opts.radioName - distinct per surface (`board-surface`, `audit-surface`)
 * @param {string} opts.cliId
 * @param {string} opts.webId
 * @param {'cli'|'web'} opts.checked
 * @param {string} opts.ariaLabel
 */
export function renderSurfaceSeg({ dataAttr, radioName, cliId, webId, checked, ariaLabel }) {
  const cliChecked = checked === 'cli' ? ' checked' : '';
  const webChecked = checked === 'web' ? ' checked' : '';
  return `<div class="seg" role="radiogroup" aria-label="${ariaLabel}" ${dataAttr}>
    <input type="radio" name="${radioName}" id="${cliId}"${cliChecked} /><label for="${cliId}">CLI</label>
    <input type="radio" name="${radioName}" id="${webId}"${webChecked} /><label for="${webId}">Website</label>
  </div>`;
}
