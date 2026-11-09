const AUDIT_USER_WRAPPER = /^(?:unshare --net -- )?setpriv .*? env -C \S+ (?:\w+=\S* )*/;

/** Reduces a command built for the audit user to the program it runs, so a stub can match on that program. */
export function plainCommand(command: string): string {
  const inner = command.replace(AUDIT_USER_WRAPPER, '');
  if (inner === command) return command;
  const shellBody = /^\/bin\/bash -c '(.*)'$/s.exec(inner)?.[1];
  if (shellBody !== undefined) return shellBody.replaceAll("'\\''", "'");
  return inner.replace(/^\/usr\/bin\/which /, 'which ').replace(/^\/usr\/local\/bin\/anc\b/, 'anc');
}
