import type { RemoteVersion } from './types'
export type VersionCategory='release'|'preview'|'snapshot'|'aprilfools'|'old'|'all'
export const versionCategories:{value:VersionCategory;label:string}[]=[{value:'release',label:'正式版'},{value:'preview',label:'预发布 / 候选'},{value:'snapshot',label:'快照'},{value:'aprilfools',label:'愚人节'},{value:'old',label:'远古版'},{value:'all',label:'全部'}]
/** 官方清单里的愚人节版本；1.RV-Pre1 的 UTC 发布时间是 3 月 31 日，只能按版本号认。 */
const APRIL_FOOLS_IDS=new Set(['15w14a','1.RV-Pre1','3D Shareware v1.34','20w14infinite','22w13oneblockatatime','23w13a_or_b','24w14potato','25w14craftmine','26w14a'])
/** 已知版本按版本号识别；之后新增的愚人节版本按 4 月 1 日发布时间兜底（当天发布的正式版不算）。 */
export function isAprilFools(v:RemoteVersion){return APRIL_FOOLS_IDS.has(v.id)||(v.type!=='release'&&/^\d{4}-04-01/.test(v.releaseTime))}
export function versionCategory(v:RemoteVersion):VersionCategory{
 if(isAprilFools(v))return 'aprilfools'
 if(v.type==='release')return 'release'
 if(v.type==='old_alpha'||v.type==='old_beta')return 'old'
 return /(?:[-\s](?:pre|rc)(?:[-\s]?\d|release)|pre-release|release candidate)/i.test(v.id)?'preview':'snapshot'
}
export function filterVersions(versions:RemoteVersion[],category:VersionCategory,query:string){
 const q=query.trim().toLowerCase()
 // 愚人节版本同时保留在「快照」里，单独分类只是方便直接找到。
 const match=(v:RemoteVersion)=>category==='all'||versionCategory(v)===category||(category==='snapshot'&&isAprilFools(v))
 return versions.filter(v=>match(v)&&v.id.toLowerCase().includes(q)).sort((a,b)=>Date.parse(b.releaseTime)-Date.parse(a.releaseTime))}
