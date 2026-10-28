/** `call`, or a rejection carrying `message` once `ms` pass first. The timer is cleared either way. */
export function withinMs<T>(call: Promise<T>, ms: number, message = `took longer than ${ms} ms`): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([call, late]).finally(() => clearTimeout(timer));
}
