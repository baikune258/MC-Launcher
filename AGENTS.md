# 项目默认交付流程

用户已明确授权：每批修改完成后，默认完成验证、打包，并更新到 https://github.com/baikune258/MC-Launcher ，无需再次询问是否打包或发布。

- 每批功能或修复递增版本尾号，同步 package.json、package-lock.json 根包版本、内置更新日志。更新日志日期必须采用本地时间 YYYY-MM-DD HH:mm，精确到小时和分钟。
- 版本号每百进一：尾号从 0 到 99，下一版向前一位进一并将尾号归零（例如 2.0.99 → 2.1.0）。
- 运行与改动相关的验证及构建；生成 Windows 便携 EXE，验证便携包启动和 SHA256。
- 提交项目源码并推送 main 分支。
- 在上述仓库发布对应版本的 GitHub Release，上传 EXE、SHA256SUMS.txt，并核对远端提交、标签和附件。
