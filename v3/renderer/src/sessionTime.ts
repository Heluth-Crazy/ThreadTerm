export function sessionTime(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const today = new Date(), yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const sameDay = (other: Date) => date.getFullYear() === other.getFullYear() && date.getMonth() === other.getMonth() && date.getDate() === other.getDate();
  const zh = locale.startsWith("zh");
  const day = sameDay(today) ? zh ? "今天" : "Today" : sameDay(yesterday) ? zh ? "昨天" : "Yesterday" : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  return `${day} ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)}`;
}
