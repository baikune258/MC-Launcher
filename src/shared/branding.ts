/**
 * 品牌与渠道常量（改这里，不要散落代码深处）。
 */

/** GitHub 仓库（自更新检查与 Release 下载来源） */
export const GITHUB_REPO = 'baikune258/MC-Launcher'

/** 备用下载群号：更新弹窗「复制群号」按钮使用；没有群时留空（按钮自动隐藏） */
export const QQ_GROUP_NUMBER = ''

/** 更新弹窗常驻提示（备用下载渠道） */
export const QQ_GROUP_HINT = '下载较慢？可以到 GitHub Releases 获取最新安装包，与版本更新一致'

/** 默认赞助主页（爱发电）；设置页可覆盖，点「赞助作者」默认跳这里 */
export const DEFAULT_SPONSOR_URL = 'https://ifdian.net/a/baikun258'

/** 赞助者鸣谢名单：格式 { name, tier }；名单由作者提供后填入，留空时展示占位文案 */
export const SPONSOR_LIST: { name: string; tier: string }[] = []
