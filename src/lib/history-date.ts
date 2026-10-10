export function historyLocale(locale: string): string {
  return locale === 'zh' ? 'zh-CN' : 'en-US'
}

export function formatCompactHistoryDate(timestamp: number): string {
  const date = new Date(timestamp)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

export function formatHistoryDate(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(historyLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}
