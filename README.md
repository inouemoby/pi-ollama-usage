# pi-ollama-usage

Ollama Cloud 用量监控插件 for [pi coding agent](https://github.com/earendil-works/pi-mono)。

在 pi 底部状态栏实时显示 Ollama Cloud 的 5 小时配额和周配额用量，并提供 `/ollama` 命令和 `ollama_usage` 工具供 LLM 调用。

## 功能

- **底部栏实时显示**：接管 pi 的 footer，显示 token 统计 + `5h:xx% Wk:xx%` 用量，颜色随消耗速度自动变化
- **`/ollama` 命令**：查看详细的 5h/周配额条形图 + 重置倒计时
- **`ollama_usage` 工具**：LLM 可主动调用，在做大操作前检查剩余配额
- **自动激活**：仅在使用 ollama-cloud provider 模型时接管 footer，不影响其他 provider

## 安装

### 方式 1：git 安装（推荐）

在 `~/.pi/agent/settings.json` 中添加：

```json
{
  "packages": ["git:github.com/inouemoby/pi-ollama-usage@main"]
}
```

然后重启 pi。

### 方式 2：本地安装

```bash
# 放到全局扩展目录
mkdir -p ~/.pi/agent/extensions/ollama-usage
cp index.ts package.json ~/.pi/agent/extensions/ollama-usage/
```

## 登录

插件加载后，在 pi 中运行：

```
/ollama-login
```

按提示输入 Ollama Cloud 的 `aid` 和 `__Secure-session` cookie 值。

或者通过环境变量：

```bash
export OLLAMA_CLOUD_SESSION="aid=xxx; __Secure-session=xxx"
```

获取 cookie：浏览器打开 [ollama.com](https://ollama.com)，登录后从 DevTools → Application → Cookies 中复制对应值。

## 命令

| 命令 | 说明 |
|------|------|
| `/ollama` | 显示详细用量（条形图 + 百分比 + 重置倒计时） |
| `/ollama-login` | 设置 cookies（交互式或命令行参数） |
| `/ollama-logout` | 清除已保存的 cookies |

## 效果预览

```
~/project (main) • my-session
↑303k ↓3.1k 3.8%/1.0M (auto) 5h:18.7% Wk:3.3%   (ollama-cloud) deepseek-v4-pro • medium
```

- 绿色百分比 = 用量正常
- 黄色 = 用量偏高
- 红色 = 消耗过快，注意配额

## License

MIT
