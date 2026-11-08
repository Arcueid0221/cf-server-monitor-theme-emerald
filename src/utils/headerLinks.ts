/** 页头右上角的站点链接，来自主题设置 `headerLinks` */
export interface HeaderLink {
  label: string
  url: string
}

const ENTRY_SEPARATOR_REGEX = /[;\n；]+/
const MAX_LINKS = 5

/**
 * 解析 `名称=网址; 名称=网址`（分号或换行隔开）。只接受 http/https 网址，其余条目忽略。
 * 例：`SIM 卡=https://sim.example.com`
 */
export function parseHeaderLinks(value: unknown): HeaderLink[] {
  if (typeof value !== 'string')
    return []
  const links: HeaderLink[] = []
  for (const entry of value.split(ENTRY_SEPARATOR_REGEX)) {
    const index = entry.indexOf('=')
    if (index <= 0)
      continue
    const label = entry.slice(0, index).trim()
    const raw = entry.slice(index + 1).trim()
    let url: URL
    try {
      url = new URL(raw)
    }
    catch {
      continue
    }
    if (!label || (url.protocol !== 'https:' && url.protocol !== 'http:'))
      continue
    links.push({ label: label.slice(0, 20), url: url.href })
    if (links.length >= MAX_LINKS)
      break
  }
  return links
}
