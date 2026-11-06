/** Display instants in the device timezone; never slice UTC text as local time. */
function parsed(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
export function fmtTime(value: string | undefined): string {
  const date = parsed(value);
  return date ? `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${clock(date)}` : '';
}
export function relativeDay(value: string | undefined, now = new Date()): string {
  const date = parsed(value);
  if (!date) return '';
  const sameDay = (a: Date, b: Date) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  if (sameDay(date, now)) return '今天';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate()-1);
  if (sameDay(date, yesterday)) return '昨天';
  return `${date.getMonth()+1} 月 ${date.getDate()} 日`;
}
export function localMeta(value: string | undefined, now = new Date()): string {
  const date = parsed(value);
  return date ? `${relativeDay(value, now)} · ${clock(date)}` : '';
}
