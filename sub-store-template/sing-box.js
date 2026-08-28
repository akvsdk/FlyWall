const {
  type = 'collection',
  name,
  main,
  backup,
  land,
  mainUrl,
  backupUrl,
  landUrl,
  includeUnsupportedProxy,
} = $arguments

log('start')
const parser = typeof ProxyUtils !== 'undefined' && ProxyUtils.JSON5 ? ProxyUtils.JSON5 : JSON
const configText = typeof $content === 'string' && $content.trim() ? $content : $files[0]
const config = parser.parse(configText)
const sourceType = /^1$|col|组合/i.test(type) ? 'collection' : 'subscription'
config.outbounds ??= []
config.endpoints ??= []

const existingTags = new Set([
  ...config.outbounds.map(item => item.tag),
  ...config.endpoints.map(item => item.tag),
])

const mainArtifact = await loadArtifact(main || name, mainUrl, 'MAIN', false)
const backupArtifact = await loadArtifact(backup, backupUrl, 'BACKUP', false)
const landArtifact = await loadArtifact(land, landUrl, 'LAND', true)

if (mainArtifact.nodes.length === 0) {
  throw new Error('A main collection, subscription, or URL is required')
}

const mainTags = tags(mainArtifact.nodes)
const backupTags = tags(backupArtifact.nodes)
const landTags = tags(landArtifact.nodes)
const landDirectTags = tags(landArtifact.nodes.filter(node => node.type !== 'shadowsocks'))
const landSsTags = tags(landArtifact.nodes.filter(node => node.type === 'shadowsocks'))
const regularNodes = [...mainArtifact.nodes, ...backupArtifact.nodes]

const regionRules = {
  hk: /港|hk|hongkong|hong kong|🇭🇰/i,
  tw: /台|tw|taiwan|🇹🇼/i,
  jp: /日本|jp|japan|🇯🇵/i,
  sg: /^(?!.*(?:us)).*(新|sg|singapore|🇸🇬)/i,
  us: /美|us|unitedstates|united states|🇺🇸/i,
}

const groups = {
  '✈️ 主力手动': mainTags,
  '🟢 主力自动': mainTags,
  '🚀 备用手动': backupTags,
  '🔵 备用自动': backupTags,
  '♻️ 手动选择': [...mainTags, ...backupTags],
  '🔄 自动选择': [...mainTags, ...backupTags],
  '🏠 家宽落地': landTags,
  '🏡 家宽直连': landDirectTags,
  '🔗 SS链式落地': landSsTags,
}

const matchedRegionTags = new Set()
const regionGroupNames = {
  hk: '🇭🇰 香港节点',
  tw: '✨台湾节点',
  jp: '🇯🇵 日本节点',
  sg: '🇸🇬 狮城节点',
  us: '🇺🇲 美国节点',
}
for (const [region, regex] of Object.entries(regionRules)) {
  const regionTags = tags(regularNodes.filter(node => regex.test(node.tag)))
  regionTags.forEach(tag => matchedRegionTags.add(tag))
  groups[regionGroupNames[region]] = regionTags
}
groups['🌍 其他节点'] = tags(regularNodes.filter(node => !matchedRegionTags.has(node.tag)))

for (const outbound of config.outbounds) {
  if (!Object.prototype.hasOwnProperty.call(groups, outbound.tag)) continue
  outbound.outbounds ??= []
  outbound.outbounds.push(...groups[outbound.tag])
  outbound.outbounds = [...new Set(outbound.outbounds)]
  ensureUsable(outbound)
}

for (const artifact of [mainArtifact, backupArtifact, landArtifact]) {
  config.outbounds.push(...artifact.outbounds)
  config.endpoints.push(...artifact.endpoints)
}

$content = JSON.stringify(config, null, 2)
log(`done: main=${mainTags.length}, backup=${backupTags.length}, land=${landTags.length}, land-ss=${landSsTags.length}`)

async function loadArtifact(sourceName, sourceUrl, prefix, isLanding) {
  if (!sourceName && !sourceUrl) return emptyArtifact()

  const options = {
    name: sourceName || prefix,
    type: sourceType,
    platform: 'sing-box',
    produceOpts: {
      'include-unsupported-proxy': includeUnsupportedProxy,
    },
  }
  if (sourceUrl) {
    options.subscription = {
      name: sourceName || prefix,
      url: sourceUrl,
      source: 'remote',
    }
  }

  const produced = await produceArtifact(options)
  const parsed = normalizeArtifact(produced)
  parsed.outbounds = parsed.outbounds.map(node => normalizeNode(node, prefix, isLanding))
  parsed.endpoints = parsed.endpoints.map(node => normalizeNode(node, prefix, false))
  parsed.nodes = [...parsed.outbounds, ...parsed.endpoints]
  log(`${prefix}: outbounds=${parsed.outbounds.length}, endpoints=${parsed.endpoints.length}`)
  return parsed
}

function normalizeArtifact(produced) {
  if (Array.isArray(produced)) return { outbounds: produced, endpoints: [], nodes: [] }
  const parsed = typeof produced === 'string' ? JSON.parse(produced) : produced
  return {
    outbounds: Array.isArray(parsed?.outbounds) ? parsed.outbounds : [],
    endpoints: Array.isArray(parsed?.endpoints) ? parsed.endpoints : [],
    nodes: [],
  }
}

function normalizeNode(node, prefix, isLanding) {
  const copy = { ...node }
  copy.tag = uniqueTag(`${prefix}/${copy.tag}`)

  // Standard sing-box dialer field; no provider/reF1nd extension is used.
  if (isLanding && copy.type === 'shadowsocks') copy.detour = '🔗 链式前置'
  else delete copy.detour
  return copy
}

function uniqueTag(preferred) {
  let candidate = preferred
  let suffix = 2
  while (existingTags.has(candidate)) candidate = `${preferred} #${suffix++}`
  existingTags.add(candidate)
  return candidate
}

function tags(nodes) {
  return nodes.map(node => node.tag)
}

function ensureUsable(outbound) {
  if (outbound.outbounds.length === 0) outbound.outbounds.push('direct')
}

function emptyArtifact() {
  return { outbounds: [], endpoints: [], nodes: [] }
}

function log(message) {
  console.log(`[standard sing-box template] ${message}`)
}
