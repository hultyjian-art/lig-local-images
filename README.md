# lig-local-images

本地图片图床 Luker 后端插件 (任意目录只读图床 + user/images 嵌套管理)。

## 手机端安装 (Luker APK / Termux)

1. 把本仓库推到 GitHub (或任意 git 主机), 记下仓库 URL。
2. 手机 Luker: 扩展/插件管理 -> 服务器插件 -> 从 git URL 安装, 粘贴仓库 URL。
3. 确认该 Luker 的 config.yaml 里 enableServerPlugins: true, 重启酒馆。

> 仓库根即插件本体 (index.mjs / package.json / lib/), 请勿再套一层子目录。
