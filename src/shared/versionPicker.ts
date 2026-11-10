import type { RemoteVersion } from './types'
export type VersionCategory='release'|'preview'|'snapshot'|'aprilfools'|'old'|'all'
export const versionCategories:{value:VersionCategory;label:string}[]=[{value:'release',label:'正式版'},{value:'preview',label:'预发布 / 候选'},{value:'snapshot',label:'快照'},{value:'aprilfools',label:'愚人节'},{value:'old',label:'远古版'},{value:'all',label:'全部'}]
/** 愚人节版本按官方清单的 4 月 1 日发布时间识别；当天发布的正式版不算。 */
export function isAprilFools(v:RemoteVersion){return v.type!=='release'&&/^\d{4}-04-01/.test(v.releaseTime)}
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
