# AI Tab Grouper

Chrome 扩展，通过 OpenAI 兼容 API 给当前窗口的标签页一键分组。支持读取 API 的可用模型、流式显示模型输出，以及复制排查日志。

## 安装和使用

1. 下载或克隆此仓库。
2. 在 Chrome 打开 `chrome://extensions/`，启用「开发者模式」，点击「加载未打包的扩展程序」，选择包含 `manifest.json` 的目录。
3. 打开扩展，填写 API Base URL 和 API Key。Base URL 应包含所需的版本路径（例如 `/v1`），结尾省略 `/chat/completions`。
4. 点击「刷新可用模型」，选择模型，再点击「一键智能分组」。之后打开弹窗会自动获取当前账号可用的模型。

模型列表由 `GET /models` 提供，分组使用 `POST /chat/completions`。分组请求会将未固定标签页的标题和网址发送到你配置的 API。API Key 保存在本机的 Chrome 扩展存储中。
